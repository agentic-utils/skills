// The broker: one per machine, shared by every session's channel. See the invariant in server.ts.
import type { Socket, Subprocess } from 'bun'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { beatName, summarise, verified, type Event } from './events'
import { lines, log, privateStateDir, sockPath, writer } from './wire'

// push: only to spot base-branch moves that cause merge conflicts, never emitted itself
const events =
  'pull_request,pull_request_review,pull_request_review_comment,pull_request_review_thread,issue_comment,check_suite,workflow_run,push'
const cancelledMsg = 'unsubscribed while the forwarder started'
// what parsePr produces; no segment may start with '.', so no '..' reaches a gh api path
const canonicalPr = /^[\w-][\w.-]*\/[\w-][\w.-]*#\d+$/
// our forwarder's argv, as `ps` shows it; group 1 is the repo
const forwarderArgs = / forward --repo=(\S+) --events=\S+ --url=http:\/\/127\.0\.0\.1:/

type Client = { send: (m: object) => void; closed: boolean; beatDir?: string }
type Sub = { pr: string; clients: Set<Client>; conflictBase?: string } // conflictBase: set while the PR conflicts with it
// A repo's forwarder from the first subscribe on: `ready` settles once it has started (null) or failed (the error).
type Fwd = { p?: Subprocess<'ignore', 'ignore', 'pipe'>; ready: Promise<string | null>; up: boolean; cancelled: boolean }
type SockData = { c: Client; feed: (b: Uint8Array) => void; flush: () => void }

