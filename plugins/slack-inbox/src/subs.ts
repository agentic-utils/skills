// Subscriptions shared between the sessions' channel servers and the listener. Each session owns one file,
// <stateDir>/subscriptions/<session id>.json, so sessions never write the same file. The listener only reads them,
// to learn which conversations and threads to log beyond what is addressed to the user.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'

export type Sub = { conversation: string; thread_ts?: string; include_own?: boolean }

export type SessionFile = {
  inbox: boolean
  // with the inbox: also the user's own messages, everywhere they post
  inbox_own?: boolean
  conversations: Sub[]
  // where this session has read the log up to, so a resumed session gets what arrived while it was closed
  offset?: number
  ino?: number
  // the last connection state this session saw, so it is told about a recovery only after an outage
  state?: string
}

// A session closed for longer than this is forgotten: the listener ignores its file and servers delete it.
export const SESSION_TTL_MS = 72 * 3_600_000

export const subsDir = (stateDir: string) => `${stateDir}/subscriptions`

export const CONVERSATION = /^[CDG][A-Z0-9]{2,}$/
export const TS = /^\d{9,11}\.\d{6}$/

export const subKey = (s: { conversation: string; thread_ts?: string }) => (s.thread_ts ? `${s.conversation}:${s.thread_ts}` : s.conversation)

// A conversation id, or a Slack message link (which names a thread: the one it is in, or the one it starts).
export function parseTarget(conversation: string, threadTs?: string): { conversation: string; thread_ts?: string } {
  const c = conversation.trim()
  const link = c.match(/\/archives\/([CDG][A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/)
  if (link) {
    const q = c.match(/[?&]thread_ts=(\d+\.\d+)/)?.[1]
    const ts = threadTs ?? q ?? (link[2] ? `${link[2]}.${link[3]}` : undefined)
    return check(link[1], ts)
  }
  return check(c, threadTs)
}

function check(conversation: string, threadTs?: string) {
  if (!CONVERSATION.test(conversation)) throw new Error(`not a Slack conversation id or message link: ${conversation}`)
  if (threadTs !== undefined && !TS.test(threadTs)) throw new Error(`not a Slack message ts: ${threadTs}`)
  return threadTs ? { conversation, thread_ts: threadTs } : { conversation }
}

export function writeSessionFile(path: string, value: SessionFile) {
  const fd = openSync(`${path}.tmp`, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(value))
  } finally {
    closeSync(fd)
  }
  renameSync(`${path}.tmp`, path)
}

export function readSessionFile(path: string): SessionFile | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return { inbox: v.inbox === true, ...(v.inbox_own === true && { inbox_own: true }), conversations: Array.isArray(v.conversations) ? v.conversations : [], offset: v.offset, ino: v.ino, state: v.state }
  } catch {
    return null
  }
}

// What the listener logs on top of the user's own triggers: subKey -> whether some session wants the user's own
// messages there too. Files untouched for the TTL belong to sessions long gone and are skipped.
export type Watches = Map<string, boolean>

// The files of sessions that are still around: those untouched for the TTL belong to sessions long gone.
function liveSessions(stateDir: string, now: number): SessionFile[] {
  let names: string[] = []
  try {
    names = readdirSync(subsDir(stateDir)).filter(n => n.endsWith('.json'))
  } catch {
    return []
  }
  const out: SessionFile[] = []
  for (const n of names) {
    const path = `${subsDir(stateDir)}/${n}`
    try {
      if (now - statSync(path).mtimeMs > SESSION_TTL_MS) continue
    } catch {
      continue
    }
    const f = readSessionFile(path)
    if (f) out.push(f)
  }
  return out
}

export function readWatches(stateDir: string, now = Date.now()): Watches {
  const out: Watches = new Map()
  for (const f of liveSessions(stateDir, now)) {
    for (const s of f.conversations) {
      if (typeof s?.conversation !== 'string' || !CONVERSATION.test(s.conversation)) continue
      if (s.thread_ts !== undefined && !TS.test(s.thread_ts)) continue
      const k = subKey(s)
      out.set(k, out.get(k) === true || s.include_own === true)
    }
  }
  return out
}

// Whether some session subscribed to the inbox with include_own, so the listener logs everything the user posts.
export const wantsOwnInbox = (stateDir: string, now = Date.now()) => liveSessions(stateDir, now).some(f => f.inbox && f.inbox_own === true)

// Deletes files of sessions closed for longer than the TTL.
export function pruneStale(stateDir: string, now = Date.now()) {
  try {
    for (const n of readdirSync(subsDir(stateDir))) {
      const path = `${subsDir(stateDir)}/${n}`
      try {
        if (now - statSync(path).mtimeMs > SESSION_TTL_MS) unlinkSync(path)
      } catch {}
    }
  } catch {}
}

export const ensureSubsDir = (stateDir: string) => mkdirSync(subsDir(stateDir), { recursive: true, mode: 0o700 })
