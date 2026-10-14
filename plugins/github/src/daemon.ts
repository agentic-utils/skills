// The daemon: one per machine, shared by every session's shim. See the invariant in server.ts.
import type { Subprocess } from 'bun'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { version } from '../.claude-plugin/plugin.json'
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
const TICK_MS = 5000
const GAP_MS = Number(process.env.GH_PR_EVENTS_GAP_MS ?? 30_000) // a tick this late means the machine slept (env: tests only)
const SLACK_MS = 5 * 60_000 // a catch-up looks this far back before the gap; ids drop what was already delivered
const MATCH_MS = 2 * 60_000 // a recovered PR action this close in time to a live one of the same kind is that one
const RESTARTS = 10 // consecutive failed forwarder restarts (1s doubling to 60s apart, ~6 min) before giving up
const RETRY_MS = Number(process.env.GH_PR_EVENTS_RETRY_MS ?? 30_000) // between catch-up attempts, 5 in all (env: tests only)
const API_TIMEOUT_MS = 60_000
const RECOVERED = '(recovered after a gap) '
const REOPEN_HOURS = Number(process.env.GH_PR_EVENTS_REOPEN_HOURS ?? 24) // keep a closed, unmerged PR this long in case it's reopened
const POLL_MS = Number(process.env.GH_PR_EVENTS_POLL_SECONDS ?? 60) * 1000 // a repo we can't forward is polled this often
const FORWARD_RETRY_MS = Number(process.env.GH_PR_EVENTS_FORWARD_RETRY_MS ?? 5 * 60_000) // and its forward retried this often (env: tests only)
const SWEEP_MS = 5 * 60_000 // a polled PR is caught up in full this often even when its probes saw no change
// GitHub refusing the forward: one is allowed per repo and someone else holds it, or we're not admin
const TAKEN = /already exists/i
const NO_ADMIN = /HTTP 40[34]|Not Found|admin|Resource not accessible/i
const GRACE_MS = Number(process.env.GH_PR_EVENTS_MERGED_GRACE_MINUTES ?? 60) * 60_000 // keep a merged PR this long for late reviews

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
// refused: why GitHub refused the forward, if it did.
type Fwd = { p?: Subprocess<'ignore', 'ignore', 'pipe'>; ready: Promise<string | null>; up: boolean; cancelled: boolean; refused?: string }
// A repo polled because it can't be forwarded: when it's next due, when to retry the forward, when its PRs were last
// caught up in full, and why it's polled.
type Poll = { due: number; retry: number; swept: number; why: string; busy?: boolean }
// One delivered event, kept so a catch-up doesn't repeat it: its id, when it happened, and whether a catch-up sent it.
// A PR action (label, review request, draft...) has no id GitHub repeats in its issue events, so live ones are kept
// as `pr<action><subject>` and matched by time instead.
type Done = { id: string; t: number; r?: true }
// Per subscribed PR, what a catch-up needs: since: when it last had everything (a live event, or a catch-up's
// start); gap: set while it's behind, where the catch-up must start from; at: when it was subscribed (nothing older
// is recovered); gen: bumped each time it falls behind, so a catch-up only closes a gap that didn't reopen while it
// ran; done: what it already delivered; head: its head sha; closed: when it was closed without merging, if it still is;
// merged: when it merged (it's watched for late comments until GRACE_MS after).
type Seen = { since: number; gap?: number; gen?: number; at: number; done: Done[]; head?: string; closed?: number; merged?: number }

