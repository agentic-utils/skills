// The daemon: one per machine, shared by every session's shim. See the invariant in server.ts.
import type { Subprocess } from 'bun'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { version } from '../plugin.json'
import { beatName, parsePr, summarise, verified, type Event } from './events'
import { alive, daemonFile, isDaemon, log, privateStateDir, proof, reachable, readJson, writeJson, type DaemonInfo } from './state'

// push: only to spot base-branch moves that cause merge conflicts, never emitted itself
const events =
  'pull_request,pull_request_review,pull_request_review_comment,pull_request_review_thread,issue_comment,check_suite,workflow_run,push'
const cancelledMsg = 'unsubscribed while the forwarder started'
// our forwarder's argv, as `ps` shows it; group 1 is the repo
const forwarderArgs = / forward --repo=(\S+) --events=\S+ --url=http:\/\/127\.0\.0\.1:/
const validSession = /^[\w-]{1,64}$/
const PENDING_MAX = 100
const IDLE_MS = 5 * 60_000
const MAX_BODY = 25 * 1024 * 1024 // GitHub's own cap on a webhook payload

type Ev = { content: string; meta: Record<string, string> }
// A Claude session, known by its CLAUDE_CODE_SESSION_ID, which survives --resume. Streams: its shims' open event streams.
// dropped: queued events lost to the cap since it last connected. expired: what the TTL took from it, kept (a tombstone)
// for another TTL so it's told when it comes back. ephemeral: no CLAUDE_CODE_SESSION_ID, so it ends with its stream.
type Session = {
  subs: Map<string, string>
  pending: Ev[]
  dropped: number
  lastSeen: number
  beatDir?: string
  expired?: { prs: string[]; at: number }
  ephemeral?: boolean
  streams: Set<(e: Ev) => boolean>
}
type Sub = { pr: string; sessions: Set<string>; conflictBase?: string } // conflictBase: set while the PR conflicts with it
// A repo's forwarder from the first subscribe on: `ready` settles once it has started (null) or failed (the error).
type Fwd = { p?: Subprocess<'ignore', 'ignore', 'pipe'>; ready: Promise<string | null>; up: boolean; cancelled: boolean }

// SIGINT lets gh-webhook delete its webhook; escalate if it hangs (e.g. offline), and settle only once it's dead.
function terminate(pid: number, exited?: Promise<unknown>): Promise<void> {
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig)
    } catch {}
  }
  kill('SIGINT')
  const term = setTimeout(() => kill('SIGTERM'), 10_000)
  const hard = setTimeout(() => (log(`forwarder ${pid} ignored SIGINT and SIGTERM; its webhook may persist`), kill('SIGKILL')), 20_000)
  const dead =
    exited ??
    (async () => {
      while (alive(pid)) await Bun.sleep(100)
    })()
  return dead.then(() => (clearTimeout(term), clearTimeout(hard)))
}

