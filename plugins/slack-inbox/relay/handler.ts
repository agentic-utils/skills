// The hosted half of relay mode: receives Slack's Events API posts, seals each event to the user's public key and
// queues the ciphertext for their machine to pull, keeping it for a while so it can be replayed. Web standards only, so it runs on Workers and under Bun tests.
// It holds no Slack token and can't read what it has stored.
import { type EventsApiPayload, passesRelay } from '../src/match'

export type Queued = { id: number; sealed: string }

export type Store = {
  // A repeated event_id (a Slack retry) is ignored, so retries are safe
  put(eventId: string, sealed: string, expiresAt: number): Promise<void>
  list(after: number, limit: number): Promise<Queued[]>
}

export type RelayConfig = {
  signingSecret: string
  sealKey: string // base64 raw X25519 public key
  verifyKey: string // base64 raw Ed25519 public key, for pull requests
  ownerUserId: string
  allowBots?: Set<string> // the listener's allow_bots: other bots are never stored
  store: Store
  maxAgeMs?: number
  now?: () => number
  // Web Crypto's X25519 and Ed25519 by default; tests under Bun, which lacks them, pass node:crypto equivalents
  seal?: typeof seal
  verifyPull?: typeof verifyPull
}

const MAX_BODY = 1024 * 1024
const CLOCK_SKEW_S = 300
const STORE_BUDGET_MS = 2500 // Slack wants an answer within 3 seconds; past this, let it retry
// How long an event is kept, collected or not: long enough to wait out a holiday and to replay recent messages, and no
// longer, as this is the user's whole Slack held elsewhere.
export const MAX_AGE_MS = 14 * 86_400_000
// Half of D1's 500 MB free limit: this counts stored bytes plus an estimate, so the real file can be larger, and a
// full database would make storing fail.
export const MAX_QUEUE_BYTES = 250 * 1024 * 1024
export const ROW_OVERHEAD_BYTES = 150 // event id, keys and indexes, on top of the sealed text
const PULL_LIMIT = 100

const enc = new TextEncoder()
export const b64 = (b: Uint8Array) => {
  let out = ''
  for (const byte of b) out += String.fromCharCode(byte) // not spread: a long message would overflow the arguments
  return btoa(out)
}
export const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

export const SEAL_INFO = 'slack-inbox-relay-v1'

// ephemeral public key (32) | iv (12) | AES-256-GCM ciphertext, keyed by HKDF-SHA256 over the X25519 shared secret.
export async function seal(recipient: string, plaintext: string): Promise<string> {
  const s = crypto.subtle
  const pub = unb64(recipient)
  const eph = (await s.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const peer = await s.importKey('raw', pub, { name: 'X25519' }, false, [])
  const shared = await s.deriveBits({ name: 'X25519', public: peer } as never, eph.privateKey, 256)
  const ephPub = new Uint8Array((await s.exportKey('raw', eph.publicKey)) as ArrayBuffer)
  const ikm = await s.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const key = await s.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: concat(ephPub, pub), info: enc.encode(SEAL_INFO) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)))
  return b64(concat(ephPub, iv, ct))
}

export async function verifyPull(publicKey: string, message: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', unb64(publicKey), { name: 'Ed25519' }, false, ['verify'])
  return crypto.subtle.verify({ name: 'Ed25519' }, key, unb64(signature), enc.encode(message))
}

async function slackSignatureOk(secret: string, timestamp: string, body: string, given: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const hex = given.replace(/^v0=/, '')
  if (!/^[0-9a-f]{64}$/.test(hex)) return false
  const sig = Uint8Array.from(hex.match(/../g)!, h => Number.parseInt(h, 16))
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(`v0:${timestamp}:${body}`)) // constant time
}

// How many of the oldest rows to delete to get back under the budget. Rounds up, so one pass is enough.
export function rowsToEvict(rows: number, sealedBytes: number, maxBytes = MAX_QUEUE_BYTES): number {
  const used = sealedBytes + rows * ROW_OVERHEAD_BYTES
  if (rows === 0 || used <= maxBytes) return 0
  return Math.min(rows, Math.ceil((used - maxBytes) / (used / rows)))
}

