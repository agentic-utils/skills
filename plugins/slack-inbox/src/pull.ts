// Relay mode, on the user's machine: the key pair, opening what the relay sealed, and pulling its queue.
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, sign } from 'node:crypto'
import { closeSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { pullMessage, SEAL_INFO } from '../relay/handler'
import type { EventsApiPayload } from './match'

export type RelayKeys = { seal: { d: string; x: string }; sign: { d: string; x: string } }

const jwkOf = (crv: string, k: { d: string; x: string }) => createPrivateKey({ key: { kty: 'OKP', crv, d: k.d, x: k.x }, format: 'jwk' })
const toB64 = (b64url: string) => Buffer.from(b64url, 'base64url').toString('base64')

export function generateRelayKeys(): RelayKeys {
  const pair = (t: 'x25519' | 'ed25519') => {
    const jwk = generateKeyPairSync(t as 'x25519').privateKey.export({ format: 'jwk' })
    return { d: jwk.d!, x: jwk.x! }
  }
  return { seal: pair('x25519'), sign: pair('ed25519') }
}

// Base64 raw public keys, as the relay's settings want them.
export const publicKeys = (k: RelayKeys) => ({ seal: toB64(k.seal.x), verify: toB64(k.sign.x) })

export function openSealed(k: RelayKeys, sealed: string): string {
  const raw = Buffer.from(sealed, 'base64')
  if (raw.length < 32 + 12 + 16) throw new Error('sealed event too short')
  const ephPub = raw.subarray(0, 32)
  const iv = raw.subarray(32, 44)
  const body = raw.subarray(44)
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: ephPub.toString('base64url') }, format: 'jwk' })
  const shared = diffieHellman({ privateKey: jwkOf('X25519', k.seal), publicKey: peer })
  const salt = Buffer.concat([ephPub, Buffer.from(k.seal.x, 'base64url')])
  const key = Buffer.from(hkdfSync('sha256', shared, salt, SEAL_INFO, 32))
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(body.subarray(body.length - 16))
  return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString('utf8')
}

export function signPull(k: RelayKeys, time: string, after: string): string {
  return sign(null, Buffer.from(pullMessage(time, after)), jwkOf('Ed25519', k.sign)).toString('base64')
}

export type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

export type PullerDeps = {
  url: string
  keys: RelayKeys
  cursorFile: string
  handle: (p: EventsApiPayload) => Promise<void>
  log: (msg: string) => void
  fetch?: Fetch
  now?: () => number
}

const FAILURES_BEFORE_OUTAGE = 3

// Replaced whole, as a crash during an ordinary write could leave it empty, which reads as "start from the beginning".
function saveCursor(path: string, value: number) {
  const fd = openSync(`${path}.tmp`, 'w', 0o600)
  try {
    writeSync(fd, String(value))
  } finally {
    closeSync(fd)
  }
  renameSync(`${path}.tmp`, path)
}

const readCursor = (path: string) => {
  try {
    const n = Number(readFileSync(path, 'utf8'))
    return Number.isSafeInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

// `lost`: how many events the relay dropped before they were pulled, seen as a jump in its ids.
// `skipped`: how many it held that could never be opened or handled.
export type PullResult = { handled: number; failures: number; lost: number; skipped: number; error?: string }

// A failure that says nothing about the event (a full disk, Slack unavailable), so the event must wait rather than go.
const retryable = (err: unknown) => {
  const e = err as { retry?: boolean; code?: unknown }
  return e.retry === true || (typeof e.code === 'string' && /^E[A-Z]+$/.test(e.code))
}

// Reads the queue from a cursor kept on disk, so a restart resumes where it stopped. Delivery is at least once: a
// crash between handling an event and saving the cursor repeats that one event. An event that can never be opened or
// handled is skipped and counted, or one bad row would block the queue for good. A retryable failure stops the pull
// with the cursor where it is, so that event is tried again next time.
export function createPuller(d: PullerDeps) {
  const doFetch = d.fetch ?? (fetch as unknown as Fetch)
  const now = d.now ?? Date.now
  let after = readCursor(d.cursorFile)
  let failures = 0

  return {
    outage: () => failures >= FAILURES_BEFORE_OUTAGE,
    // Proves the relay accepts this key, without reading the queue: nothing is newer than the largest possible id
    async ping(): Promise<void> {
      const time = String(Math.floor(now() / 1000))
      const q = String(Number.MAX_SAFE_INTEGER)
      const res = await doFetch(`${d.url.replace(/\/$/, '')}/pull?after=${q}`, {
        headers: { 'x-relay-time': time, 'x-relay-signature': signPull(d.keys, time, q) },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`relay answered ${res.status}`)
    },
    async pull(): Promise<PullResult> {
      let handled = 0
      let lost = 0
      let skipped = 0
      try {
        for (;;) {
          const time = String(Math.floor(now() / 1000))
          const q = String(after)
          const res = await doFetch(`${d.url.replace(/\/$/, '')}/pull?after=${q}`, {
            headers: { 'x-relay-time': time, 'x-relay-signature': signPull(d.keys, time, q) },
            signal: AbortSignal.timeout(20_000),
          })
          if (!res.ok) throw new Error(`relay answered ${res.status}`)
          const { events } = (await res.json()) as { events: { id: number; sealed: string }[] }
          for (const e of events) {
            try {
              await d.handle(JSON.parse(openSealed(d.keys, e.sealed)))
            } catch (err) {
              if (retryable(err)) throw err
              d.log(`relay event ${e.id} skipped: ${(err as Error).message}`)
              skipped++
            }
            if (e.id > after + 1) lost += e.id - after - 1
            after = e.id
            saveCursor(d.cursorFile, after)
            handled++
          }
          if (events.length === 0) break
        }
        failures = 0
        return { handled, failures, lost, skipped }
      } catch (err) {
        failures++
        return { handled, failures, lost, skipped, error: (err as Error).message }
      }
    },
  }
}
