import { expect, test } from 'bun:test'
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SEAL_INFO } from '../relay/handler'
import { type Fetch, generateRelayKeys, publicKeys } from './pull'
import { inFilter, parseWhen, replay, type ReplayFilter } from './replay'

const NOW = 1_800_000_000_000
const keys = generateRelayKeys()
const SINCE = NOW - 2 * 86_400_000

function seal(plaintext: string) {
  const pub = Buffer.from(publicKeys(keys).seal, 'base64')
  const eph = generateKeyPairSync('x25519')
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub.toString('base64url') }, format: 'jwk' })
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: eph.privateKey, publicKey: peer }), Buffer.concat([ephPub, pub]), SEAL_INFO, 32))
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return Buffer.concat([ephPub, iv, ct, c.getAuthTag()]).toString('base64')
}

const event = (id: string, atMs: number, e: Record<string, unknown>, top: Record<string, unknown> = {}) =>
  seal(JSON.stringify({ type: 'event_callback', event_id: id, team_id: 'T1', ...top, event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UOTHER', ts: `${atMs / 1000}.000100`, text: 'hello', ...e } }))

const queue = (sealed: string[], firstId = 1): Fetch => async url => {
  const after = Number(new URL(url).searchParams.get('after'))
  const events = sealed.map((s, i) => ({ id: i + firstId, sealed: s })).filter(r => r.id > after)
  return { ok: true, status: 200, json: async () => ({ events }) }
}

const run = async (sealed: string[], filter: Partial<ReplayFilter> = {}, over: Record<string, unknown> = {}) => {
  const outFile = `${mkdtempSync(`${tmpdir()}/slack-inbox-replay-test-`)}/out.jsonl`
  const result = await replay({
    url: 'https://r.example',
    keys,
    me: { userId: 'UME', teamId: 'T1' },
    teamUrl: 'https://example.slack.com/',
    allowBots: new Set(),
    groups: new Set(),
    userInThread: async () => false,
    userName: async id => `name-${id}`,
    filter: { since: SINCE, all: false, ...filter },
    outFile,
    log: () => {},
    fetch: queue(sealed),
    now: () => NOW,
    ...over,
  })
  const lines = existsSync(outFile) ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { result, lines, outFile }
}

test('times can be given as an age or a date', () => {
  expect(parseWhen('2d', NOW)).toBe(NOW - 2 * 86_400_000)
  expect(parseWhen('12h', NOW)).toBe(NOW - 12 * 3_600_000)
  expect(parseWhen('2026-11-01T00:00:00Z', NOW)).toBe(Date.parse('2026-11-01T00:00:00Z'))
  expect(() => parseWhen('soon', NOW)).toThrow("can't read the time")
})

test('the filter takes a time window and a conversation', () => {
  const p = { type: 'event_callback', event: { type: 'message', channel: 'C1', ts: `${NOW / 1000}.000100` } }
  expect(inFilter(p, { since: NOW - 1000, all: false })).toBe(true)
  expect(inFilter(p, { since: NOW + 2000, all: false })).toBe(false)
  expect(inFilter(p, { since: 0, until: NOW - 1000, all: false })).toBe(false)
  expect(inFilter(p, { since: 0, channel: 'C2', all: false })).toBe(false)
  expect(inFilter({ type: 'event_callback' }, { since: 0, all: false })).toBe(false)
})

test('by default it writes what was addressed to the user, in full, to a private file of its own', async () => {
  const long = `<@UME> ${'x'.repeat(500)}`
  const { result, lines, outFile } = await run([event('a', NOW - 1000, { text: long }), event('b', NOW - 1000, { text: 'not addressed', ts: `${(NOW - 500) / 1000}.000100` }), event('c', NOW - 3 * 86_400_000, { text: '<@UME> too old' })])
  expect(result).toMatchObject({ written: 1, skipped: 0, expired: 0 })
  expect(lines[0]).toMatchObject({ kind: 'message', trigger: 'mention', replayed: true, text: long })
  expect(statSync(outFile).mode & 0o077).toBe(0)
})

test('by default your own posts stay out', async () => {
  const { lines } = await run([event('a', NOW - 1000, { user: 'UME', text: 'my own post' })])
  expect(lines).toEqual([])
})

test('--all writes every message, leaving out Slack Connect that is not addressed to the user', async () => {
  const { lines } = await run(
    [
      event('a', NOW - 4000, { text: 'chatter' }),
      event('b', NOW - 3000, { user: 'UME', text: 'my own post' }),
      event('c', NOW - 2000, { text: 'connect chatter', user_team: 'TX' }, { is_ext_shared_channel: true }),
      event('d', NOW - 1000, { text: '<@UME> connect mention', user_team: 'TX' }, { is_ext_shared_channel: true }),
      event('e', NOW - 500, { subtype: 'message_deleted', text: undefined }),
    ],
    { all: true },
  )
  expect(lines.map(l => l.text)).toEqual(['chatter', 'my own post', '<@UME> connect mention'])
  expect(lines[0]).toMatchObject({ trigger: 'replay', author: { id: 'UOTHER', name: 'name-UOTHER' } })
  expect(lines[1].from_me).toBe(true)
  expect(lines[2].external).toBe(true)
})

test('an earlier replay file is never overwritten', async () => {
  const { outFile } = await run([])
  await expect(run([], {}, { outFile })).rejects.toThrow()
})

test('a relay it cannot read is reported, not mistaken for an empty queue', async () => {
  const { result } = await run([], {}, { fetch: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as Fetch })
  expect(result.error).toContain('500')
})
