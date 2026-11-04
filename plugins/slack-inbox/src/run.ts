// The listener: one Socket Mode connection, held open inside working hours, appending a JSONL line per match.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { type Config, readSecretFile } from './config'
import { inHours } from './hours'
import {
  type EventsApiPayload,
  type Me,
  PERSONAL,
  PRIORITY,
  type SlackMessage,
  type Trigger,
  needsThreadLookup,
  permalink,
  preview,
  screen,
  threadKey,
  triggers,
  viaClaude,
  watched,
} from './match'
import { createPuller, type RelayKeys } from './pull'
import { inThread, myGroups, newestMessageAt, socketUrl, userName, whoami } from './slack'
import { readWatches, type Watches, wantsOwnInbox } from './subs'

const log = (...a: unknown[]) => console.error(new Date().toISOString(), '[slack-inbox]', ...a)

const THREAD_TTL_MS = 30 * 86_400_000 // forget a thread the user hasn't touched in 30 days
const NEGATIVE_TTL_MS = 10 * 60_000 // re-ask about a thread the user wasn't in after 10 minutes
const TICK_MS = 15_000
const RELAY_TICK_MS = 10_000 // how often relay mode pulls while awake, so at most this late
const SLEPT_MS = 30_000 // a tick this late means the machine slept, so the socket is probably dead
const HELLO_TIMEOUT_MS = 30_000 // a socket that opens but never says hello would otherwise block reconnecting for good
const SILENT_MS = 60_000 // Slack pings about every 10 seconds, so this much silence means the socket is dead
const STALL_GRACE_MS = 2 * 60_000 // how late an event may be before its absence counts
const STALL_CHECK_MS = 5 * 60_000
const STALL_CHANNELS = 5 // conversations sampled per check; any recent message in one is enough to tell

// Why a socket should be replaced, or null. Silence includes protocol pings, so a quiet workspace never trips it.
export function socketProblem(s: { now: number; openedAt: number; helloAt?: number; lastFrameAt?: number }): string | null {
  if (s.helloAt === undefined) return s.now - s.openedAt > HELLO_TIMEOUT_MS ? 'no hello from slack' : null
  return s.now - (s.lastFrameAt ?? s.helloAt) > SILENT_MS ? 'no traffic from slack' : null
}

// Slack can stop sending events while the socket stays healthy, so only Slack's history can show the silence is wrong.
// `newestAt` is the newest message in conversations the user is in. A message older than the grace period, with no
// event since it was sent, should have arrived; one from before this connection was simply missed while it was down.
export function deliveryStalled(s: { now: number; newestAt: number; lastEventAt: number; connectedAt: number }): boolean {
  return s.newestAt > s.connectedAt && s.newestAt > s.lastEventAt && s.now - s.newestAt > STALL_GRACE_MS
}