// Returns null when another daemon already serves.
export async function startDaemon() {
  const dir = privateStateDir()
  const pidFile = `${dir}/forwarders.json`
  const sessionsFile = `${dir}/sessions.json`
  const token = randomBytes(32).toString('hex')
  const secret = randomBytes(32).toString('hex')
  const forwarders = new Map<string, Fwd>() // repo -> its forwarder, starting or up
  const exiting = new Map<string, Promise<unknown>>() // repo -> forwarders stopped there but still deleting their webhooks
  const live = new Set<number>() // every forwarder pid not yet seen to exit, ours or a dead daemon's
  const sessions = new Map<string, Session>()
  const subs = new Map<string, Sub>() // lowercased owner/repo#n (GitHub names are case-insensitive) -> who wants it
  const inRepo = (repo: string) => [...subs.keys()].filter(k => k.startsWith(repo + '#'))
  const ttlMs = Number(process.env.GH_PR_EVENTS_SESSION_TTL_HOURS ?? 72) * 3600_000
  let url = '' // the webhook receiver's, set once elected
  let stopped = false // once stop() has saved for the last time, nothing else may save or deliver
  let quarantined = false // sessions.json was unreadable at start: every session is told on its first connect
  const told = new Set<string>() // sessions that have connected to this daemon at least once
  const hours = `${Math.round(ttlMs / 3600_000)}h`
  // Only the daemon daemon.json names may write state or deliver: a stale one would clobber its successor's.
  const owned = () => {
    const d = readJson<DaemonInfo>(daemonFile())
    return d?.pid === process.pid && d.token === token
  }

  // Every change to subs, sessions and forwarders runs through here, one at a time, and none of them waits on a
  // process: slow things (a forwarder starting, or exiting) happen outside, and their outcome comes back as another step.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => T): Promise<T> => {
    const r = queue.then(fn)
    r.catch(e => log('daemon op failed:', e))
    queue = r.catch(() => {})
    return r
  }

  // ---- sessions, persisted so a resumed session gets its subscriptions and missed events back ----

  // An unreadable file is set aside rather than overwritten, so whatever it held can still be recovered by hand.
  function loadSessions(): Record<string, any> {
    let text: string
    try {
      text = readFileSync(sessionsFile, 'utf8')
    } catch {
      return {}
    }
    try {
      const v = JSON.parse(text)
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
      throw new Error('not an object')
    } catch (e) {
      const to = `${sessionsFile}.corrupt-${Date.now()}`
      try {
        renameSync(sessionsFile, to)
      } catch {}
      log(`could not read sessions.json (${e}); moved it to ${to}`)
      quarantined = true
      return {}
    }
  }

  const session = (id: string) => {
    let s = sessions.get(id)
    if (!s) sessions.set(id, (s = { subs: new Map(), pending: [], dropped: 0, lastSeen: Date.now(), streams: new Set() }))
    return s
  }
  const save = () => {
    if (stopped || !owned()) return
    try {
      const out: Record<string, object> = {}
      for (const [id, s] of sessions)
        if (!s.ephemeral && (s.subs.size || s.pending.length || s.dropped || s.expired))
          out[id] = { subs: [...s.subs.values()], pending: s.pending, dropped: s.dropped, lastSeen: s.lastSeen, beatDir: s.beatDir, expired: s.expired }
      writeJson(sessionsFile, out)
    } catch (e) {
      log('could not save sessions:', e)
    }
  }
  // To each open stream of the session, or queued for when it reconnects.
  const deliver = (id: string, e: Ev) => {
    const s = sessions.get(id)
    if (!s || stopped || !owned()) return
    let sent = false
    for (const stream of s.streams) sent = stream(e) || sent
    if (sent) return
    if (s.pending.length >= PENDING_MAX) (s.pending.shift(), s.dropped++)
    s.pending.push(e)
    save()
  }
  const emitTo = (key: string, content: string, meta: Record<string, string>) => {
    for (const id of subs.get(key)?.sessions ?? []) deliver(id, { content, meta })
  }
  // Drops a repo's subscriptions and tells their sessions, which can resubscribe.
  const dropRepo = (repo: string, why: string) => {
    for (const k of inRepo(repo)) {
      for (const id of subs.get(k)!.sessions) {
        sessions.get(id)?.subs.delete(k)
        deliver(id, { content: why, meta: { event: 'channel_error' } })
      }
      subs.delete(k)
    }
    save()
    armIdle()
  }

  // ---- forwarders ----

  // A pid stays recorded until it has exited, so a daemon that dies before then has the next one stop it.
  const savePids = () => {
    try {
      writeFileSync(pidFile, JSON.stringify([...live]), { mode: 0o600 })
    } catch (e) {
      log('could not record forwarder pids:', e)
    }
  }
  const track = (pid: number, exited: Promise<unknown>) => {
    live.add(pid)
    savePids()
    exited.then(() => (live.delete(pid), savePids()))
  }
  // A new start for the repo waits until every forwarder stopping there is gone.
  const waitExit = (repo: string, gone: Promise<unknown>) => {
    const all = Promise.all([exiting.get(repo), gone])
    exiting.set(repo, all)
    all.then(() => exiting.get(repo) === all && exiting.delete(repo))
  }

  // One forwarder per repo with a subscribed PR, so an idle daemon holds no webhook. Called inside serial().
  function ensureForwarder(repo: string): Promise<string | null> {
    const existing = forwarders.get(repo)
    if (existing) return existing.ready
    const f: Fwd = { up: false, cancelled: false, ready: Promise.resolve(null) }
    forwarders.set(repo, f)
    f.ready = (async () => {
      await exiting.get(repo) // GitHub refuses a second forward to the repo until the old webhook is deleted
      if (f.cancelled) return cancelledMsg
      const bin = process.env.GH_PR_EVENTS_FORWARDER ?? `${process.env.XDG_DATA_HOME ?? process.env.HOME + '/.local/share'}/gh/extensions/gh-webhook/gh-webhook`
      // the extension binary itself, not `gh webhook`: gh doesn't pass SIGINT on, so the temp webhook would outlive us
      if (!(await Bun.file(bin).exists())) return 'gh-webhook extension missing: run `gh extension install cli/gh-webhook`'
      if (f.cancelled) return cancelledMsg // again: stopForwarder may have run during the await
      const p = (f.p = Bun.spawn([bin, 'forward', `--repo=${repo}`, `--events=${events}`, `--url=${url}webhook`, `--secret=${secret}`], {
        stdout: 'ignore',
        stderr: 'pipe',
      }))
      track(p.pid, p.exited)
      // read stderr for as long as it runs: a full, unread pipe would block the forwarder
      let firstLine = ''
      const stderrDone = (async () => {
        const dec = new TextDecoder()
        for await (const chunk of p.stderr) {
          const text = dec.decode(chunk, { stream: true })
          firstLine ||= text.split('\n')[0]
          log(`[${repo}]`, text.trimEnd())
        }
      })().catch(() => {})
      if ((await Promise.race([p.exited, Bun.sleep(3000).then(() => null)])) !== null) {
        if (f.cancelled) return cancelledMsg // stopped on purpose during its start
        await stderrDone
        return `gh webhook forward failed for ${repo}: ${firstLine}`
      }
      f.up = true
      log(`forwarding ${repo} -> ${url}webhook`)
      p.exited.then(code =>
        serial(() => {
          if (forwarders.get(repo) !== f) return // stopped on purpose
          forwarders.delete(repo)
          dropRepo(repo, `gh webhook forward for ${repo} exited ${code}; call subscribe_pr again to retry`)
        }),
      )
      return null
    })().catch(e => `gh webhook forward failed for ${repo}: ${e}`)
    // a failed start takes its waiting subscriptions with it; each subscriber gets the error as its reply
    f.ready.then(err =>
      serial(() => {
        if (!err || forwarders.get(repo) !== f) return
        forwarders.delete(repo)
        for (const k of inRepo(repo)) {
          for (const id of subs.get(k)!.sessions) sessions.get(id)?.subs.delete(k)
          subs.delete(k)
        }
        save()
        armIdle()
      }),
    )
    return f.ready
  }

  // Doesn't wait: the next start for the repo waits for the exit instead.
  function stopForwarder(repo: string) {
    const f = forwarders.get(repo)
    if (!f) return
    forwarders.delete(repo)
    f.cancelled = true // if it hasn't spawned yet, it won't
    if (f.p) waitExit(repo, terminate(f.p.pid, f.p.exited))
  }

  // A daemon killed with SIGKILL leaves its forwarders running with their webhooks: stop whatever the last one
  // recorded, and have new starts for those repos wait until they're gone.
  function reapOrphans() {
    const recorded = readJson<unknown>(pidFile)
    for (const pid of Array.isArray(recorded) ? recorded : []) {
      if (!Number.isInteger(pid) || pid <= 1) continue
      // the pid may have been reused since: only touch a process with our forwarder's exact argument shape
      const m = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)]).stdout.toString().match(forwarderArgs)
      if (!m) continue
      const gone = terminate(pid)
      track(pid, gone)
      waitExit(m[1].toLowerCase(), gone)
    }
    savePids()
  }

  // Proves to the Stop hook that each subscribed PR is watched, in the beat dir its session asked for.
  function beat() {
    const now = new Date()
    for (const [id, s] of sessions) {
      if (!s.beatDir || !s.streams.size) continue
      for (const [k, pr] of s.subs) {
        if (!forwarders.get(k.split('#')[0])?.up) continue
        const f = `${s.beatDir}/${beatName(pr)}`
        try {
          mkdirSync(s.beatDir, { recursive: true })
          closeSync(openSync(f, 'a', 0o644)) // touch, never truncate
          utimesSync(f, now, now)
        } catch (e) {
          log(`beat failed for ${id}:`, e)
        }
      }
    }
  }

  // ---- merge conflicts and force pushes, which webhooks don't report directly ----

  const gh = async (...args: string[]) => {
    try {
      const p = Bun.spawn([process.env.GH_PR_EVENTS_GH ?? 'gh', ...args], { stdout: 'pipe', stderr: 'ignore' })
      return (await new Response(p.stdout).text()).trim()
    } catch (e) {
      log('gh failed:', e)
      return ''
    }
  }
  async function mergeability(repo: string, n: string): Promise<{ base: string; conflicted: boolean } | null> {
    // ponytail: mergeable is null while GitHub recomputes after a push; 5 tries 3s apart, then give up silently
    for (let i = 0; i < 5; i++) {
      const [base, m] = (await gh('api', `repos/${repo}/pulls/${n}`, '-q', '[.base.ref, .mergeable] | @tsv')).split('\t')
      if (m === 'true' || m === 'false') return { base, conflicted: m === 'false' }
      await Bun.sleep(3000)
    }
    return null
  }
  const conflictEv = (s: Sub, base: string, on: boolean): Ev => {
    const [repo, n] = s.pr.split('#')
    return {
      content: `Merge conflicts with ${base}${on ? '' : ' resolved'}\nhttps://github.com/${repo}/pull/${n}`,
      meta: { event: 'merge_conflict', repo, pr: n },
    }
  }
  // Emits only on a change, so a conflict is reported once and again when it clears. onlyBase skips PRs targeting other branches.
  async function recheck(key: string, onlyBase?: string) {
    const first = subs.get(key)
    if (!first) return
    const [repo, n] = first.pr.split('#')
    const r = await mergeability(repo, n)
    const s = subs.get(key)
    if (!r || !s || (onlyBase && r.base !== onlyBase) || r.conflicted === !!s.conflictBase) return
    s.conflictBase = r.conflicted ? r.base : undefined
    const e = conflictEv(s, r.base, r.conflicted)
    emitTo(key, e.content, e.meta)
  }
  // A force push arrives as an ordinary synchronize; the old head not being an ancestor of the new one gives it away.
  // ponytail: compare failing (e.g. old head gone) reads as a normal push
  const forced = async (repo: string, before: string, after: string) =>
    ['diverged', 'behind'].includes(await gh('api', `repos/${repo}/compare/${before}...${after}`, '-q', '.status'))

  // ---- the state changes; only ever called through serial() ----

  // Registers interest at once and returns the forwarder's start to wait on outside the queue.
  function subscribe(id: string, pr: string): { ready: Promise<string | null> } {
    const key = pr.toLowerCase()
    const s = session(id)
    let sub = subs.get(key)
    if (!sub) {
      subs.set(key, (sub = { pr, sessions: new Set() }))
      recheck(key).catch(log) // reports a PR that already has conflicts
    }
    sub.sessions.add(id)
    s.subs.set(key, pr)
    save()
    // a later subscriber still hears about a conflict the others were already told about
    if (sub.conflictBase) deliver(id, conflictEv(sub, sub.conflictBase, true))
    return { ready: ensureForwarder(key.split('#')[0]) }
  }

  // Drops one session's interest, or everyone's when id is omitted (the PR closed). The last one out stops the forwarder.
  function unsubscribe(key: string, id?: string) {
    const sub = subs.get(key)
    if (!sub) return
    for (const sid of id ? [id] : [...sub.sessions]) {
      sub.sessions.delete(sid)
      sessions.get(sid)?.subs.delete(key)
    }
    save()
    if (sub.sessions.size) return
    subs.delete(key)
    const repo = key.split('#')[0]
    if (!inRepo(repo).length) stopForwarder(repo)
    armIdle()
  }

  // A session gone longer than the TTL is forgotten, so an abandoned one doesn't hold webhooks for ever. What it
  // was watching stays as a tombstone for another TTL, so if it does come back it's told.
  function expire() {
    const now = Date.now()
    const cutoff = now - ttlMs
    for (const [id, s] of sessions) {
      if (s.streams.size) {
        s.lastSeen = now
        continue
      }
      if (s.expired && s.expired.at < cutoff) s.expired = undefined
      if (s.lastSeen >= cutoff) continue
      const prs = [...s.subs.values()]
      for (const k of [...s.subs.keys()]) unsubscribe(k, id)
      s.pending = []
      s.dropped = 0
      if (prs.length) {
        s.expired = { prs, at: now }
        log(`forgot session ${id}'s subscriptions, unseen for ${hours}`)
      }
      if (!s.expired) sessions.delete(id)
    }
    save()
    armIdle()
  }

  // ---- tool calls from the shims ----

  async function call(id: string, name: string, args: any, beatDir?: string): Promise<{ text: string; isError?: boolean }> {
    const pr = parsePr(String(args?.pr ?? ''))
    if (!pr || !/^[\w-][\w.-]*\/[\w-][\w.-]*#\d+$/.test(pr)) return { text: 'expected a PR URL or owner/repo#number', isError: true }
    const key = pr.toLowerCase()
    const s = session(id)
    s.lastSeen = Date.now()
    if (beatDir && isAbsolute(beatDir)) s.beatDir = beatDir // relative would resolve against the daemon's cwd
    if (name === 'subscribe_pr') {
      const { ready } = await serial(() => subscribe(id, pr))
      let err = await ready
      // it may have been unsubscribed, or closed, while the forwarder started: only claim what the daemon still has
      if (!err && !(await serial(() => s.subs.has(key)))) err = cancelledMsg
      if (err) return { text: err, isError: true }
      beat()
    } else if (name === 'unsubscribe_pr') await serial(() => unsubscribe(key, id))
    else return { text: `unknown tool: ${name}`, isError: true }
    return { text: `subscribed: ${[...s.subs.values()].join(', ') || 'none'}` }
  }

  // ---- HTTP: shims (token) and webhooks (HMAC) ----

  const authed = (req: Request) => {
    const got = Buffer.from(req.headers.get('authorization') ?? '')
    const want = Buffer.from(`Bearer ${token}`)
    return got.length === want.length && timingSafeEqual(got, want)
  }

  async function onWebhook(req: Request) {
    const body = await req.text()
    if (!verified(body, req.headers.get('x-hub-signature-256'), secret)) return new Response('bad signature', { status: 401 })
    const event = req.headers.get('x-github-event') ?? ''
    let payload: any
    let e: Event = null
    try {
      payload = JSON.parse(body)
      e = summarise(event, payload)
    } catch (err) {
      log('summarise failed', event, err)
      return new Response('ok')
    }
    const repo = String(payload.repository?.full_name)
    const key = `${repo}#${e?.pr}`.toLowerCase()
    if (event === 'push' && payload.ref?.startsWith('refs/heads/')) {
      const branch = payload.ref.slice('refs/heads/'.length)
      for (const k of inRepo(repo.toLowerCase())) recheck(k, branch).catch(log)
    }
    if (event === 'pull_request' && payload.action === 'synchronize' && subs.has(key)) recheck(key).catch(log)
    const wanted = e && subs.has(key)
    log(event, wanted ? 'emitted' : 'ignored')
    if (!e || !wanted) return new Response('ok')
    if (event === 'pull_request' && payload.action === 'synchronize' && (await forced(repo, payload.before, payload.after))) {
      e.text = e.text.replace('New commits pushed by', 'Force-pushed by').replace('\n', ' (history rewritten)\n')
    }
    const meta = { event, repo, pr: String(e.pr) }
    if (!e.done) emitTo(key, e.text, meta)
    // in one step, so whoever is subscribed when it's applied is told, including a subscribe that was queued
    else serial(() => (emitTo(key, e.text + '\n(unsubscribed automatically)', meta), unsubscribe(key)))
    return new Response('ok')
  }

  // A shim's event stream: what the session is watching, then anything it missed, then live events, until the shim
  // goes away. An ephemeral session's subscriptions go with its stream.
  function events$(id: string, req: Request) {
    const s = session(id)
    const enc = new TextEncoder()
    const closed = () => {
      s.streams.delete(send)
      s.lastSeen = Date.now()
      if (s.ephemeral && !s.streams.size)
        serial(() => {
          if (s.streams.size) return
          for (const k of [...s.subs.keys()]) unsubscribe(k, id)
          sessions.delete(id)
        })
      save()
      armIdle()
    }
    let send: (e: Ev) => boolean = () => false
    const body = new ReadableStream({
      start(ctrl) {
        send = e => {
          try {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
            return true
          } catch {
            s.streams.delete(send)
            return false
          }
        }
        ctrl.enqueue(enc.encode(': connected\n\n'))
        s.streams.add(send)
        s.lastSeen = Date.now()
        clearTimeout(idle)
        if (quarantined && !told.has(id))
          send({ content: "gh-pr-events couldn't read its saved subscriptions; if this session had any, call subscribe_pr again", meta: { event: 'channel_error' } })
        told.add(id)
        const watching = [...s.subs.values()]
        // "none" only on a reconnect, so a new session isn't woken just to hear it watches nothing
        if (watching.length || req.headers.get('x-reconnect')) send({ content: `watching: ${watching.join(', ') || 'none'}`, meta: { event: 'watching' } })
        if (s.expired) {
          send({
            content: `gh-pr-events forgot this session's subscriptions after ${hours} away: ${s.expired.prs.join(', ')}. Call subscribe_pr again to resume`,
            meta: { event: 'channel_error' },
          })
          s.expired = undefined
        }
        if (s.dropped) send({ content: `${s.dropped} older gh-pr-events notifications were dropped while this session was away`, meta: { event: 'channel_error' } })
        s.dropped = 0
        for (const e of s.pending.splice(0)) send(e)
        save()
        req.signal.addEventListener('abort', closed)
      },
      cancel: closed,
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }

  async function onRequest(req: Request, server: Bun.Server<unknown>) {
    // only local, non-browser clients: a page in a browser can't fake Host, and always sends Origin on a POST
    if (req.headers.get('host') !== `127.0.0.1:${server.port}` || req.headers.has('origin')) return new Response('forbidden', { status: 403 })
    const u = new URL(req.url)
    if (u.pathname === '/webhook' && req.method === 'POST') return onWebhook(req)
    // unauthenticated, so a shim can check this is its daemon before it sends the token
    if (u.pathname === '/info') {
      const challenge = req.headers.get('x-challenge') ?? ''
      if (!/^[0-9a-f]{32,128}$/.test(challenge)) return new Response('missing x-challenge', { status: 400 })
      return Response.json({ version, pid: process.pid, proof: proof(token, challenge) })
    }
    if (!authed(req)) return new Response('unauthorized', { status: 401 })
    const id = req.headers.get('x-claude-session') ?? ''
    if (u.pathname === '/shutdown' && req.method === 'POST') {
      setTimeout(() => quit('asked to shut down'), 10)
      return new Response('bye')
    }
    if (!validSession.test(id)) return new Response('missing x-claude-session', { status: 400 })
    if (req.headers.get('x-session-ephemeral')) session(id).ephemeral = true
    if (u.pathname === '/events') {
      server.timeout(req, 0) // open for as long as the shim is
      return events$(id, req)
    }
    if (u.pathname === '/call' && req.method === 'POST') {
      try {
        const { name, arguments: args, beatDir } = await req.json()
        return Response.json(await call(id, String(name), args, typeof beatDir === 'string' ? beatDir : undefined))
      } catch (e) {
        return Response.json({ text: String(e), isError: true })
      }
    }
    return new Response('not found', { status: 404 })
  }

  // Exits when nothing is subscribed and no shim is connected, so an idle machine runs nothing.
  let idle: Timer | undefined
  const busy = () => subs.size > 0 || [...sessions.values()].some(s => s.streams.size)
  const armIdle = () => {
    clearTimeout(idle)
    if (!busy())
      idle = setTimeout(() => !busy() && quit('idle'), IDLE_MS)
  }
  const quit = (why: string) => {
    log('exiting:', why)
    stop().finally(() => process.exit(0))
  }

  // ---- election: daemon.json names the one serving daemon ----

  // Contenders take elect.lock (holding their pid) in turn; inside it, whoever finds the named daemon neither
  // answering nor running takes over. One that's running but slow to answer is left alone: only a daemon that has
  // died is replaced. A lock whose holder has died, or that has been held implausibly long, is broken.
  const lock = `${dir}/elect.lock`
  let http: ReturnType<typeof Bun.serve> | undefined
  let lost = false
  for (let i = 0; i < 200 && !http && !lost; i++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
    } catch {
      try {
        const holder = Number(readFileSync(lock, 'utf8'))
        if (!holder || !alive(holder) || Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock)
      } catch {}
      await Bun.sleep(50)
      continue
    }
    try {
      const cur = readJson<DaemonInfo>(daemonFile())
      if (await reachable(cur)) lost = true
      else if (cur?.pid !== process.pid && isDaemon(cur?.pid)) {
        log(`daemon ${cur!.pid} is running but not answering; leaving it be`)
        lost = true
      } else {
        http = Bun.serve({
          port: Number(process.env.GH_PR_EVENTS_PORT ?? 0),
          hostname: '127.0.0.1',
          idleTimeout: 60, // seconds; /events turns it off for its own stream
          maxRequestBodySize: MAX_BODY,
          fetch: onRequest,
        })
        writeJson(daemonFile(), { pid: process.pid, port: http.port, token, version } satisfies DaemonInfo)
      }
    } finally {
      try {
        if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock)
      } catch {}
    }
  }
  if (!http) return null
  url = `http://127.0.0.1:${http.port}/`
  reapOrphans()

  // Restore persisted sessions, and start forwarders for their subscriptions so events queue even with nobody connected.
  // A session that expired while no daemon ran gets its tombstone here instead.
  const now = Date.now()
  for (const [id, v] of Object.entries(loadSessions())) {
    if (!validSession.test(id) || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const lastSeen = Number(v.lastSeen) || 0
    const prs = (Array.isArray(v.subs) ? v.subs : []).filter((pr: unknown) => typeof pr === 'string' && parsePr(pr)) as string[]
    const t = v.expired
    const tomb =
      now - lastSeen > ttlMs && prs.length
        ? { prs, at: lastSeen + ttlMs }
        : Array.isArray(t?.prs) && Number.isFinite(t.at)
          ? { prs: t.prs.filter((pr: unknown) => typeof pr === 'string'), at: t.at }
          : undefined
    const s = session(id)
    s.lastSeen = lastSeen
    s.expired = tomb && now - tomb.at <= ttlMs ? tomb : undefined
    if (now - lastSeen > ttlMs) {
      if (!s.expired) sessions.delete(id)
      continue
    }
    s.beatDir = typeof v.beatDir === 'string' && isAbsolute(v.beatDir) ? v.beatDir : undefined
    s.pending = (Array.isArray(v.pending) ? v.pending : []).filter((e: any) => typeof e?.content === 'string').slice(-PENDING_MAX)
    s.dropped = Number.isInteger(v.dropped) && v.dropped > 0 ? v.dropped : 0
    for (const pr of prs)
      serial(() => subscribe(id, pr)).then(({ ready }) =>
        ready.then(err => err && deliver(id, { content: `Could not resume the subscription to ${pr}: ${err}`, meta: { event: 'channel_error' } })),
      )
  }
  serial(() => (save(), armIdle())) // after the restored subscribes, which run in this queue too
  const timers = [
    setInterval(beat, 4 * 60_000), // the Stop hook wants a beat every 15 min
    setInterval(() => serial(expire), Math.max(1000, Math.min(3600_000, ttlMs / 2))),
    // a daemon that daemon.json no longer names can't be found by shims, so it only holds webhooks: step aside
    setInterval(() => !owned() && quit('daemon.json names another daemon'), 5000),
  ]
  log(`daemon ${process.pid} ${version} on ${url}`)

  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= (async () => {
      timers.forEach(clearInterval)
      clearTimeout(idle)
      http!.stop(true)
      if (owned()) {
        save() // subscriptions survive a restart; the next daemon picks them up
        stopped = true
        try {
          unlinkSync(daemonFile()) // after the save, so a successor started as soon as it's gone reads the final state
        } catch {}
      }
      stopped = true
      for (const repo of [...forwarders.keys()]) stopForwarder(repo)
      await Promise.race([Promise.all(exiting.values()), Bun.sleep(25_000)])
    })())
  return { port: http.port, token, stop }
}
