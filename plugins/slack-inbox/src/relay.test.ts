import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createCipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, verify as edVerify } from 'node:crypto'
import { createRelay, MAX_AGE_MS, MAX_QUEUE_BYTES, type Queued, ROW_OVERHEAD_BYTES, rowsToEvict, SEAL_INFO, type Store, trim } from '../relay/handler'
import { createPuller, type Fetch, generateRelayKeys, openSealed, publicKeys, signPull } from './pull'

const NOW = 1_800_000_000_000
const SECRET = 'signing-secret'
const keys = generateRelayKeys()
const pubs = publicKeys(keys)

// The same bytes as the Worker's Web Crypto seal, which Bun can't run. relay/e2e.ts exercises the real one in workerd.
async function nodeSeal(recipient: string, plaintext: string) {
  const pub = Buffer.from(recipient, 'base64')
  const eph = generateKeyPairSync('x25519')
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub.toString('base64url') }, format: 'jwk' })
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: eph.privateKey, publicKey: peer }), Buffer.concat([ephPub, pub]), SEAL_INFO, 32))
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return Buffer.concat([ephPub, iv, ct, c.getAuthTag()]).toString('base64')
}

async function nodeVerify(publicKey: string, message: string, signature: string) {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') }, format: 'jwk' })
  return edVerify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'))
}

function memStore() {
  let rows: (Queued & { eventId: string; expiresAt: number })[] = []
  let seq = 0
  const store: Store = {
    async put(eventId, sealed, expiresAt) {
      if (!rows.some(r => r.eventId === eventId)) rows.push({ id: ++seq, eventId, sealed, expiresAt })
    },
    async list(after, limit) {
      return rows.filter(r => r.id > after).slice(0, limit).map(({ id, sealed }) => ({ id, sealed }))
    },
  }
  return { get rows() { return rows }, store }
}

const setup = (store: Store, over: Partial<Parameters<typeof createRelay>[0]> = {}) =>
  createRelay({ signingSecret: SECRET, sealKey: pubs.seal, verifyKey: pubs.verify, ownerUserId: 'UME', store, now: () => NOW, seal: nodeSeal, verifyPull: nodeVerify, ...over })

const post = (payload: unknown, opts: { secret?: string; time?: number } = {}) => {
  const body = JSON.stringify(payload)
  const time = String(opts.time ?? NOW / 1000)
  const sig = `v0=${createHmac('sha256', opts.secret ?? SECRET).update(`v0:${time}:${body}`).digest('hex')}`
  return new Request('https://relay.example/slack/events', { method: 'POST', body, headers: { 'x-slack-request-timestamp': time, 'x-slack-signature': sig } })
}

const callback = (over: Record<string, unknown> = {}) => ({
  type: 'event_callback',
  event_id: 'Ev1',
  team_id: 'T1',
  authorizations: [{ user_id: 'UME' }],
  token: 'legacy-token',
  event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UOTHER', ts: '1.000100', text: 'hello secret', blocks: [{ big: true }] },
  ...over,
})

test('sealed events open with the private key only, and hold no plaintext', async () => {
  const q = memStore()
  expect((await setup(q.store)(post(callback()))).status).toBe(200)
  expect(q.rows).toHaveLength(1)
  expect(q.rows[0].sealed).not.toContain('hello')
  expect(Buffer.from(q.rows[0].sealed, 'base64').toString('latin1')).not.toContain('hello secret')
  const opened = JSON.parse(openSealed(keys, q.rows[0].sealed))
  expect(opened.event.text).toBe('hello secret')
  expect(() => openSealed(generateRelayKeys(), q.rows[0].sealed)).toThrow()
})

test('only the fields the listener reads are stored', async () => {
  const { rows, store } = memStore()
  await setup(store)(post(callback()))
  const opened = JSON.parse(openSealed(keys, rows[0].sealed))
  expect(opened.token).toBeUndefined()
  expect(opened.authorizations).toBeUndefined()
  expect(opened.event.blocks).toBeUndefined()
  expect(trim(callback()).event).toMatchObject({ channel: 'C1', ts: '1.000100' })
})

