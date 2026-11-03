// The listener: one Socket Mode connection, held open inside working hours, appending a JSONL line per match.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Config } from './config'
import { inHours } from './hours'
import {
  type EventsApiPayload,
  type Me,
  PRIORITY,
  type SlackMessage,
  type Trigger,
  needsThreadLookup,
  permalink,
  preview,
  screen,
  threadKey,
  triggers,
  watched,
} from './match'
import { inThread, myGroups, socketUrl, userName, whoami } from './slack'
import { readWatches, type Watches } from './subs'

const log = (...a: unknown[]) => console.error(new Date().toISOString(), '[slack-inbox]', ...a)

const THREAD_TTL_MS = 30 * 86_400_000 // forget a thread the user hasn't touched in 30 days
const NEGATIVE_TTL_MS = 10 * 60_000 // re-ask about a thread the user wasn't in after 10 minutes
const TICK_MS = 15_000
const SLEPT_MS = 30_000 // a tick this late means the machine slept, so the socket is probably dead

function writeAtomic(path: string, data: string) {
  const fd = openSync(`${path}.tmp`, 'w', 0o600)
  try {
    writeSync(fd, data)
  } finally {
    closeSync(fd)
  }
  renameSync(`${path}.tmp`, path)
}

// One listener per state dir, or every match would be logged twice.
function lock(dir: string): () => void {
  const path = `${dir}/listener.pid`
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'))
    let alive = false
    try {
      process.kill(pid, 0)
      alive = pid !== process.pid
    } catch {}
    if (alive) throw new Error(`another listener is running (pid ${pid}, ${path})`)
  }
  writeAtomic(path, String(process.pid))
  return () => {
    try {
      if (readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path)
    } catch {}
  }
}

export type HandlerDeps = {
  me: Me
  teamUrl: string
  allowBots: Set<string>
  previewChars: number
  groups: () => Set<string>
  userInThread: (channel: string, threadTs: string) => Promise<boolean>
  remember: (threadKey: string) => void
  watches: () => Watches
  userName: (id: string) => Promise<string>
  emit: (record: Record<string, unknown>) => void
}

// Turns one Socket Mode event into at most one log record. No socket, no clock: the deps are all it touches.
export function createHandler(d: HandlerDeps) {
  const seen = new Set<string>()
  const firstSighting = (key: string) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 5000) seen.delete(seen.values().next().value!)
    return true
  }
  const record = async (m: SlackMessage, hit: Trigger[], own: boolean) => {
    const author = m.user ?? m.bot_id ?? 'unknown'
    d.emit({
      kind: 'message',
      trigger: PRIORITY.find(t => hit.includes(t)),
      triggers: hit,
      channel: m.channel,
      channel_type: m.channel_type,
      ts: m.ts,
      thread_ts: m.thread_ts ?? null,
      permalink: permalink(d.teamUrl, m),
      author: { id: author, name: m.user ? await d.userName(m.user) : author },
      text: preview(m.text, d.previewChars),
      ...(own && { from_me: true }),
    })
  }

  return async (payload: EventsApiPayload) => {
    if (payload.event_id && !firstSighting(payload.event_id)) return
    const s = screen(payload, d.me, d.allowBots)
    if ('skip' in s) {
      if (s.skip !== 'own') return
      if (s.thread) d.remember(s.thread)
      // the user's own message: logged only where a session subscribed with include_own
      const m = payload.event!
      const hit = watched(m, d.watches(), true)
      if (hit.length && firstSighting(`${m.channel}:${m.ts}`)) await record(m, hit, true)
      return
    }
    const m = s.message
    if (!firstSighting(`${m.channel}:${m.ts}`)) return
    const inT = needsThreadLookup(m, d.me) ? await d.userInThread(m.channel, m.thread_ts!) : false
    const hit = triggers(m, d.me, d.groups(), inT, d.watches())
    if (hit.length) await record(m, hit, false)
  }
}