export const pullMessage = (time: string, after: string) => `pull:${time}:${after}`

// Only what the listener's matching reads, which also keeps the stored queue small.
export function trim(p: Record<string, any>): Record<string, unknown> {
  const e = p.event ?? {}
  return {
    type: p.type,
    event_id: p.event_id,
    team_id: p.team_id,
    enterprise_id: p.enterprise_id,
    is_ext_shared_channel: p.is_ext_shared_channel,
    event: {
      type: e.type,
      subtype: e.subtype,
      channel: e.channel,
      channel_type: e.channel_type,
      user: e.user,
      user_team: e.user_team,
      bot_id: e.bot_id,
      app_id: e.app_id,
      bot_profile: e.bot_profile?.app_id ? { app_id: e.bot_profile.app_id } : undefined,
      text: e.text,
      ts: e.ts,
      thread_ts: e.thread_ts,
      parent_user_id: e.parent_user_id,
    },
  }
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const withinSkew = (time: string, now: number) => /^\d+$/.test(time) && Math.abs(now / 1000 - Number(time)) <= CLOCK_SKEW_S

export function createRelay(c: RelayConfig) {
  const now = c.now ?? Date.now
  const sealTo = c.seal ?? seal
  const verify = c.verifyPull ?? verifyPull
  const maxAgeMs = c.maxAgeMs ?? MAX_AGE_MS

  const events = async (req: Request) => {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return new Response('too large', { status: 413 })
    const body = await req.text()
    const time = req.headers.get('x-slack-request-timestamp') ?? ''
    if (!withinSkew(time, now()) || !(await slackSignatureOk(c.signingSecret, time, body, req.headers.get('x-slack-signature') ?? '')))
      return new Response('bad signature', { status: 401 })
    let p: Record<string, any>
    try {
      p = JSON.parse(body)
    } catch {
      return new Response('bad json', { status: 400 })
    }
    if (p.type === 'url_verification') return json({ challenge: p.challenge })
    if (p.type !== 'event_callback' || typeof p.event_id !== 'string') return json({})
    // Another user who installs this app would have their events sealed to this key, so those never get stored
    if (!(p.authorizations ?? []).some((a: { user_id?: string }) => a.user_id === c.ownerUserId)) return json({})
    // Each stored event costs D1 writes, and on a busy workspace most are bots and edits the listener drops unread
    if (!passesRelay(p as EventsApiPayload, { userId: c.ownerUserId, teamId: p.team_id ?? '' }, c.allowBots ?? new Set())) return json({})
    // Stored before answering: an instance can be stopped once it has answered, and a retry is harmless
    let timer: ReturnType<typeof setTimeout> | undefined
    const over = new Promise<'over'>(resolve => {
      timer = setTimeout(() => resolve('over'), STORE_BUDGET_MS)
    })
    try {
      const stored = sealTo(c.sealKey, JSON.stringify(trim(p))).then(sealed => c.store.put(p.event_id, sealed, now() + maxAgeMs))
      if ((await Promise.race([stored, over])) === 'over') return new Response('store slow', { status: 503 })
    } catch {
      return new Response('store failed', { status: 503 })
    } finally {
      clearTimeout(timer)
    }
    return json({})
  }

  const pull = async (req: Request, url: URL) => {
    const after = url.searchParams.get('after') ?? '0'
    const time = req.headers.get('x-relay-time') ?? ''
    const given = req.headers.get('x-relay-signature') ?? ''
    if (!/^\d+$/.test(after) || !withinSkew(time, now())) return new Response('unauthorised', { status: 401 })
    let good = false
    try {
      good = await verify(c.verifyKey, pullMessage(time, after), given)
    } catch {}
    if (!good) return new Response('unauthorised', { status: 401 })
    return json({ events: await c.store.list(Number(after), PULL_LIMIT) })
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname === '/slack/events') return events(req)
    if (req.method === 'GET' && url.pathname === '/pull') return pull(req, url)
    if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true })
    return new Response('not found', { status: 404 })
  }
}