test('nothing is evicted under the budget, and the budget is at most half of the 500 MB cap', () => {
  expect(rowsToEvict(0, 0)).toBe(0)
  expect(rowsToEvict(1000, 1000 * 720)).toBe(0)
  expect(MAX_QUEUE_BYTES).toBeLessThanOrEqual(250 * 1024 * 1024)
})

test('over budget, enough of the oldest rows go to get back under it in one pass', () => {
  const rows = 1000
  const bytes = 1000 * 850
  const max = 1000 * 500
  const evict = rowsToEvict(rows, bytes, max)
  expect(evict).toBe(500)
  const left = rows - evict
  expect(left * (bytes / rows + ROW_OVERHEAD_BYTES)).toBeLessThanOrEqual(max)
})

test('eviction never asks for more rows than exist', () => {
  expect(rowsToEvict(2, 10_000, 1)).toBe(2)
})

test('a bad signature or a stale timestamp is refused and stores nothing', async () => {
  const { rows, store } = memStore()
  expect((await setup(store)(post(callback(), { secret: 'wrong' }))).status).toBe(401)
  expect((await setup(store)(post(callback(), { time: NOW / 1000 - 301 }))).status).toBe(401)
  expect(rows).toHaveLength(0)
})

test('the url verification challenge is answered once signed', async () => {
  const res = await setup(memStore().store)(post({ type: 'url_verification', challenge: 'abc' }))
  expect(await res.json()).toEqual({ challenge: 'abc' })
})

test("another user's events are acknowledged but never stored", async () => {
  const { rows, store } = memStore()
  expect((await setup(store)(post(callback({ authorizations: [{ user_id: 'USOMEONE' }] })))).status).toBe(200)
  expect((await setup(store)(post(callback({ authorizations: undefined })))).status).toBe(200)
  expect(rows).toHaveLength(0)
})

test('a Slack retry of the same event is stored once', async () => {
  const { rows, store } = memStore()
  await setup(store)(post(callback()))
  await setup(store)(post(callback()))
  expect(rows).toHaveLength(1)
})

test('a failing store answers 503 so Slack retries', async () => {
  const store: Store = { put: async () => { throw new Error('down') }, list: async () => [] }
  expect((await setup(store)(post(callback()))).status).toBe(503)
})

const pullReq = (after: string, opts: { time?: number; k?: typeof keys } = {}) => {
  const time = String(opts.time ?? NOW / 1000)
  return new Request(`https://relay.example/pull?after=${after}`, { headers: { 'x-relay-time': time, 'x-relay-signature': signPull(opts.k ?? keys, time, after) } })
}

test('pull needs a signature from the private key, for this cursor and a recent time', async () => {
  const { store } = memStore()
  const relay = setup(store)
  expect((await relay(pullReq('0'))).status).toBe(200)
  expect((await relay(pullReq('0', { k: generateRelayKeys() }))).status).toBe(401)
  expect((await relay(pullReq('0', { time: NOW / 1000 - 301 }))).status).toBe(401)
  const time = String(NOW / 1000)
  const other = new Request('https://relay.example/pull?after=5', { headers: { 'x-relay-time': time, 'x-relay-signature': signPull(keys, time, '0') } })
  expect((await relay(other)).status).toBe(401)
})

const tmp = () => `${mkdtempSync(`${tmpdir()}/slack-inbox-pull-`)}/cursor`
const viaRelay = (relay: (r: Request) => Promise<Response>): Fetch => async (url, init) => relay(new Request(url, { headers: init.headers }))

test('the puller drains the queue in order, and a restart resumes after what it handled', async () => {
  const { store } = memStore()
  const relay = setup(store)
  for (let i = 0; i < 150; i++) await relay(post(callback({ event_id: `Ev${i}` })))
  const cursorFile = tmp()
  const seen: string[] = []
  const deps = { url: 'https://relay.example/', keys, cursorFile, log: () => {}, now: () => NOW, fetch: viaRelay(relay), handle: async (p: any) => void seen.push(p.event_id) }
  expect((await createPuller(deps).pull()).handled).toBe(150)
  expect(seen[0]).toBe('Ev0')
  expect(seen[149]).toBe('Ev149')
  expect(readFileSync(cursorFile, 'utf8')).toBe('150')
  await relay(post(callback({ event_id: 'Ev150' })))
  expect((await createPuller(deps).pull()).handled).toBe(1)
  expect(seen).toHaveLength(151)
})