export async function run(cfg: Config) {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(cfg.logFile), { recursive: true, mode: 0o700 })
  const unlock = lock(cfg.stateDir)

  const emit = (record: Record<string, unknown>) =>
    appendFileSync(cfg.logFile, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, { mode: 0o600 })
  const status = (state: string, detail?: string) => {
    log(state, detail ?? '')
    emit({ kind: 'status', state, ...(detail ? { detail } : {}) })
  }

  const id = await whoami(cfg.userToken)
  if (id.missingScopes.length) log(`warning: user token lacks ${id.missingScopes.join(', ')}; some messages won't arrive`)
  const me: Me = { userId: id.userId, teamId: id.teamId, enterpriseId: id.enterpriseId }

  // Threads the user started or replied in, kept across restarts so old threads still count.
  const threadsFile = `${cfg.stateDir}/threads.json`
  const threads = new Map<string, number>()
  try {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(threadsFile, 'utf8')) as Record<string, number>)) threads.set(k, v)
  } catch {}
  const notIn = new Map<string, number>()
  let dirty = false
  const remember = (key: string) => {
    threads.set(key, Date.now())
    notIn.delete(key)
    dirty = true
  }
  const saveThreads = () => {
    if (!dirty) return
    const cutoff = Date.now() - THREAD_TTL_MS
    for (const [k, v] of threads) if (v < cutoff) threads.delete(k)
    writeAtomic(threadsFile, JSON.stringify(Object.fromEntries(threads)))
    dirty = false
  }

  let groups = new Set<string>()
  let groupsAt = 0
  const refreshGroups = async () => {
    try {
      groups = await myGroups(cfg.userToken, me.userId)
      groupsAt = Date.now()
      log(`in ${groups.size} user group(s)`)
    } catch (e) {
      log(`user group refresh failed, keeping the last list: ${(e as Error).message}`)
      groupsAt = Date.now() - cfg.groupRefreshMinutes * 60_000 + 60_000 // try again in a minute
    }
  }

  const userInThread = async (channel: string, threadTs: string): Promise<boolean> => {
    const key = threadKey(channel, threadTs)
    if (threads.has(key)) return true
    const miss = notIn.get(key)
    if (miss && Date.now() - miss < NEGATIVE_TTL_MS) return false
    try {
      if (await inThread(cfg.userToken, me.userId, channel, threadTs)) {
        remember(key)
        return true
      }
    } catch (e) {
      log(`thread lookup ${key} failed: ${(e as Error).message}`)
      return false // not cached, so the next reply asks again
    }
    notIn.set(key, Date.now())
    return false
  }

  let watches: Watches = new Map()
  let watchesAt = 0
  const handle = createHandler({
    me,
    teamUrl: id.url,
    allowBots: cfg.allowBots,
    previewChars: cfg.previewChars,
    groups: () => groups,
    userInThread,
    remember,
    // sessions change their subscriptions at any time; a couple of seconds' staleness is fine
    watches: () => {
      if (Date.now() - watchesAt > 2000) {
        watches = readWatches(cfg.stateDir)
        watchesAt = Date.now()
      }
      return watches
    },
    userName: id => userName(cfg.userToken, id),
    emit,
  })

  // --- the socket ---
  let ws: WebSocket | null = null
  let connecting = false
  let backoff = 1000
  let retryAt = 0
  let stopping = false
  // Reconnect after `ms` rather than waiting for the next tick; the tick still catches anything this misses.
  const later = (ms: number) => {
    retryAt = Date.now() + ms
    setTimeout(() => {
      if (!stopping && !ws && !connecting && inHours(cfg.hours, new Date())) connect()
    }, ms)
  }

  const drop = (why: string) => {
    const old = ws
    ws = null
    if (old) {
      old.onclose = null
      try {
        old.close()
      } catch {}
      status('disconnected', why)
    }
  }

  const connect = async () => {
    connecting = true
    try {
      const url = await socketUrl(cfg.appToken)
      const sock = new WebSocket(url)
      ws = sock
      sock.onmessage = ev => {
        let msg: { type?: string; envelope_id?: string; reason?: string; payload?: EventsApiPayload }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        // Ack first, whatever it is: Slack retries anything unacked within three seconds.
        if (msg.envelope_id) sock.send(JSON.stringify({ envelope_id: msg.envelope_id }))
        if (msg.type === 'hello') {
          backoff = 1000
          status('connected')
        } else if (msg.type === 'disconnect') {
          // Slack is about to close this socket (refresh, warning, link_disabled); open a fresh one now
          if (ws === sock) {
            drop(`slack asked: ${msg.reason ?? 'disconnect'}`)
            later(0)
          }
        } else if (msg.type === 'events_api' && msg.payload) {
          handle(msg.payload).catch(e => log(`event failed: ${(e as Error).message}`))
        }
      }
      sock.onclose = ev => {
        if (ws !== sock) return
        ws = null
        status('disconnected', `socket closed (${ev.code})`)
        later(backoff)
        backoff = Math.min(backoff * 2, 60_000)
      }
      sock.onerror = () => {} // onclose follows and handles it
    } catch (e) {
      log(`connect failed: ${(e as Error).message}`)
      const code = (e as { code?: string }).code
      if (code === 'invalid_auth' || code === 'not_authed' || code === 'token_revoked') {
        status('stopped', `app token rejected: ${code}`)
        shutdown(1)
      }
      later(backoff)
      backoff = Math.min(backoff * 2, 60_000)
    } finally {
      connecting = false
    }
  }

  let lastTick = Date.now()
  let paused = false
  const tick = async () => {
    const now = Date.now()
    const slept = now - lastTick > SLEPT_MS
    lastTick = now
    if (slept && ws) drop('machine slept')
    if (!inHours(cfg.hours, new Date())) {
      if (ws) drop('outside working hours')
      if (!paused) status('paused', 'outside working hours')
      paused = true
      saveThreads()
      return
    }
    paused = false
    if (now - groupsAt > cfg.groupRefreshMinutes * 60_000) await refreshGroups()
    if (!ws && !connecting && now >= retryAt) await connect()
    saveThreads()
  }

  const timer = setInterval(() => tick().catch(e => log(`tick failed: ${(e as Error).message}`)), TICK_MS)
  const shutdown = (code = 0) => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    drop('stopping')
    if (code === 0) status('stopped')
    saveThreads()
    unlock()
    process.exit(code)
  }
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())

  status('started', `as ${me.userId}, logging to ${cfg.logFile}`)
  await tick()
}