const actionOf = (p: any) => `pr${p.action}${p.label?.name ?? p.requested_reviewer?.login ?? p.requested_team?.name ?? ''}`
// An event's identity, the same whether it came live or from the API, so a catch-up never repeats one.
function idOf(event: string, p: any): string | undefined {
  switch (event) {
    case 'issue_comment':
      return `ic${p.comment?.id}`
    case 'pull_request_review_comment':
      return `rc${p.comment?.id}`
    case 'pull_request_review':
      return `r${p.review?.id}${p.action}`
    case 'workflow_run':
      return `w${p.workflow_run?.id}.${p.workflow_run?.run_attempt}`
    case 'check_suite':
      return `cs${p.check_suite?.id}@${p.check_suite?.updated_at}`
    case 'pull_request':
      if (p.action === 'synchronize') return `push${p.after}`
      return p.issueEvent ? `ie${p.issueEvent}` : actionOf(p) // issueEvent: set on a recovered one
  }
}

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
  const seen = new Map<string, Seen>() // per key in subs, persisted with the sessions
  const behind = new Set<string>() // repos whose forwarder was down or cut off: caught up once it's back
  const restarts = new Map<string, number>() // repo -> failed restarts in a row
  const polled = new Map<string, Poll>() // repos GitHub won't forward to us, polled instead
  // ponytail: never pruned (a few short strings per PR head polled); prune with the PR if polling gets heavy use
  const etags = new Map<string, string>() // API path -> its last ETag, for conditional polls
  const pollFails = new Map<string, number>() // key -> failed polls in a row
  const waits = new Set<Timer>() // pending restarts and catch-up retries, cleared by stop()
  const later = (fn: () => unknown, ms: number) => {
    const t = setTimeout(() => (waits.delete(t), halting || fn()), ms)
    waits.add(t)
  }
  let halting = false // stop() has begun: start nothing new
  let ghOld = '' // set when gh is too old to catch up
  const inRepo = (repo: string) => [...subs.keys()].filter(k => k.startsWith(repo + '#'))
  const ttlMs = Number(process.env.GH_PR_EVENTS_SESSION_TTL_HOURS ?? 72) * 3600_000
  let url = '' // the webhook receiver's, set once elected
  let stopped = false // once stop() has saved for the last time, nothing else may save or deliver
  let quarantined = false // sessions.json was unreadable at start: every session is told on its first connect
  // sessions that have connected to this daemon at least once, with what they watched when their last stream ended
  const told = new Map<string, string>()
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
      // not a valid session id, so a 2.0 daemon skips it; only PRs a saved session watches
      out['#seen'] = Object.fromEntries([...seen].filter(([k]) => [...(subs.get(k)?.sessions ?? [])].some(id => !sessions.get(id)?.ephemeral)))
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
  // Claude Code shows a notification as one line cut at the terminal width, rendering no markdown, so each PR
  // event starts with the PR's name (owner/repo#n): it survives the cut where the URL doesn't.
  const label = (sub: Sub, content: string) => `${sub.pr}: ${content}`
  const emitTo = (key: string, content: string, meta: Record<string, string>) => {
    const sub = subs.get(key)
    for (const id of sub?.sessions ?? []) deliver(id, { content: label(sub!, content), meta })
  }
  // Drops a repo's subscriptions and tells their sessions, which can resubscribe.
  const dropRepo = (repo: string, why: string) => {
    for (const k of inRepo(repo)) {
      for (const id of subs.get(k)!.sessions) {
        sessions.get(id)?.subs.delete(k)
        deliver(id, { content: why, meta: { event: 'channel_error' } })
      }
      subs.delete(k)
      seen.delete(k)
    }
    polled.delete(repo)
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
    if (halting) return Promise.resolve('pr-events is shutting down')
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
      let all = ''
      const stderrDone = (async () => {
        const dec = new TextDecoder()
        for await (const chunk of p.stderr) {
          const text = dec.decode(chunk, { stream: true })
          firstLine ||= text.split('\n')[0]
          all += text
          log(`[${repo}]`, text.trimEnd())
        }
      })().catch(() => {})
      if ((await Promise.race([p.exited, Bun.sleep(3000).then(() => null)])) !== null) {
        if (f.cancelled) return cancelledMsg // stopped on purpose during its start
        await stderrDone
        f.refused = TAKEN.test(all) ? 'another forward holds the repo' : NO_ADMIN.test(all) ? 'no admin on the repo' : undefined
        return `gh webhook forward failed for ${repo}: ${firstLine}`
      }
      f.up = true
      const upAt = Date.now()
      log(`forwarding ${repo} -> ${url}webhook`)
      // gh-webhook exits on any lost connection (a sleep, a network change), and GitHub deletes its webhook
      p.exited.then(code =>
        serial(() => {
          if (forwarders.get(repo) !== f) return // stopped on purpose
          forwarders.delete(repo)
          fellBehind(repo)
          if (Date.now() - upAt > 60_000) restarts.delete(repo) // it had been working: start counting afresh
          restartLater(repo, `gh webhook forward for ${repo} exited ${code}`)
        }),
      )
      return null
    })().catch(e => `gh webhook forward failed for ${repo}: ${e}`)
    f.ready.then(err =>
      serial(() => {
        if (forwarders.get(repo) !== f) return
        if (!err) {
          // back from polling: catch up from the last poll, which the ids keep from repeating anything
          if (polled.delete(repo)) {
            behind.add(repo)
            for (const k of inRepo(repo)) tell(k, `pr-events: forwarding ${subs.get(k)!.pr} live again`)
          }
          if (behind.delete(repo)) for (const k of inRepo(repo)) catchUp(k).catch(log)
          return
        }
        forwarders.delete(repo)
        if (polled.has(repo)) return // keeps polling; the forward is retried later
        if (f.refused) return poll(repo, f.refused)
        // a restart that failed (offline just after waking, say) keeps its subscriptions and tries again
        if (behind.has(repo)) return restartLater(repo, err)
        // a failed first start takes its waiting subscriptions with it; each subscriber gets the error as its reply
        for (const k of inRepo(repo)) {
          for (const id of subs.get(k)!.sessions) sessions.get(id)?.subs.delete(k)
          subs.delete(k)
          seen.delete(k)
        }
        save()
        armIdle()
      }),
    )
    return f.ready
  }

  // The repo's PRs may have missed events from here on: each catch-up starts where it last had everything, and
  // live events no longer move that point until it has. Called inside serial().
  function fellBehind(repo: string) {
    behind.add(repo)
    for (const k of inRepo(repo)) {
      const c = seen.get(k)
      if (!c) continue
      c.gap ??= c.since
      c.gen = (c.gen ?? 0) + 1
    }
    save()
  }

  // Called inside serial(), with the repo in `behind`. Counts failures per repo, whoever starts the next attempt.
  function restartLater(repo: string, why: string) {
    const tries = restarts.get(repo) ?? 0
    if (tries >= RESTARTS) {
      behind.delete(repo)
      restarts.delete(repo)
      return dropRepo(repo, `${why}, and restarting it failed ${RESTARTS} times; call subscribe_pr again to retry`)
    }
    restarts.set(repo, tries + 1)
    log(`${why}; restarting it (try ${tries + 1})`)
    later(
      () =>
        serial(() => {
          if (forwarders.has(repo)) return
          if (inRepo(repo).length) return ensureForwarder(repo)
          behind.delete(repo) // nothing left to catch up
          restarts.delete(repo)
        }),
      Math.min(60_000, 1000 * 2 ** tries),
    )
  }

  // Called inside serial(). A repo GitHub won't forward to us is caught up from the API every POLL_MS instead, and
  // its forward retried every FORWARD_RETRY_MS.
  function poll(repo: string, why: string) {
    behind.delete(repo)
    restarts.delete(repo)
    if (polled.has(repo)) return
    polled.set(repo, { due: Date.now(), retry: Date.now() + FORWARD_RETRY_MS, swept: 0, why })
    for (const k of inRepo(repo)) tell(k, pollingMsg(subs.get(k)!.pr, why))
  }
  const pollingMsg = (pr: string, why: string) => `pr-events: polling ${pr} every ${POLL_MS / 1000}s (forward unavailable: ${why})`
  const tell = (key: string, content: string) => {
    for (const id of subs.get(key)?.sessions ?? []) deliver(id, { content, meta: { event: 'polling' } })
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
        const repo = k.split('#')[0]
        if (!forwarders.get(repo)?.up && !polled.has(repo)) continue
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
  async function mergeability(repo: string, n: string): Promise<{ base: string; conflicted: boolean; head?: string } | null> {
    // ponytail: mergeable is null while GitHub recomputes after a push; 5 tries 3s apart, then give up silently
    for (let i = 0; i < 5; i++) {
      const [base, m, head] = (await gh('api', `repos/${repo}/pulls/${n}`, '-q', '[.base.ref, .mergeable, .head.sha] | @tsv')).split('\t')
      if (m === 'true' || m === 'false') return { base, conflicted: m === 'false', head: head || undefined }
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
    if (!first || seen.get(key)?.merged) return // a merged PR has nothing left to conflict with
    const [repo, n] = first.pr.split('#')
    const r = await mergeability(repo, n)
    const s = subs.get(key)
    const c = seen.get(key)
    if (c && r?.head) c.head ??= r.head // where a catch-up spots pushes from
    if (!r || !s || (onlyBase && r.base !== onlyBase) || r.conflicted === !!s.conflictBase) return
    s.conflictBase = r.conflicted ? r.base : undefined
    const e = conflictEv(s, r.base, r.conflicted)
    emitTo(key, e.content, e.meta)
  }
  // A force push arrives as an ordinary synchronize; the old head not being an ancestor of the new one gives it away.
  // ponytail: compare failing (e.g. old head gone) reads as a normal push
  const forced = async (repo: string, before: string, after: string) =>
    ['diverged', 'behind'].includes(await gh('api', `repos/${repo}/compare/${before}...${after}`, '-q', '.status'))

  // ---- catching up on what a sleep or a dead forwarder missed, from the PR's own API ----

  // Throws on any failure, or after a minute, so a catch-up that didn't see everything isn't recorded as done.
  // list: every page, flattened. raw: the response with its headers, one page only.
  async function ghApi(args: string[], path: string) {
    if (ghOld) throw new Error(ghOld)
    const p = Bun.spawn([process.env.GH_PR_EVENTS_GH ?? 'gh', 'api', ...args, path], { stdout: 'pipe', stderr: 'pipe', timeout: API_TIMEOUT_MS })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    if (p.signalCode) throw new Error(`gh api ${path} timed out`)
    return { out, code, why: `gh api ${path} failed: ${err.trim().split('\n')[0] || `exit ${code}`}` }
  }
  async function api(path: string, mode?: 'list' | 'raw'): Promise<any> {
    const { out, code, why } = await ghApi(mode === 'list' ? ['--paginate', '--slurp'] : mode === 'raw' ? ['-i'] : [], path)
    if (code !== 0) throw new Error(why)
    if (mode === 'list') return JSON.parse(out).flat()
    if (mode !== 'raw') return JSON.parse(out)
    const i = out.search(/\r?\n\r?\n/)
    return { headers: out.slice(0, i), body: JSON.parse(out.slice(i).trim()) }
  }

  // Whether the resource changed since the last call, by a conditional GET: GitHub answers an unchanged one with a 304,
  // which doesn't count against the rate limit (gh exits 1 on it, headers still printed). wait: how long GitHub asks
  // us to hold off (X-Poll-Interval, or Retry-After on a refusal), in ms.
  // The new ETag is only kept once the caller has caught up (keep()), so a failed catch-up is retried next poll.
  async function changed(path: string): Promise<{ changed: boolean; wait: number; keep: () => void }> {
    const etag = etags.get(path)
    const { out, code, why } = await ghApi(['-i', ...(etag ? ['-H', `If-None-Match: ${etag}`] : [])], path)
    const head = out.split(/\r?\n\r?\n/)[0]
    const h = (name: string) => head.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'im'))?.[1]
    const wait = Math.max(Number(h('x-poll-interval')) || 0, Number(h('retry-after')) || 0) * 1000
    const status = Number(head.match(/^HTTP\/\S+ (\d+)/)?.[1])
    if (status === 304) return { changed: false, wait, keep: () => {} }
    if (code !== 0) throw Object.assign(new Error(why), { wait })
    const e = h('etag')
    return { changed: true, wait, keep: () => e && etags.set(path, e) }
  }

  // One poll of a PR in a polled repo: probes the PR and its head's CI conditionally, and catches up only if either
  // changed (or a full sweep is due, or a gap is open). Returns how long GitHub asked us to wait.
  async function pollPr(key: string, sweep: boolean): Promise<number> {
    const c = seen.get(key)
    const sub = subs.get(key)
    if (!c || !sub) return 0
    const [repo, n] = sub.pr.split('#')
    try {
      const probes = await Promise.all([`repos/${repo}/pulls/${n}`, ...(c.head ? [`repos/${repo}/commits/${c.head}/check-suites`] : [])].map(changed))
      if (sweep || c.gap !== undefined || probes.some(p => p.changed)) await catchUp(key, 0, true)
      probes.forEach(p => p.keep())
      pollFails.delete(key)
      return Math.max(0, ...probes.map(p => p.wait))
    } catch (e: any) {
      const fails = (pollFails.get(key) ?? 0) + 1
      pollFails.set(key, fails)
      log(`poll of ${sub.pr} failed (${e?.message ?? e})`)
      if (fails === 5) emitTo(key, `pr-events could not poll it 5 times in a row: ${e?.message ?? e}`, { event: 'channel_error' })
      return e?.wait ?? 0
    }
  }
  const pollCheck = () => {
    const now = Date.now()
    for (const [repo, p] of polled) {
      if (now >= p.retry) {
        p.retry = now + FORWARD_RETRY_MS
        serial(() => polled.has(repo) && !forwarders.has(repo) && ensureForwarder(repo))
      }
      if (now < p.due || p.busy) continue
      p.busy = true
      const sweep = now - p.swept >= SWEEP_MS
      if (sweep) p.swept = now
      Promise.all(inRepo(repo).map(k => pollPr(k, sweep))).then(w => {
        p.busy = false
        p.due = Date.now() + Math.max(POLL_MS, ...w)
      })
    }
  }

  // A PR's issue events back to `after`. The API lists them oldest first only, so this reads the last page first
  // and stops once past `after`, rather than paging through a long-lived PR's whole history.
  async function issueEvents(path: string, after: number): Promise<any[]> {
    const first = await api(`${path}?per_page=100`, 'raw')
    const last = Number(first.headers.match(/[?&]page=(\d+)>; rel="last"/)?.[1] ?? 1)
    const out: any[] = []
    for (let page = last; page > 1; page--) {
      const items = await api(`${path}?per_page=100&page=${page}`)
      out.unshift(...items)
      if (items.length && Date.parse(items[0].created_at) <= after) return out
    }
    return [...first.body, ...out]
  }

  // Everything that happened on the PR since it last had everything, replayed as the webhooks it missed would have
  // been. A failure leaves the gap open and tries again; the last failure tells the PR's sessions.
  // polling: a routine poll, whose events aren't marked recovered and whose failure the next poll retries.
  async function catchUp(key: string, tries = 0, polling = false): Promise<void> {
    const c = seen.get(key)
    const sub = subs.get(key)
    if (!c || !sub) return
    const from = c.gap ?? c.since
    const gen = c.gen
    const start = Date.now()
    const after = Math.max(from - SLACK_MS, c.at)
    const iso = new Date(after).toISOString()
    const fresh = (t?: string | null) => !!t && Date.parse(t) > after
    const [repo, n] = sub.pr.split('#')
    const pr = Number(n)
    const repository = { full_name: repo }
    try {
      const head = await api(`repos/${repo}/pulls/${n}`)
      const sha: string = head.head.sha
      const [events, comments, reviewComments, reviews, recentRuns] = await Promise.all([
        issueEvents(`repos/${repo}/issues/${n}/events`, after),
        api(`repos/${repo}/issues/${n}/comments?per_page=100&since=${iso}`, 'list'),
        api(`repos/${repo}/pulls/${n}/comments?per_page=100&since=${iso}`, 'list'),
        api(`repos/${repo}/pulls/${n}/reviews?per_page=100`, 'list'),
        // runs started during the gap, on any head the PR had then
        api(`repos/${repo}/actions/runs?per_page=100&created=${encodeURIComponent('>=' + iso)}`, 'list'),
      ])
      // and CI that started before the gap: on the head, and on the old head if it moved (gone after a force push)
      const shas = [...new Set([c.head, sha].filter(Boolean))] as string[]
      const ci = await Promise.all(
        shas.map(async s => {
          const [runs, suites] = await Promise.all([
            api(`repos/${repo}/actions/runs?per_page=100&head_sha=${s}`, 'list').catch(() => []),
            api(`repos/${repo}/commits/${s}/check-suites?per_page=100`, 'list').catch(() => []),
          ])
          return { runs: runs.flatMap((p: any) => p.workflow_runs ?? []), suites: suites.flatMap((p: any) => p.check_suites ?? []) }
        }),
      )
      const runs = [
        ...recentRuns.flatMap((p: any) => p.workflow_runs ?? []).filter((w: any) => w.pull_requests?.some((x: any) => x.number === pr)),
        ...ci.flatMap(x => x.runs),
      ]
      const missed: { t: string; event: string; payload: any }[] = []
      const merges = events.filter((e: any) => e.event === 'merged').map((e: any) => Date.parse(e.created_at))
      const actions: Record<string, string> = {
        merged: 'closed',
        convert_to_draft: 'converted_to_draft',
        added_to_merge_queue: 'enqueued',
        removed_from_merge_queue: 'dequeued',
      }
      for (const e of events) {
        // a merge also logs a closed event at the same moment
        if (!fresh(e.created_at) || (e.event === 'closed' && merges.some((m: number) => Math.abs(m - Date.parse(e.created_at)) < 10_000))) continue
        const pull_request = { html_url: head.html_url, merged: e.event === 'merged', head: head.head }
        missed.push({
          t: e.created_at,
          event: 'pull_request',
          payload: {
            action: actions[e.event] ?? e.event,
            issueEvent: e.id,
            number: pr,
            pull_request,
            repository,
            sender: e.actor,
            label: e.label,
            requested_reviewer: e.requested_reviewer,
            requested_team: e.requested_team,
          },
        })
      }
      for (const cm of comments)
        if (fresh(cm.created_at))
          missed.push({ t: cm.created_at, event: 'issue_comment', payload: { action: 'created', repository, sender: cm.user, issue: { number: pr, pull_request: {} }, comment: cm } })
      for (const cm of reviewComments)
        if (fresh(cm.created_at))
          missed.push({ t: cm.created_at, event: 'pull_request_review_comment', payload: { action: 'created', repository, sender: cm.user, pull_request: { number: pr }, comment: cm } })
      for (const r of reviews)
        if (fresh(r.submitted_at) && r.state !== 'DISMISSED')
          missed.push({
            t: r.submitted_at,
            event: 'pull_request_review',
            payload: { action: 'submitted', repository, sender: r.user, pull_request: { number: pr }, review: { ...r, state: String(r.state).toLowerCase() } },
          })
      for (const w of runs)
        if (w.status === 'completed' && fresh(w.updated_at))
          missed.push({ t: w.updated_at, event: 'workflow_run', payload: { action: 'completed', repository, workflow_run: { ...w, pull_requests: [{ number: pr }] } } })
      for (const s of ci.flatMap(x => x.suites))
        if (s.status === 'completed' && fresh(s.updated_at))
          missed.push({ t: s.updated_at, event: 'check_suite', payload: { action: 'completed', repository, check_suite: { ...s, pull_requests: [{ number: pr }] } } })
      // new commits, from the head commit's author at its commit time
      if (c.head && c.head !== sha) {
        const commit = await api(`repos/${repo}/commits/${sha}`)
        missed.push({
          t: commit.commit?.committer?.date ?? '',
          event: 'pull_request',
          payload: {
            action: 'synchronize',
            number: pr,
            before: c.head,
            after: sha,
            pull_request: { html_url: head.html_url },
            repository,
            sender: { login: commit.author?.login ?? commit.commit?.author?.name ?? 'someone' },
          },
        })
      }
      missed.sort((a, b) => a.t.localeCompare(b.t))
      for (const m of missed) await handle(m.event, m.payload, Date.parse(m.t) || start, polling)
      c.head = sha
      // fell behind again meanwhile (a second sleep): leave the gap for the catch-up that follows
      if (c.gen === gen) {
        c.since = Math.max(c.since, start)
        c.gap = undefined
      }
      prune(c)
      if (missed.length) log(`caught up ${sub.pr} from ${new Date(from).toISOString()}`)
      save()
      recheck(key).catch(log) // the base may have moved meanwhile
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      log(`catch-up for ${sub.pr} failed (${why})`)
      if (polling) throw e
      if (tries < 4 && !ghOld) return later(() => catchUp(key, tries + 1).catch(log), RETRY_MS)
      // the gap stays open, so the next sleep or restart tries again
      emitTo(key, `pr-events could not recover the events missed since ${new Date(from).toISOString()}: ${why}`, { event: 'channel_error' }) // led by the PR's name
    }
  }

  // Forgets delivered events too old for any catch-up window to reach again.
  const prune = (c: Seen) => {
    const keep = Math.min(c.since, c.gap ?? c.since) - 2 * SLACK_MS
    c.done = c.done.filter(d => d.t >= keep)
  }

  // ---- the state changes; only ever called through serial() ----

  // Registers interest at once and returns the forwarder's start to wait on outside the queue.
  function subscribe(id: string, pr: string): { ready: Promise<string | null> } {
    const key = pr.toLowerCase()
    const s = session(id)
    let sub = subs.get(key)
    if (!sub) {
      subs.set(key, (sub = { pr, sessions: new Set() }))
      if (!seen.has(key)) seen.set(key, { since: Date.now(), at: Date.now(), done: [] }) // a restored one keeps its own
      recheck(key).catch(log) // reports a PR that already has conflicts
    }
    sub.sessions.add(id)
    s.subs.set(key, pr)
    save()
    // a later subscriber still hears about a conflict the others were already told about
    if (sub.conflictBase) {
      const e = conflictEv(sub, sub.conflictBase, true)
      deliver(id, { ...e, content: label(sub, e.content) })
    }
    const p = polled.get(key.split('#')[0])
    if (p) deliver(id, { content: pollingMsg(sub.pr, p.why), meta: { event: 'polling' } })
    return { ready: p ? Promise.resolve(null) : ensureForwarder(key.split('#')[0]) }
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
    seen.delete(key)
    pollFails.delete(key)
    const repo = key.split('#')[0]
    if (!inRepo(repo).length) (stopForwarder(repo), polled.delete(repo))
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
      if (!s.expired) (sessions.delete(id), told.delete(id))
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
      const err = await ready
      // it may have been unsubscribed, or closed, while the forwarder started: only claim what the daemon still has.
      // A failed restart keeps it (and retries), so that's no error.
      if (!(await serial(() => s.subs.has(key)))) return { text: err ?? cancelledMsg, isError: true }
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
    let payload: any
    try {
      payload = JSON.parse(body)
    } catch {
      return new Response('ok')
    }
    await handle(req.headers.get('x-github-event') ?? '', payload)
    return new Response('ok')
  }

  // Whether a recovered event was already delivered; if not, records it. A recovered PR action is the live one of
  // the same kind closest to it in time (within MATCH_MS), and each live one stands for one recovered one.
  function deliveredBefore(c: Seen, id: string, payload: any, at: number) {
    if (c.done.some(d => d.id === id)) return true
    if (payload.issueEvent) {
      const a = actionOf(payload)
      const live = c.done
        .filter(d => d.id === a && Math.abs(d.t - at) < MATCH_MS)
        .sort((x, y) => Math.abs(x.t - at) - Math.abs(y.t - at))[0]
      if (live) return ((live.id = id), (live.r = true), true)
    }
    c.done.push({ id, t: at, r: true })
    return false
  }

  // One event, live (HMAC checked) or recovered by a catch-up (fetched from GitHub's API under the user's gh auth;
  // recoveredAt: when it happened).
  async function handle(event: string, payload: any, recoveredAt?: number, polling = false) {
    const recovered = recoveredAt !== undefined
    let e: Event = null
    try {
      e = summarise(event, payload)
    } catch (err) {
      log('summarise failed', event, err)
      return
    }
    const repo = String(payload.repository?.full_name)
    const key = `${repo}#${e?.pr}`.toLowerCase()
    if (event === 'push' && payload.ref?.startsWith('refs/heads/')) {
      const branch = payload.ref.slice('refs/heads/'.length)
      for (const k of inRepo(repo.toLowerCase())) recheck(k, branch).catch(log)
    }
    if (event === 'pull_request' && payload.action === 'synchronize' && subs.has(key) && !recovered) recheck(key).catch(log)
    const c = seen.get(key)
    if (c && event === 'pull_request' && payload.action === 'reopened') c.closed = undefined
    if (c && !recovered) {
      if (c.gap === undefined) c.since = Date.now() // everything up to now has arrived, unless a gap is still open
      if (event === 'pull_request') c.head = payload.pull_request?.head?.sha ?? payload.after ?? c.head
    }
    const wanted = e && subs.has(key)
    log(event, wanted ? 'emitted' : 'ignored', recovered ? '(recovered)' : '')
    if (!e || !wanted) return
    const id = idOf(event, payload)
    if (c && id) {
      if (recovered) {
        if (deliveredBefore(c, id, payload, recoveredAt)) return // saved once the catch-up is done
      } else {
        // live events are never deduped against each other, only against a catch-up that got there first (the
        // event a dying forwarder still hands over, say)
        if (c.done.some(d => d.r && d.id === id)) return
        c.done.push({ id, t: Date.now() })
        prune(c)
        save()
      }
    }
    if (event === 'pull_request' && payload.action === 'synchronize' && (await forced(repo, payload.before, payload.after))) {
      e.text = e.text.replace('New commits pushed by', 'Force-pushed by').replace('\n', ' (history rewritten)\n')
    }
    const text = recovered && !polling ? RECOVERED + e.text : e.text
    const meta = { event, repo, pr: String(e.pr) }
    if (!e.done) emitTo(key, text, meta)
    // closed without merging: it may be reopened, so keep watching for a while (closedCheck ends it)
    else if (!payload.pull_request?.merged && c) {
      c.closed = Date.now()
      save()
      emitTo(key, `${text}\n(still watching for ${REOPEN_HOURS}h in case it's reopened)`, meta)
    }
    // merged: keep watching for late reviews (bots post seconds to minutes after) until closedCheck ends it
    else if (c) {
      c.merged = recoveredAt ?? Date.now()
      save()
      emitTo(key, `${text}\n(still watching for late comments until ${new Date(c.merged + GRACE_MS).toISOString()})`, meta)
    }
    // in one step, so whoever is subscribed when it's applied is told, including a subscribe that was queued
    else serial(() => (emitTo(key, text + '\n(unsubscribed automatically)', meta), unsubscribe(key)))
  }

  // A shim's event stream: what the session is watching, then anything it missed, then live events, until the shim
  // goes away. An ephemeral session's subscriptions go with its stream.
  function events$(id: string, req: Request) {
    const s = session(id)
    const enc = new TextEncoder()
    const watched = () => [...s.subs.values()].join(', ')
    let keepAlive: Timer | undefined
    const closed = () => {
      clearInterval(keepAlive)
      s.streams.delete(send)
      told.set(id, watched()) // its own subscribe_pr calls while connected aren't news when it reconnects
      s.lastSeen = Date.now()
      if (s.ephemeral && !s.streams.size)
        serial(() => {
          if (s.streams.size) return
          for (const k of [...s.subs.keys()]) unsubscribe(k, id)
          sessions.delete(id)
          told.delete(id)
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
        // Bun's fetch drops a stream silent for 300s (a 3.0.0 shim doesn't turn that off), and Bun.serve one silent for 60s
        keepAlive = setInterval(() => {
          try {
            ctrl.enqueue(enc.encode(': keep-alive\n\n'))
          } catch {
            clearInterval(keepAlive)
          }
        }, 30_000)
        s.streams.add(send)
        s.lastSeen = Date.now()
        clearTimeout(idle)
        if (quarantined && !told.has(id))
          send({ content: "pr-events couldn't read its saved subscriptions; if this session had any, call subscribe_pr again", meta: { event: 'channel_error' } })
        const watching = watched()
        // First connect to this daemon: "none" only on a reconnect, so a new session isn't woken just to hear it
        // watches nothing. Back on the same daemon: only if its subscriptions changed or it missed something.
        const news = told.has(id) ? told.get(id) !== watching || s.pending.length || s.dropped || s.expired : watching || req.headers.get('x-reconnect')
        if (news) send({ content: `watching: ${watching || 'none'}`, meta: { event: 'watching' } })
        told.set(id, watching)
        if (s.expired) {
          send({
            content: `pr-events forgot this session's subscriptions after ${hours} away: ${s.expired.prs.join(', ')}. Call subscribe_pr again to resume`,
            meta: { event: 'channel_error' },
          })
          s.expired = undefined
        }
        if (s.dropped) send({ content: `${s.dropped} older pr-events notifications were dropped while this session was away`, meta: { event: 'channel_error' } })
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
  const saved = loadSessions()
  for (const [k, v] of Object.entries((saved['#seen'] ?? {}) as Record<string, any>))
    if (Number.isFinite(v?.since) && Array.isArray(v.done))
      seen.set(k, {
        since: v.since,
        gap: Number.isFinite(v.gap) ? v.gap : undefined,
        at: Number.isFinite(v.at) ? v.at : v.since,
        done: v.done
          .filter((d: any) => typeof d?.id === 'string' && Number.isFinite(d.t))
          .map((d: any) => ({ id: d.id, t: d.t, ...(d.r && { r: true as const }) })),
        head: typeof v.head === 'string' ? v.head : undefined,
        closed: Number.isFinite(v.closed) ? v.closed : undefined,
        merged: Number.isFinite(v.merged) ? v.merged : undefined,
      })
  for (const [id, v] of Object.entries(saved)) {
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
    // nothing ran while no daemon did: catch up once the forwarder is back, and keep retrying it until then
    for (const pr of prs) serial(() => (subscribe(id, pr), fellBehind(pr.toLowerCase().split('#')[0])))
  }
  // after the restored subscribes, which run in this queue too
  serial(() => {
    for (const k of seen.keys()) if (!subs.has(k)) seen.delete(k)
    save()
    armIdle()
  })
  // A timer that fires far later than it should means the machine slept: the forwarders' connections died with it
  // and GitHub has deleted their webhooks, so start them afresh and catch up.
  let tick = Date.now()
  const sleepCheck = () => {
    const late = Date.now() - tick - TICK_MS
    tick = Date.now()
    if (late <= GAP_MS) return
    serial(() => {
      log(`woke after ~${Math.round(late / 1000)}s asleep; restarting forwarders`)
      for (const repo of new Set([...subs.keys()].map(k => k.split('#')[0]))) {
        fellBehind(repo)
        if (polled.has(repo)) continue // its next poll catches up
        restarts.delete(repo)
        stopForwarder(repo)
        ensureForwarder(repo)
      }
    })
  }
  // A PR closed without merging that wasn't reopened in time, or merged with its grace window over, is done with.
  const closedCheck = () => {
    for (const [k, c] of seen) {
      if (c.closed && Date.now() - c.closed > REOPEN_HOURS * 3600_000)
        serial(() => {
          if (!seen.get(k)?.closed || !subs.has(k)) return
          const [repo, n] = subs.get(k)!.pr.split('#')
          emitTo(k, `Still closed after ${REOPEN_HOURS}h; unsubscribed automatically`, { event: 'pull_request', repo, pr: n })
          unsubscribe(k)
        })
      if (c.merged && Date.now() - c.merged > GRACE_MS)
        serial(() => {
          const m = seen.get(k)?.merged
          const sub = subs.get(k)
          if (!m || !sub) return
          const content = `stopped watching ${sub.pr}, merged ${Math.round((Date.now() - m) / 60_000)}m ago`
          for (const id of sub.sessions) deliver(id, { content, meta: { event: 'channel_error' } })
          unsubscribe(k)
        })
    }
  }
  const timers = [
    setInterval(beat, 4 * 60_000), // the Stop hook wants a beat every 15 min
    setInterval(() => serial(expire), Math.max(1000, Math.min(3600_000, ttlMs / 2))),
    // a daemon that daemon.json no longer names can't be found by shims, so it only holds webhooks: step aside
    setInterval(() => !owned() && quit('daemon.json names another daemon'), 5000),
    setInterval(() => (sleepCheck(), closedCheck()), TICK_MS),
    setInterval(pollCheck, Math.min(TICK_MS, POLL_MS)),
  ]
  log(`daemon ${process.pid} ${version} on ${url}`)
  // catching up pages with `gh api --slurp`, which gh 2.48 added
  gh('--version').then(v => {
    const [maj, min] = (v.match(/gh version (\d+)\.(\d+)/) ?? []).slice(1).map(Number)
    if (maj < 2 || (maj === 2 && min < 48)) log((ghOld = `gh ${maj}.${min} is older than 2.48, which catching up after a gap needs; upgrade gh`))
  })

  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= (async () => {
      halting = true // before anything awaits: no restart may start a forwarder now
      waits.forEach(clearTimeout)
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
