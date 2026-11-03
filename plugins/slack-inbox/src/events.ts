// What a session's channel server does with each log line: which subscription it belongs to, what Claude is shown,
// and how many a minute get through. Pure apart from reading the log file.
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { type SessionFile, subKey } from './subs'

export type LogRecord = {
  kind?: string
  state?: string
  detail?: string
  at?: string
  trigger?: string
  triggers?: string[]
  channel?: string
  channel_type?: string
  ts?: string
  thread_ts?: string | null
  permalink?: string
  author?: { id?: string; name?: string }
  text?: string
  from_me?: boolean
  via_claude?: boolean
  external?: boolean
}

export type Via = 'thread' | 'conversation' | 'inbox'
export type Route = { via: Via; key: string }

// Triggers that mean the message is addressed to the user, as opposed to logged for a session's subscription.
const PERSONAL = new Set(['dm', 'group_dm', 'mention', 'group_mention', 'thread_reply'])

// The most specific subscription of this session a message belongs to, or null. The user's own messages only
// reach a subscription made with include_own: a conversation or thread, or the inbox, where they get a cap of their
// own (key `inbox:own`) so a burst of the user's posts never crowds out messages addressed to them.
export function route(r: LogRecord, s: SessionFile): Route | null {
  if (r.kind !== 'message' || typeof r.channel !== 'string') return null
  const own = r.from_me === true
  // Slack Connect goes to the inbox only: it is read-only, for the user's eyes, never a conversation to work in
  if (r.external === true) {
    if (!s.inbox) return null
    if (!own && (r.triggers ?? []).some(t => PERSONAL.has(t))) return { via: 'inbox', key: 'inbox' }
    if (own && s.inbox_own && (r.triggers ?? []).includes('own')) return { via: 'inbox', key: 'inbox:own' }
    return null
  }
  const reply = typeof r.thread_ts === 'string' && r.thread_ts !== r.ts
  for (const sub of s.conversations) {
    if (sub.thread_ts && reply && sub.conversation === r.channel && sub.thread_ts === r.thread_ts && (!own || sub.include_own))
      return { via: 'thread', key: subKey(sub) }
  }
  for (const sub of s.conversations) {
    if (!sub.thread_ts && sub.conversation === r.channel && (!own || sub.include_own)) return { via: 'conversation', key: subKey(sub) }
  }
  if (s.inbox && !own && (r.triggers ?? []).some(t => PERSONAL.has(t))) return { via: 'inbox', key: 'inbox' }
  if (s.inbox && s.inbox_own && own && (r.triggers ?? []).includes('own')) return { via: 'inbox', key: 'inbox:own' }
  return null
}

// States in which messages may be missed. not_running is the server's own: the listener's process is gone.
export const OUTAGE = new Set(['disconnected', 'paused', 'stopped', 'not_running'])

// Whether a connection-state change is news to a session that last saw `prev`: each new kind of outage, and the
// recovery after one. Routine reconnects while already connected, and `started`, are not.
export const statusNews = (prev: string | undefined, state: string) => (OUTAGE.has(state) ? state !== prev : state === 'connected' && OUTAGE.has(prev ?? ''))

export type Notification = { content: string; meta: Record<string, string> }

const safe = (v: unknown) => String(v ?? '').replace(/[^\w.:-]/g, '').slice(0, 100)

const meta = (m: Record<string, unknown>) => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== null && v !== '') out[k] = safe(v)
  return out
}

export function messageNotification(r: LogRecord, route: Route): Notification {
  const who = r.from_me ? `you${r.via_claude ? ' (posted by a Claude session)' : ''}` : `${r.author?.name ?? 'unknown'} (${r.author?.id ?? '?'})`
  const where = r.thread_ts && r.thread_ts !== r.ts ? `thread ${r.thread_ts} in ${r.channel}` : r.channel
  const ext = r.external ? ' [Slack Connect, external: read-only, tell the user only, never reply or post there]' : ''
  return {
    content: `${r.trigger ?? 'message'} from ${who} in ${where}${ext}: ${r.text ?? ''}\n${r.permalink ?? ''}`.trim(),
    meta: meta({ event: 'message', via: route.via, trigger: r.trigger, channel: r.channel, ts: r.ts, thread_ts: r.thread_ts, via_claude: r.via_claude ? 'true' : undefined, external: r.external ? 'true' : undefined }),
  }
}