const reachable = (path: string) =>
  Bun.connect({ unix: path, socket: { data() {}, open: s => void s.end() } }).then(
    () => true,
    () => false,
  )
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// SIGINT lets gh-webhook delete its webhook; escalate if it hangs (e.g. offline), and settle only once it's dead.
function terminate(pid: number, exited?: Promise<unknown>): Promise<void> {
  const kill = (sig: string) => {
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

// Returns null when another broker already serves the socket.
export async function startBroker() {
  const dir = privateStateDir()
  const path = sockPath()
  const pidFile = `${dir}/forwarders.json`
  const secret = randomBytes(32).toString('hex')
  const forwarders = new Map<string, Fwd>() // repo -> its forwarder, starting or up
  const exiting = new Map<string, Promise<unknown>>() // repo -> a stopped forwarder still deleting its webhook
  const live = new Set<number>() // every forwarder pid not yet seen to exit, ours or a dead broker's
  const subs = new Map<string, Sub>() // lowercased owner/repo#n (GitHub names are case-insensitive) -> who wants it
  const clients = new Set<Client>()
  const inRepo = (repo: string) => [...subs.keys()].filter(k => k.startsWith(repo + '#'))
  let url = '' // the webhook receiver's, set once elected

  // Every change to subs and forwarders runs through here, one at a time, and none of them waits on a process:
  // slow things (a forwarder starting, or exiting) happen outside, and their outcome comes back as another step.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => T): Promise<T> => {
    const r = queue.then(fn)
    queue = r.catch(e => log('broker op failed:', e))
    return r
  }

  const emitTo = (key: string, content: string, meta: Record<string, string>, unsub = false) => {
    for (const c of subs.get(key)?.clients ?? []) c.send({ content, meta, ...(unsub && { unsub: key }) })
  }
  // tells a repo's subscribers their subscription is gone, and forgets them (their channels forget them too)
  const dropRepo = (repo: string, why: string) => {
    for (const k of inRepo(repo)) {
      emitTo(k, why, { event: 'channel_error' }, true)
      subs.delete(k)
    }
  }

  // A pid stays recorded until it has exited, so a broker that dies before then has the next one stop it.
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

  // One forwarder per repo with a subscribed PR, so an idle broker holds no webhook. Called inside serial().
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
      const p = (f.p = Bun.spawn([bin, 'forward', `--repo=${repo}`, `--events=${events}`, `--url=${url}`, `--secret=${secret}`], {
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
      const early = await Promise.race([p.exited, Bun.sleep(3000).then(() => null)])
      if (early !== null) {
        if (f.cancelled) return cancelledMsg // stopped on purpose during its start
        await stderrDone
        return `gh webhook forward failed for ${repo}: ${firstLine}`
      }
      f.up = true
      log(`forwarding ${repo} -> ${url}`)
      p.exited.then(code =>
        serial(() => {
          if (forwarders.get(repo) !== f) return // stopped on purpose
          forwarders.delete(repo)
          dropRepo(repo, `gh webhook forward for ${repo} exited ${code}; call subscribe_pr again to retry`)
        }),
      )
      return null
    })().catch(e => `gh webhook forward failed for ${repo}: ${e}`)
    // a failed start takes its waiting subscribers with it; each gets the error as its reply
    f.ready.then(err =>
      serial(() => {
        if (!err || forwarders.get(repo) !== f) return
        forwarders.delete(repo)
        for (const k of inRepo(repo)) subs.delete(k)
      }),
    )
    return f.ready
  }

  // A new start for the repo waits until every forwarder stopping there is gone.
  function waitExit(repo: string, gone: Promise<unknown>) {
    const all = Promise.all([exiting.get(repo), gone])
    exiting.set(repo, all)
    all.then(() => exiting.get(repo) === all && exiting.delete(repo))
  }

  // Doesn't wait: gh-webhook deletes its webhook on SIGINT, and the next start for the repo waits for that instead.
  function stopForwarder(repo: string) {
    const f = forwarders.get(repo)
    if (!f) return
    forwarders.delete(repo)
    f.cancelled = true // if it hasn't spawned yet, it won't
    const p = f.p
    if (!p) return
    waitExit(repo, terminate(p.pid, p.exited))
  }

  // A broker killed with SIGKILL leaves its forwarders running with their webhooks: stop whatever the last one
  // recorded, and have new starts for those repos wait until they're gone.
  function reapOrphans() {
    let recorded: unknown = []
    try {
      recorded = JSON.parse(readFileSync(pidFile, 'utf8'))
    } catch {}
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

  // Proves to the Stop hook that each subscribed PR is watched, in the beat dir its own session asked for.
  function beat() {
    const now = new Date()
    for (const [k, s] of subs) {
      if (!forwarders.get(k.split('#')[0])?.up) continue
      for (const c of s.clients) {
        if (!c.beatDir) continue
        const f = `${c.beatDir}/${beatName(s.pr)}`
        try {
          mkdirSync(c.beatDir, { recursive: true })
          closeSync(openSync(f, 'a', 0o644)) // touch, never truncate: the path came over the socket
          utimesSync(f, now, now)
        } catch (e) {
          log('beat failed:', e)
        }
      }
    }
  }

  const gh = async (...args: string[]) => {
    try {
      const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'ignore' })
      return (await new Response(p.stdout).text()).trim()
    } catch (e) {
      log('gh failed:', e)
      return ''
    }
  }

  // GitHub sends no webhook when a base-branch push makes a PR unmergeable, so re-ask GitHub after pushes.
  async function mergeability(repo: string, n: string): Promise<{ base: string; conflicted: boolean } | null> {
    // ponytail: mergeable is null while GitHub recomputes after a push; 5 tries 3s apart, then give up silently
    for (let i = 0; i < 5; i++) {
      const [base, m] = (await gh('api', `repos/${repo}/pulls/${n}`, '-q', '[.base.ref, .mergeable] | @tsv')).split('\t')
      if (m === 'true' || m === 'false') return { base, conflicted: m === 'false' }
      await Bun.sleep(3000)
    }
    return null
  }

  const conflictMeta = (s: Sub) => {
    const [repo, pr] = s.pr.split('#')
    return { event: 'merge_conflict', repo, pr }
  }
  const conflictText = (s: Sub, base: string, on: boolean) => {
    const [repo, n] = s.pr.split('#')
    return `Merge conflicts with ${base}${on ? '' : ' resolved'}\nhttps://github.com/${repo}/pull/${n}`
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
    emitTo(key, conflictText(s, r.base, r.conflicted), conflictMeta(s))
  }

  // A force push arrives as an ordinary synchronize; the old head not being an ancestor of the new one gives it away.
  // ponytail: compare failing (e.g. old head gone) reads as a normal push
  const forced = async (repo: string, before: string, after: string) =>
    ['diverged', 'behind'].includes(await gh('api', `repos/${repo}/compare/${before}...${after}`, '-q', '.status'))

  // ---- the state changes; only ever called through serial() ----

  // Registers interest at once and returns the forwarder's start to wait on outside the queue.
  function subscribe(c: Client, pr: string): { ready: Promise<string | null> } {
    if (c.closed) return { ready: Promise.resolve('session closed') }
    const key = pr.toLowerCase()
    let s = subs.get(key)
    if (!s) {
      subs.set(key, (s = { pr, clients: new Set() }))
      recheck(key).catch(log) // reports a PR that already has conflicts
    }
    s.clients.add(c)
    // a later subscriber still hears about a conflict the others were already told about
    if (s.conflictBase) c.send({ content: conflictText(s, s.conflictBase, true), meta: conflictMeta(s) })
    return { ready: ensureForwarder(key.split('#')[0]) }
  }

  // Drops one session's interest, or everyone's when c is omitted (the PR closed). The last one out stops the forwarder.
  function unsubscribe(key: string, c?: Client) {
    const s = subs.get(key)
    if (!s) return
    if (c) {
      s.clients.delete(c)
      if (s.clients.size) return
    }
    subs.delete(key)
    const repo = key.split('#')[0]
    if (!inRepo(repo).length) stopForwarder(repo)
  }

  // ---- webhooks from the forwarders ----

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
    else {
      // in one step, so whoever is subscribed when it's applied is told, including a subscribe that was queued
      const text = e.text + '\n(unsubscribed automatically)'
      serial(() => (emitTo(key, text, meta, true), unsubscribe(key)))
    }
    return new Response('ok')
  }

  // ---- sessions over the unix socket ----

  async function handle(c: Client, m: any) {
    if (!m || typeof m !== 'object') return
    let err: string | null = null
    const { op, pr } = m
    if (typeof pr !== 'string' || !canonicalPr.test(pr)) err = 'expected owner/repo#number'
    else if (op === 'sub') {
      // relative would resolve against whichever session started the broker
      c.beatDir = typeof m.beatDir === 'string' && isAbsolute(m.beatDir) ? m.beatDir : undefined
      const { ready } = await serial(() => subscribe(c, pr))
      err = await ready
      // it may have been unsubscribed, or closed, while the forwarder started: only claim what the broker still has
      if (!err && !(await serial(() => subs.get(pr.toLowerCase())?.clients.has(c)))) err = cancelledMsg
      if (!err) beat()
    } else if (op === 'unsub') await serial(() => unsubscribe(pr.toLowerCase(), c))
    else err = `unknown op: ${op}`
    c.send({ id: m.id, err })
  }

  let idle: Timer | undefined
  const armIdle = () => {
    clearTimeout(idle)
    if (!clients.size)
      idle = setTimeout(() => {
        log('idle, exiting')
        stop().finally(() => process.exit(0))
      }, 5 * 60_000)
  }

  const handlers = {
    open(sock: Socket<SockData>) {
      const w = writer(sock)
      const c: Client = { send: w.send, closed: false }
      clients.add(c)
      clearTimeout(idle)
      sock.data = { c, feed: lines(m => handle(c, m).catch(e => (log('request failed:', e), c.send({ id: m?.id, err: String(e) })))), flush: w.flush }
    },
    data: (sock: Socket<SockData>, chunk: Uint8Array) => sock.data.feed(chunk),
    drain: (sock: Socket<SockData>) => sock.data.flush(),
    close(sock: Socket<SockData>) {
      const { c } = sock.data
      c.closed = true // a subscribe of this session still queued won't start a webhook nobody is left to receive
      clients.delete(c)
      serial(() => {
        for (const [k, s] of [...subs]) if (s.clients.has(c)) unsubscribe(k, c)
      })
      armIdle()
    },
  }

  // Election. Bun.listen replaces whatever is at the path, even a live broker's socket, so the path can't be the
  // lock: contenders take elect.lock (holding their pid) in turn, and inside it whoever finds no broker answering
  // starts listening. A lock whose holder has died is broken.
  const lock = `${dir}/elect.lock`
  let listener: ReturnType<typeof Bun.listen<SockData>> | undefined
  let lost = false
  for (let i = 0; i < 200 && !listener && !lost; i++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 })
    } catch {
      try {
        // break it if its holder is dead, or it has been held implausibly long (a reused pid, or a holder that died before writing)
        const holder = Number(readFileSync(lock, 'utf8'))
        if (!holder || !alive(holder) || Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock)
      } catch {}
      await Bun.sleep(50)
      continue
    }
    try {
      if (await reachable(path)) lost = true
      else listener = Bun.listen<SockData>({ unix: path, socket: handlers })
    } finally {
      try {
        if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock)
      } catch {}
    }
  }
  if (!listener) return null
  const ino = statSync(path).ino
  const http = Bun.serve({ port: Number(process.env.GH_PR_EVENTS_PORT ?? 0), hostname: '127.0.0.1', fetch: onWebhook })
  url = `http://127.0.0.1:${http.port}/`
  reapOrphans()
  armIdle()
  const beats = setInterval(beat, 4 * 60_000) // Stop hook treats a PR as unwatched after 15 min without a beat
  log(`broker ${process.pid} on ${path}, webhooks on ${url}`)

  async function stop() {
    clearInterval(beats)
    clearTimeout(idle)
    listener!.stop(true)
    // right away, and only if it's still ours: a broker elected since must keep its socket
    try {
      if (statSync(path).ino === ino) unlinkSync(path)
    } catch {}
    http.stop(true)
    for (const repo of [...forwarders.keys()]) stopForwarder(repo)
    await Promise.race([Promise.all(exiting.values()), Bun.sleep(12_000)])
  }
  return { port: http.port, stop }
}