test('an event that will not open is logged and skipped, and the queue keeps moving', async () => {
  const { rows, store } = memStore()
  const relay = setup(store)
  await relay(post(callback({ event_id: 'bad' })))
  await relay(post(callback({ event_id: 'good' })))
  rows[0].sealed = Buffer.alloc(80).toString('base64')
  const seen: string[] = []
  const logs: string[] = []
  const p = createPuller({ url: 'https://r.example', keys, cursorFile: tmp(), now: () => NOW, log: m => logs.push(m), fetch: viaRelay(relay), handle: async (x: any) => void seen.push(x.event_id) })
  expect(await p.pull()).toMatchObject({ handled: 2, skipped: 1 })
  expect(seen).toEqual(['good'])
  expect(logs).toHaveLength(1)
})

test('an event that fails because of the disk or Slack stays in the queue and is tried again', async () => {
  const { store } = memStore()
  const relay = setup(store)
  await relay(post(callback({ event_id: 'a' })))
  await relay(post(callback({ event_id: 'b' })))
  const f = tmp()
  const seen: string[] = []
  let failure: Error | null = Object.assign(new Error('no space left'), { code: 'ENOSPC' })
  const p = createPuller({ url: 'https://r.example', keys, cursorFile: f, now: () => NOW, log: () => {}, fetch: viaRelay(relay), handle: async (x: any) => {
    if (failure) throw failure
    seen.push(x.event_id)
  } })
  expect(await p.pull()).toMatchObject({ handled: 0, skipped: 0, failures: 1, error: 'no space left' })
  expect(seen).toEqual([])
  failure = Object.assign(new Error('slack down'), { retry: true })
  expect((await p.pull()).failures).toBe(2)
  failure = null
  expect(await p.pull()).toMatchObject({ handled: 2, skipped: 0, failures: 0 })
  expect(seen).toEqual(['a', 'b'])
  expect(readFileSync(f, 'utf8')).toBe('2')
})

test('the queue only counts as caught up after a pull reads to its end', async () => {
  const { store } = memStore()
  const relay = setup(store)
  await relay(post(callback({ event_id: 'a' })))
  let clock = NOW
  let failure: Error | null = Object.assign(new Error('slack timed out'), { retry: true })
  let duringPull: number | undefined = -1
  const p = createPuller({ url: 'https://r.example', keys, cursorFile: tmp(), now: () => clock, log: () => {}, fetch: viaRelay(relay), handle: async () => {
    duringPull = p.caughtUpAt()
    if (failure) throw failure
  } })
  expect(p.caughtUpAt()).toBeUndefined()
  await p.pull()
  expect(p.caughtUpAt()).toBeUndefined()
  failure = null
  await p.pull()
  expect(duringPull).toBeUndefined()
  expect(p.caughtUpAt()).toBe(NOW)
  // a later failure must not leave the earlier time standing, as the queue may be behind again
  await relay(post(callback({ event_id: 'b' })))
  clock = NOW + 60_000
  failure = Object.assign(new Error('slack timed out'), { retry: true })
  await p.pull()
  expect(p.caughtUpAt()).toBeUndefined()
  failure = null
  await p.pull()
  expect(p.caughtUpAt()).toBe(NOW + 60_000)
})

test('an event the handler can never deal with is skipped and counted, not retried for ever', async () => {
  const { store } = memStore()
  const relay = setup(store)
  await relay(post(callback()))
  const p = createPuller({ url: 'https://r.example', keys, cursorFile: tmp(), now: () => NOW, log: () => {}, fetch: viaRelay(relay), handle: async () => {
    throw new TypeError('malformed event')
  } })
  expect(await p.pull()).toMatchObject({ handled: 1, skipped: 1, failures: 0 })
})