const STATE_TEXT: Record<string, string> = {
  disconnected: 'the Slack listener disconnected; messages sent until it reconnects may never arrive',
  paused: 'the Slack listener paused outside working hours; messages sent until it resumes may never arrive',
  stopped: 'the Slack listener stopped; nothing will arrive until it is started again',
  not_running: 'the Slack listener is not running; nothing will arrive until it is started again',
  connected: 'the Slack listener is connected again; messages sent during the gap may be missing',
}

export function statusNotification(state: string, detail?: string, at?: string): Notification {
  const text = STATE_TEXT[state] ?? `the Slack listener is ${state}`
  return { content: `${text}${detail ? ` (${detail})` : ''}${at ? ` at ${at}` : ''}`, meta: meta({ event: 'status', state }) }
}

// At most `limit` pushes per subscription per minute; the rest are counted and reported once the minute is up,
// so a busy channel can't flood the session.
export class RateCap {
  private windows = new Map<string, { start: number; sent: number; dropped: number }>()
  constructor(readonly limit: number) {}

  allow(key: string, now: number): boolean {
    let w = this.windows.get(key)
    // a window that dropped something ends only through flush, so its count is always reported
    if (!w || (now - w.start >= 60_000 && !w.dropped)) {
      w = { start: now, sent: 0, dropped: 0 }
      this.windows.set(key, w)
    }
    if (w.sent < this.limit && !w.dropped) {
      w.sent++
      return true
    }
    w.dropped++
    return false
  }

  // Ends every window that is over: what each dropped, for one summary push apiece.
  flush(now: number): { key: string; dropped: number }[] {
    const out: { key: string; dropped: number }[] = []
    for (const [key, w] of this.windows) {
      if (now - w.start < 60_000) continue
      if (w.dropped) out.push({ key, dropped: w.dropped })
      this.windows.delete(key)
    }
    return out
  }
}

export const droppedNotification = (key: string, dropped: number, limit: number): Notification => ({
  content: `${dropped} more Slack message${dropped === 1 ? '' : 's'} for ${key} in the last minute ${dropped === 1 ? 'was' : 'were'} not pushed (cap: ${limit} a minute per subscription); read the conversation in Slack, or the listener's log, if they matter`,
  meta: meta({ event: 'rate_limited', subscription: key, dropped }),
})

export type LogPos = { offset?: number; ino?: number }

const MAX_READ = 4 * 1024 * 1024

// Complete lines appended since `pos`. With no position yet it starts at the end, so only new lines count. A
// replaced (rotated) or truncated file is read from its start.
export function readNew(path: string, pos: LogPos): { lines: string[]; pos: LogPos } {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch {
    return { lines: [], pos }
  }
  const size = Number(st.size)
  const ino = Number(st.ino)
  if (pos.offset === undefined || pos.ino === undefined) return { lines: [], pos: { offset: size, ino } }
  const offset = ino !== pos.ino || size < pos.offset ? 0 : pos.offset
  if (size === offset) return { lines: [], pos: { offset, ino } }
  const len = Math.min(size - offset, MAX_READ)
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, offset)
  } finally {
    closeSync(fd)
  }
  const end = buf.lastIndexOf(10)
  if (end < 0) return { lines: [], pos: { offset, ino } }
  const lines = buf.subarray(0, end + 1).toString('utf8').split('\n').filter(Boolean)
  return { lines, pos: { offset: offset + end + 1, ino } }
}

// The listener's newest status line in the log's last 64 KiB, if any.
export function lastStatus(path: string): LogRecord | null {
  try {
    const size = Number(statSync(path).size)
    const len = Math.min(size, 65_536)
    const buf = Buffer.alloc(len)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buf, 0, len, size - len)
    } finally {
      closeSync(fd)
    }
    const lines = buf.toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"kind":"status"')) continue
      try {
        return JSON.parse(lines[i])
      } catch {}
    }
  } catch {}
  return null
}