// Whole minutes once it is worth saying, as the machine may have slept for days.
export const sleptFor = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`)

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

// Conversations in the log's newest lines, so a restarted listener can check delivery before its first event.
export function recentChannels(path: string, max: number): string[] {
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n').slice(-500)
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const line of lines.reverse()) {
    try {
      const c = JSON.parse(line).channel
      if (typeof c === 'string') out.add(c)
    } catch {}
    if (out.size >= max) break
  }
  return [...out]
}

// A queued mention of a user group can only be matched once the user's groups are known, and a message matched
// without them is consumed for good. So nothing is pulled until they have loaded; the queue keeps it meanwhile.
export async function drainRelay(d: { groupsLoaded: () => boolean; loadGroups: () => Promise<void>; pull: () => Promise<void> }) {
  if (!d.groupsLoaded()) await d.loadGroups()
  if (d.groupsLoaded()) await d.pull()
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
  // whether to log every message the user posts, not only where a session watches with include_own
  logOwn: () => boolean
  userName: (id: string) => Promise<string>
  emit: (record: Record<string, unknown>) => void
}

// Slack Connect keeps only what is addressed to the user, or is their own post.
const keep = (hit: Trigger[], external: boolean) => (external ? hit.filter(t => PERSONAL.has(t)) : hit)

// Turns one Socket Mode event into at most one log record. No socket, no clock: the deps are all it touches.
export function createHandler(d: HandlerDeps) {
  const seen = new Set<string>()
  const firstSighting = (key: string) => {
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 5000) seen.delete(seen.values().next().value!)
    return true
  }
  const record = async (m: SlackMessage, hit: Trigger[], own: boolean, external: boolean) => {
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
      ...(external && { external: true }),
      ...(own && viaClaude(m.text) && { via_claude: true }), // anyone can type the line, so only the user's own posts count
    })
  }

  return async (payload: EventsApiPayload) => {
    if (payload.event_id && !firstSighting(payload.event_id)) return
    const s = screen(payload, d.me, d.allowBots)
    if ('skip' in s) {
      if (s.skip !== 'own') return
      if (s.thread) d.remember(s.thread)
      // the user's own message: logged when the listener wants all of them, or where a session subscribed with include_own
      const m = payload.event!
      const hit = keep([...(d.logOwn() ? (['own'] as const) : []), ...watched(m, d.watches(), true)], s.external)
      if (hit.length && firstSighting(`${m.channel}:${m.ts}`)) await record(m, hit, true, s.external)
      return
    }
    const m = s.message
    if (!firstSighting(`${m.channel}:${m.ts}`)) return
    const inT = needsThreadLookup(m, d.me) ? await d.userInThread(m.channel, m.thread_ts!) : false
    const hit = keep(triggers(m, d.me, d.groups(), inT, d.watches()), s.external)
    if (hit.length) await record(m, hit, false, s.external)
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
  let groupsLoaded = false
  let groupsWaitReported = false
  const refreshGroups = async () => {
    try {
      groups = await myGroups(cfg.userToken, me.userId)
      groupsAt = Date.now()
      groupsLoaded = true
      log(`in ${groups.size} user group(s)`)
    } catch (e) {
      log(`user group refresh failed, keeping the last list: ${(e as Error).message}`)
      groupsAt = Date.now() - cfg.groupRefreshMinutes * 60_000 + 60_000 // try again in a minute
      if (cfg.relayUrl && !groupsLoaded && !groupsWaitReported) {
        groupsWaitReported = true
        status('disconnected', `not pulling from the relay until user groups load: ${(e as Error).message}`)
      }
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
  let ownInbox = false
  let watchesAt = 0
  const refresh = () => {
    if (Date.now() - watchesAt > 2000) {
      watches = readWatches(cfg.stateDir)
      ownInbox = wantsOwnInbox(cfg.stateDir)
      watchesAt = Date.now()
    }
  }
  const handle = createHandler({
    me,
    teamUrl: id.url,
    allowBots: cfg.allowBots,
    previewChars: cfg.previewChars,
    groups: () => groups,
    userInThread,
    remember,
    // sessions change their subscriptions at any time; a couple of seconds' staleness is fine
    watches: () => (refresh(), watches),
    logOwn: () => cfg.includeOwn || (refresh(), ownInbox),
    userName: id => userName(cfg.userToken, id),
    emit,
  })

  // --- is Slack still sending events? ---
  const active = new Map<string, number>() // conversation -> when it last had an event, newest last
  const noteActive = (channel: string) => {
    active.delete(channel)
    active.set(channel, Date.now())
    if (active.size > STALL_CHANNELS) active.delete(active.keys().next().value!)
  }
  for (const c of recentChannels(cfg.logFile, STALL_CHANNELS)) noteActive(c)
  let lastEventAt = 0
  let stalled = false
  let stallCheckAt = 0
  const received = (payload: EventsApiPayload) => {
    lastEventAt = Date.now()
    if (payload.event?.channel) noteActive(payload.event.channel)
    if (stalled) {
      stalled = false
      status('connected', 'events are arriving again')
    }
    return handle(payload)
  }

  // --- relay mode: Slack posts to a hosted relay, and this pulls what it sealed ---
  const puller = cfg.relayUrl
    ? createPuller({ url: cfg.relayUrl, keys: JSON.parse(readSecretFile(cfg.relayKeyFile)) as RelayKeys, cursorFile: `${cfg.stateDir}/relay-cursor`, handle: received, log })
    : null
  let relaySince: number | undefined
  let relayDown = false
  let pulling = false
  const pullRelay = async () => {
    if (!puller || pulling) return
    pulling = true
    try {
      const r = await puller.pull()
      if (r.lost) {
        status('lost', `up to ${r.lost} older event${r.lost === 1 ? '' : 's'} dropped by the relay to stay within its size limit before being collected`)
        status('connected', `pulling from ${cfg.relayUrl}`)
      }
      if (r.error) {
        if (r.failures === 1) log(`relay pull failed: ${r.error}`)
        if (puller.outage() && !relayDown) {
          relayDown = true
          status('disconnected', `relay unreachable: ${r.error}`)
        }
        return
      }
      if (relayDown || relaySince === undefined) {
        relayDown = false
        relaySince = Date.now()
        status('connected', `pulling from ${cfg.relayUrl}`)
      }
    } finally {
      pulling = false
    }
  }

  const checkDelivery = async (now: number) => {
    const connectedAt = puller ? relaySince : health.helloAt
    if (stalled || connectedAt === undefined || now - stallCheckAt < STALL_CHECK_MS) return
    stallCheckAt = now
    let newestAt = 0
    for (const channel of active.keys()) {
      try {
        newestAt = Math.max(newestAt, await newestMessageAt(cfg.userToken, channel))
      } catch (e) {
        log(`delivery check ${channel} failed: ${(e as Error).message}`) // says nothing about delivery, so not a stall
      }
    }
    if (deliveryStalled({ now, newestAt, lastEventAt, connectedAt })) {
      stalled = true
      status('stalled', "slack has newer messages than the last event received; check the app's Enable events setting in Slack app management")
    }
  }

  // --- the socket ---
  let ws: WebSocket | null = null
  let health = { openedAt: 0, helloAt: undefined as number | undefined, lastFrameAt: undefined as number | undefined }
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
      health = { openedAt: Date.now(), helloAt: undefined, lastFrameAt: undefined }
      const heard = () => {
        if (ws === sock) health.lastFrameAt = Date.now()
      }
      // Bun surfaces protocol pings as an event; the DOM type does not know about them
      ;(sock as unknown as { addEventListener(type: string, fn: () => void): void }).addEventListener('ping', heard)
      sock.onmessage = ev => {
        heard()
        let msg: { type?: string; envelope_id?: string; reason?: string; num_connections?: number; payload?: EventsApiPayload }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        // Ack first, whatever it is: Slack retries anything unacked within three seconds.
        if (msg.envelope_id) sock.send(JSON.stringify({ envelope_id: msg.envelope_id }))
        if (msg.type === 'hello') {
          backoff = 1000
          if (ws === sock) health.helloAt = Date.now()
          // Slack shares events between connections, so more than one means something else holds this app's token
          if ((msg.num_connections ?? 1) > 1) log(`warning: ${msg.num_connections} connections on this app token; events are shared between them`)
          status('connected')
        } else if (msg.type === 'disconnect') {
          // Slack is about to close this socket (refresh, warning, link_disabled); open a fresh one now
          if (ws === sock) {
            drop(`slack asked: ${msg.reason ?? 'disconnect'}`)
            later(0)
          }
        } else if (msg.type === 'events_api' && msg.payload) {
          received(msg.payload).catch(e => log(`event failed: ${(e as Error).message}`))
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
    const late = now - lastTick
    const slept = late > SLEPT_MS
    lastTick = now
    if (slept) backoff = 1000
    // logged on waking, so it says how long: a brief wake can report connected and freeze again seconds later
    if (slept && ws) drop(`machine slept for ${sleptFor(late)}`)
    if (ws) {
      const problem = socketProblem({ now, ...health })
      if (problem) drop(problem)
    }
    if (!inHours(cfg.hours, new Date())) {
      if (ws) drop('outside working hours')
      if (!paused) status('paused', 'outside working hours')
      paused = true
      saveThreads()
      return
    }
    paused = false
    // connect first: right after a wake this refresh can wait out a 30 second timeout
    if (puller) await drainRelay({ groupsLoaded: () => groupsLoaded, loadGroups: refreshGroups, pull: pullRelay })
    else if (!ws && !connecting && now >= retryAt) await connect()
    if (now - groupsAt > cfg.groupRefreshMinutes * 60_000) await refreshGroups()
    await checkDelivery(now)
    saveThreads()
  }

  const timer = setInterval(() => tick().catch(e => log(`tick failed: ${(e as Error).message}`)), puller ? RELAY_TICK_MS : TICK_MS)
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