test('a jump in ids is reported as lost events, once, and the cursor carries on', async () => {
  const rows = [{ id: 5, sealed: await nodeSeal(pubs.seal, JSON.stringify({ event_id: 'a' })) }, { id: 6, sealed: await nodeSeal(pubs.seal, JSON.stringify({ event_id: 'b' })) }]
  const f = tmp()
  writeFileSync(f, '2')
  let served = false
  const fetchFn: Fetch = async () => ({ ok: true, status: 200, json: async () => ({ events: served ? [] : ((served = true), rows) }) })
  const p = createPuller({ url: 'https://r.example', keys, cursorFile: f, now: () => NOW, log: () => {}, fetch: fetchFn, handle: async () => {} })
  expect(await p.pull()).toMatchObject({ handled: 2, lost: 2 })
  expect(readFileSync(f, 'utf8')).toBe('6')
  expect((await p.pull()).lost).toBe(0)
})

test('ping checks the key without reading the queue', async () => {
  const { rows, store } = memStore()
  const relay = setup(store)
  await relay(post(callback()))
  const seen: string[] = []
  const f = tmp()
  await createPuller({ url: 'https://r.example', keys, cursorFile: f, now: () => NOW, log: () => {}, fetch: async (url, init) => (seen.push(url), viaRelay(relay)(url, init)), handle: async () => { throw new Error('should not handle') } }).ping()
  expect(seen).toHaveLength(1)
  expect(seen[0]).toContain(`after=${Number.MAX_SAFE_INTEGER}`)
  expect(rows).toHaveLength(1)
  await expect(createPuller({ url: 'https://r.example', keys: generateRelayKeys(), cursorFile: f, now: () => NOW, log: () => {}, fetch: viaRelay(relay), handle: async () => {} }).ping()).rejects.toThrow('401')
})

test('three failed pulls in a row count as an outage, and one success clears it', async () => {
  let up = false
  const fetchFn: Fetch = async () => (up ? { ok: true, status: 200, json: async () => ({ events: [] }) } : { ok: false, status: 500, json: async () => ({}) })
  const p = createPuller({ url: 'https://r.example', keys, cursorFile: tmp(), now: () => NOW, log: () => {}, fetch: fetchFn, handle: async () => {} })
  await p.pull()
  await p.pull()
  expect(p.outage()).toBe(false)
  expect((await p.pull()).error).toContain('500')
  expect(p.outage()).toBe(true)
  up = true
  await p.pull()
  expect(p.outage()).toBe(false)
})

test('a damaged cursor file starts again from the beginning rather than failing', async () => {
  const f = tmp()
  writeFileSync(f, 'junk')
  const seen: string[] = []
  const { store } = memStore()
  const relay = setup(store)
  await relay(post(callback()))
  await createPuller({ url: 'https://r.example', keys, cursorFile: f, now: () => NOW, log: () => {}, fetch: viaRelay(relay), handle: async (x: any) => void seen.push(x.event_id) }).pull()
  expect(seen).toEqual(['Ev1'])
})

test('the cursor file is replaced whole, private to the user, and leaves nothing behind', async () => {
  const f = tmp()
  writeFileSync(f, '0', { mode: 0o600 })
  const before = statSync(f).ino
  const { store } = memStore()
  const relay = setup(store)
  await relay(post(callback()))
  await createPuller({ url: 'https://r.example', keys, cursorFile: f, now: () => NOW, log: () => {}, fetch: viaRelay(relay), handle: async () => {} }).pull()
  expect(readFileSync(f, 'utf8')).toBe('1')
  expect(statSync(f).ino).not.toBe(before)
  expect(statSync(f).mode & 0o077).toBe(0)
  expect(existsSync(`${f}.tmp`)).toBe(false)
})

test('an event is stored with its expiry, and collecting it leaves it there to replay', async () => {
  const q = memStore()
  const relay = setup(q.store)
  await relay(post(callback()))
  expect(q.rows[0].expiresAt).toBe(NOW + MAX_AGE_MS)
  const p = createPuller({ url: 'https://r.example', keys, cursorFile: tmp(), now: () => NOW, log: () => {}, fetch: viaRelay(relay), handle: async () => {} })
  expect((await p.pull()).handled).toBe(1)
  expect(q.rows).toHaveLength(1)
  expect((await relay(new Request('https://relay.example/ack?through=1', { method: 'POST' }))).status).toBe(404)
})
