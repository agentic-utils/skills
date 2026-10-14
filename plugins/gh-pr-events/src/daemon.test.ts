// Runs real daemons and shims as subprocesses against stand-ins for gh-webhook and gh, so nothing talks to GitHub.
import { afterEach, expect, test } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Subprocess } from 'bun'
import { createServer, type Server } from 'node:http'
import { proof } from './state'

const server = `${import.meta.dir}/server.ts`
const T = 45_000

// Logs "start <pid> <args>" and "stop <pid>" to $FAKE_LOG; FAKE_FAIL=1 makes it die at once like a refused forward.
const fakeForwarder = `#!/bin/bash
if [ -n "$FAKE_FAIL" ]; then echo "fake: forward refused" >&2; exit 1; fi
echo "start $$ $*" >> "$FAKE_LOG"
trap 'kill $c 2>/dev/null; echo "stop $$" >> "$FAKE_LOG"; exit 0' INT TERM
sleep 600 & c=$!
wait $c
`
// The daemon asks gh for mergeability and compare status: answer "no conflict" and "ahead".
const fakeGh = `#!/bin/bash
case "$2" in */compare/*) echo ahead ;; *) printf 'main\\ttrue\\n' ;; esac
`

type Env = { dir: string; env: Record<string, string> }
const procs: Subprocess[] = []
const dirs: string[] = []

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until<T>(what: string, fn: () => T | Promise<T>, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

function setup(extra: Record<string, string> = {}): Env {
  const root = mkdtempSync(`${tmpdir()}/gh-pr-events-test-`)
  dirs.push(root)
  const dir = `${root}/state`
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(`${root}/fwd`, fakeForwarder)
  writeFileSync(`${root}/gh`, fakeGh)
  chmodSync(`${root}/fwd`, 0o755)
  chmodSync(`${root}/gh`, 0o755)
  // run each once: macOS scans a new executable on its first run, which can outlast the daemon's 3s start window
  Bun.spawnSync([`${root}/fwd`], { env: { FAKE_FAIL: '1' }, stderr: 'ignore' })
  Bun.spawnSync([`${root}/gh`, 'api', 'x'], { stdout: 'ignore' })
  const env = {
    ...(process.env as Record<string, string>),
    GH_PR_EVENTS_STATE_DIR: dir,
    GH_PR_EVENTS_FORWARDER: `${root}/fwd`,
    GH_PR_EVENTS_GH: `${root}/gh`,
    FAKE_LOG: `${root}/fwd.log`,
    ...extra,
  }
  delete (env as any).GH_PR_EVENTS_PORT
  delete (env as any).CLAUDE_CODE_SESSION_ID // the runner may itself be inside Claude Code
  delete (env as any).GH_PR_EVENTS_BEAT_DIR
  return { dir, env }
}

// Forwarders by pid, with their args, from the fake's log.
function forwarders(e: Env) {
  const log = existsSync(e.env.FAKE_LOG) ? readFileSync(e.env.FAKE_LOG, 'utf8') : ''
  const started = new Map<number, string>()
  for (const line of log.split('\n')) {
    const [what, pid, ...args] = line.split(' ')
    if (what === 'start') started.set(Number(pid), args.join(' '))
  }
  return started
}
const running = (e: Env) => [...forwarders(e)].filter(([pid]) => alive(pid))
// the fake logs its start once bash runs it, which macOS can delay past the daemon's 3s check by scanning the new script
const up = (e: Env, n = 1) => until(`${n} forwarder(s)`, () => (running(e).length === n ? running(e) : null))
const secretOf = (args: string) => args.match(/--secret=(\S+)/)![1]

function spawnDaemon(e: Env) {
  const p = Bun.spawn(['bun', server, 'daemon'], { env: e.env, stdout: 'ignore', stderr: 'ignore' })
  procs.push(p)
  return p
}

type Daemon = { p: Subprocess; port: number; token: string; pid: number }
async function daemon(e: Env): Promise<Daemon> {
  const p = spawnDaemon(e)
  const info = await until('daemon.json', () => {
    try {
      const d = JSON.parse(readFileSync(`${e.dir}/daemon.json`, 'utf8'))
      return d.pid === p.pid ? d : null
    } catch {
      return null
    }
  })
  return { p, port: info.port, token: info.token, pid: p.pid }
}

const req = (d: Daemon, path: string, sid: string | null, init: RequestInit = {}, token = d.token) =>
  fetch(`http://127.0.0.1:${d.port}${path}`, {
    ...init,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(sid && { 'x-claude-session': sid }), 'content-type': 'application/json' },
  })
const call = async (d: Daemon, sid: string, name: string, pr: string) =>
  (await req(d, '/call', sid, { method: 'POST', body: JSON.stringify({ name, arguments: { pr } }) })).json() as Promise<{ text: string; isError?: boolean }>

// An open /events stream; collects the events it receives.
function stream(d: Daemon, sid: string, headers: Record<string, string> = {}) {
  const ac = new AbortController()
  const got: { content: string; meta: Record<string, string> }[] = []
  let connected = false
  const done = (async () => {
    const r = await fetch(`http://127.0.0.1:${d.port}/events`, {
      headers: { authorization: `Bearer ${d.token}`, 'x-claude-session': sid, ...headers },
      signal: ac.signal,
    })
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of r.body!) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (frame.startsWith(': connected')) connected = true
        if (frame.startsWith('data: ')) got.push(JSON.parse(frame.slice(6)))
      }
    }
  })().catch(() => {})
  return { got, connected: () => connected, close: () => (ac.abort(), done) }
}

let commentId = 0
async function comment(d: Daemon, secret: string, pr = 'o/r#7') {
  const [repo, n] = pr.split('#')
  const id = ++commentId
  const body = JSON.stringify({
    action: 'created',
    repository: { full_name: repo },
    sender: { login: 'amy' },
    issue: { number: Number(n), pull_request: {} },
    comment: { html_url: `https://github.com/${repo}/pull/${n}#c${id}`, body: `hello ${id}` },
  })
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  const r = await fetch(`http://127.0.0.1:${d.port}/webhook`, {
    method: 'POST',
    body,
    headers: { 'x-github-event': 'issue_comment', 'x-hub-signature-256': sig },
  })
  expect(r.status).toBe(200)
  return `hello ${id}`
}

afterEach(async () => {
  const ps = procs.splice(0)
  for (const p of ps) p.kill('SIGTERM')
  await Promise.all(ps.map(p => p.exited))
  for (const dir of dirs.splice(0)) {
    // detached daemons (started by a shim) and any forwarder still up
    try {
      const pid = JSON.parse(readFileSync(`${dir}/state/daemon.json`, 'utf8')).pid
      process.kill(pid, 'SIGTERM')
      await until('detached daemon to exit', () => !alive(pid), 30_000)
    } catch {}
    const e = { env: { FAKE_LOG: `${dir}/fwd.log` } } as Env
    await until('forwarders to stop', () => running(e).length === 0, 15_000).catch(() => {
      for (const [pid] of running(e)) process.kill(pid, 'SIGKILL')
    })
    rmSync(dir, { recursive: true, force: true })
  }
})

test(
  'two sessions on one PR share one forwarder and both get the event',
  async () => {
    const e = setup()
    const d = await daemon(e)
    const [a, b] = [stream(d, 'sess-a'), stream(d, 'sess-b')]
    await until('streams', () => a.connected() && b.connected())
    const replies = await Promise.all([call(d, 'sess-a', 'subscribe_pr', 'o/r#7'), call(d, 'sess-b', 'subscribe_pr', 'https://github.com/o/r/pull/7')])
    for (const r of replies) expect(r).toEqual({ text: 'subscribed: o/r#7' })
    const [[, args]] = await up(e)
    expect(forwarders(e).size).toBe(1)
    expect(args).toContain('--repo=o/r')
    const text = await comment(d, secretOf(args))
    await until('both deliveries', () => a.got.length && b.got.length)
    for (const s of [a, b]) {
      expect(s.got).toHaveLength(1)
      expect(s.got[0].content).toContain(text)
      expect(s.got[0].meta).toEqual({ event: 'issue_comment', repo: 'o/r', pr: '7' })
    }
    await Promise.all([a.close(), b.close()])
  },
  T,
)

test(
  'an event for a session with no open stream is queued and delivered when it reconnects',
  async () => {
    const e = setup()
    const d = await daemon(e)
    expect((await call(d, 'sess-q', 'subscribe_pr', 'o/r#7')).isError).toBeUndefined()
    const text = await comment(d, secretOf((await up(e))[0][1]))
    await until('queued on disk', () => readFileSync(`${e.dir}/sessions.json`, 'utf8').includes(text))
    const s = stream(d, 'sess-q')
    await until('queued delivery', () => s.got.length === 2)
    expect(s.got[0]).toEqual({ content: 'watching: o/r#7', meta: { event: 'watching' } }) // what it's subscribed to, first
    expect(s.got[1].content).toContain(text)
    await until('queue cleared on disk', () => !readFileSync(`${e.dir}/sessions.json`, 'utf8').includes(text))
    await s.close()
  },
  T,
)

test(
  'a restarted daemon restores subscriptions and restarts their forwarders',
  async () => {
    const e = setup()
    const d1 = await daemon(e)
    await call(d1, 'sess-r', 'subscribe_pr', 'o/r#7')
    const [[first]] = await up(e)
    d1.p.kill('SIGTERM')
    await d1.p.exited
    expect(alive(first)).toBe(false) // its webhook went with it
    const d2 = await daemon(e)
    const [[second, args]] = await until('restarted forwarder', () => {
      const r = running(e)
      return r.length === 1 && r[0][0] !== first ? r : null
    })
    expect(second).not.toBe(first)
    expect(args).toContain('--repo=o/r')
    await until('forwarder up', async () => (await call(d2, 'sess-r', 'subscribe_pr', 'o/r#7')).text === 'subscribed: o/r#7')
    const text = await comment(d2, secretOf(args))
    const s = stream(d2, 'sess-r')
    await until('delivery after restart', () => s.got.some(g => g.content.includes(text)))
    expect(forwarders(e).size).toBe(2)
    await s.close()
  },
  T,
)

test(
  'a forwarder that fails to start gives every waiting subscriber the error',
  async () => {
    const e = setup({ FAKE_FAIL: '1' })
    const d = await daemon(e)
    const replies = await Promise.all(['sess-1', 'sess-2', 'sess-3'].map(s => call(d, s, 'subscribe_pr', 'o/r#7')))
    for (const r of replies) {
      expect(r.isError).toBe(true)
      expect(r.text).toBe('gh webhook forward failed for o/r: fake: forward refused')
    }
    // nothing is left subscribed: unsubscribing reports none
    expect((await call(d, 'sess-1', 'unsubscribe_pr', 'o/r#7')).text).toBe('subscribed: none')
  },
  T,
)

test(
  'unsubscribing while the forwarder starts leaves nothing running and the subscribe fails',
  async () => {
    const e = setup()
    const d = await daemon(e)
    const sub = call(d, 'sess-u', 'subscribe_pr', 'o/r#7')
    // the daemon records the pid at spawn, before the 3s start window ends
    await until('forwarder spawned', () => existsSync(`${e.dir}/forwarders.json`) && readFileSync(`${e.dir}/forwarders.json`, 'utf8').length > 2)
    expect((await call(d, 'sess-u', 'unsubscribe_pr', 'o/r#7')).text).toBe('subscribed: none')
    expect(await sub).toEqual({ text: 'unsubscribed while the forwarder started', isError: true })
    await until('forwarder stopped', () => running(e).length === 0)
    // and a fresh subscribe afterwards starts a new one
    expect(await call(d, 'sess-u', 'subscribe_pr', 'o/r#7')).toEqual({ text: 'subscribed: o/r#7' })
    await up(e)
  },
  T,
)

test(
  'requests without the token get 401, and without a session id 400',
  async () => {
    const e = setup()
    const d = await daemon(e)
    for (const path of ['/events', '/call', '/shutdown']) {
      expect((await req(d, path, 's', { method: 'POST' }, '')).status).toBe(401)
      expect((await req(d, path, 's', { method: 'POST' }, 'x'.repeat(64))).status).toBe(401)
    }
    expect((await req(d, '/events', null)).status).toBe(400)
    expect((await req(d, '/call', null, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await req(d, '/call', 'bad id!', { method: 'POST', body: '{}' })).status).toBe(400)
    // /info needs no token, only a challenge, which it answers with a proof that it holds the token
    expect((await req(d, '/info', null, {}, '')).status).toBe(400)
    const c = randomBytes(16).toString('hex')
    const info = await (await fetch(`http://127.0.0.1:${d.port}/info`, { headers: { 'x-challenge': c } })).json()
    expect(info).toEqual({ version: expect.any(String), pid: d.pid, proof: proof(d.token, c) })
    // a webhook with a bad signature is refused too
    const r = await fetch(`http://127.0.0.1:${d.port}/webhook`, { method: 'POST', body: '{}', headers: { 'x-hub-signature-256': 'sha256=00' } })
    expect(r.status).toBe(401)
  },
  T,
)

test(
  'several daemons started at once leave exactly one running',
  async () => {
    const e = setup()
    const ps = Array.from({ length: 5 }, () => spawnDaemon(e))
    await until('losers to exit', () => ps.filter(p => p.exitCode === null).length === 1)
    const winner = ps.find(p => p.exitCode === null)!
    for (const p of ps) if (p !== winner) expect(p.exitCode).toBe(0)
    const info = JSON.parse(readFileSync(`${e.dir}/daemon.json`, 'utf8'))
    expect(info.pid).toBe(winner.pid)
    const r = await fetch(`http://127.0.0.1:${info.port}/info`, { headers: { 'x-challenge': 'ab'.repeat(16) } })
    expect((await r.json()).pid).toBe(winner.pid)
  },
  T,
)

// A shim on stdio, as Claude Code runs it; script is server.ts or a copy of it.
function shim(e: Env, env: Record<string, string> = {}, script = server) {
  const p = Bun.spawn(['bun', script], { env: { ...e.env, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  procs.push(p)
  const msgs: any[] = []
  ;(async () => {
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        msgs.push(JSON.parse(buf.slice(0, i)))
        buf = buf.slice(i + 1)
      }
    }
  })()
  const send = (m: object) => (p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'), p.stdin.flush())
  const reply = (id: number) => until(`reply ${id}`, () => msgs.find(m => m.id === id), 30_000)
  const notes = () => msgs.filter(m => m.method === 'notifications/claude/channel').map(m => m.params)
  const begin = () => {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    send({ method: 'notifications/initialized' })
  }
  let n = 100
  const tool = async (name: string, pr: string) => {
    const id = ++n
    send({ id, method: 'tools/call', params: { name, arguments: { pr } } })
    return (await reply(id)).result
  }
  return { p, msgs, send, reply, notes, begin, tool }
}
const daemonInfo = (e: Env) => JSON.parse(readFileSync(`${e.dir}/daemon.json`, 'utf8'))

test(
  'the shim speaks MCP over stdio and relays events as channel notifications',
  async () => {
    const e = setup()
    const { p, msgs, send, reply } = shim(e, { CLAUDE_CODE_SESSION_ID: 'sess-shim' })

    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    const init = await reply(1)
    expect(init.result.serverInfo.name).toBe('gh-pr-events')
    expect(init.result.capabilities.experimental).toEqual({ 'claude/channel': {} })
    expect(init.result.instructions).toContain('subscribe_pr')
    send({ method: 'notifications/initialized' })

    send({ id: 2, method: 'tools/list' })
    expect((await reply(2)).result.tools.map((t: any) => t.name)).toEqual(['subscribe_pr', 'unsubscribe_pr'])

    send({ id: 3, method: 'tools/call', params: { name: 'subscribe_pr', arguments: { pr: 'o/r#7' } } })
    expect((await reply(3)).result).toEqual({ content: [{ type: 'text', text: 'subscribed: o/r#7' }] })

    const info = daemonInfo(e)
    const text = await comment({ p, pid: info.pid, port: info.port, token: info.token }, secretOf((await up(e))[0][1]))
    const note = await until('channel notification', () => msgs.find(m => m.method === 'notifications/claude/channel'))
    expect(note.params.content).toContain(text)
    expect(note.params.meta).toEqual({ event: 'issue_comment', repo: 'o/r', pr: '7' })

    send({ id: 4, method: 'nope' })
    expect((await reply(4)).error.code).toBe(-32601)
    p.stdin.end()
    expect(await p.exited).toBe(0)
  },
  T,
)

// ---- which daemon is the real one ----

// Something on a port daemon.json names that isn't our daemon: answers everything, records whether it saw a token.
function impostor(answer: (path: string, challenge: string) => object = () => ({})) {
  const seen = { auth: 0, hits: 0 }
  const srv: Server = createServer((rq, rs) => {
    seen.hits++
    if (rq.headers.authorization) seen.auth++
    rs.setHeader('content-type', 'application/json')
    rs.end(JSON.stringify(answer(rq.url!, String(rq.headers['x-challenge'] ?? ''))))
  })
  return new Promise<{ port: number; seen: typeof seen; close: () => void }>(ok =>
    srv.listen(0, '127.0.0.1', () => ok({ port: (srv.address() as any).port, seen, close: () => srv.close() })),
  )
}
const deadPid = async () => {
  const p = Bun.spawn(['true'])
  await p.exited
  return p.pid
}
const sleeper = () => {
  const p = Bun.spawn(['sleep', '60'])
  procs.push(p)
  return p.pid
}

test(
  'a shim never sends its token to something that cannot prove it holds it, and starts a real daemon instead',
  async () => {
    const e = setup()
    const fake = await impostor(() => ({ version: '999.0.0', pid: 1, proof: 'nope' }))
    writeFileSync(`${e.dir}/daemon.json`, JSON.stringify({ pid: await deadPid(), port: fake.port, token: 'f'.repeat(64), version: '999.0.0' }))
    const s = shim(e, { CLAUDE_CODE_SESSION_ID: 'sess-imp' })
    s.begin()
    expect(await s.tool('subscribe_pr', 'o/r#7')).toEqual({ content: [{ type: 'text', text: 'subscribed: o/r#7' }] })
    expect(fake.seen.hits).toBeGreaterThan(0)
    expect(fake.seen.auth).toBe(0)
    expect(daemonInfo(e).port).not.toBe(fake.port)
    fake.close()
  },
  T,
)

test(
  'a daemon that is running but not answering is not replaced; one daemon.json stops naming steps aside',
  async () => {
    const e = setup()
    const d1 = await daemon(e)
    process.kill(d1.pid, 'SIGSTOP') // alive, but answers nothing
    try {
      const c = spawnDaemon(e)
      expect(await c.exited).toBe(0) // lost the election
      expect(daemonInfo(e).pid).toBe(d1.pid)
    } finally {
      process.kill(d1.pid, 'SIGCONT')
    }
    // daemon.json now names a live process that isn't a daemon (a reused pid): a new daemon takes over...
    writeFileSync(`${e.dir}/daemon.json`, JSON.stringify({ ...daemonInfo(e), pid: sleeper() }))
    const d2 = await daemon(e)
    // ...and the old one, no longer named, exits on its next check
    await until('old daemon to exit', () => d1.p.exitCode !== null, 15_000)
    expect(d1.p.exitCode).toBe(0)
    expect(alive(d2.pid)).toBe(true)
    expect(daemonInfo(e).pid).toBe(d2.pid)
  },
  T,
)

test(
  'after an update the newest version serves at once, and an older shim waits for it rather than starting its own',
  async () => {
    const e = setup()
    const root = mkdtempSync(`${tmpdir()}/gh-pr-events-test-`)
    dirs.push(root)
    cpSync(import.meta.dir, `${root}/gh-pr-events/src`, { recursive: true }) // the daemon check wants gh-pr-events in its path
    const meta = JSON.parse(readFileSync(`${import.meta.dir}/../plugin.json`, 'utf8'))
    writeFileSync(`${root}/gh-pr-events/plugin.json`, JSON.stringify({ ...meta, version: '99.0.0' }))

    const d1 = await daemon(e)
    const t0 = Date.now()
    const s99 = shim(e, { CLAUDE_CODE_SESSION_ID: 'sess-new' }, `${root}/gh-pr-events/src/server.ts`)
    s99.begin()
    await until('99.0.0 serving', () => existsSync(`${e.dir}/daemon.json`) && daemonInfo(e).version === '99.0.0')
    expect(Date.now() - t0).toBeLessThan(4000) // replaced and started in one go, no waiting out a retry interval
    expect(await d1.p.exited).toBe(0)
    expect(JSON.parse(readFileSync(`${e.dir}/latest.json`, 'utf8'))).toEqual({ version: '99.0.0' })
    expect(readFileSync(`${e.dir}/daemon.log`, 'utf8')).not.toContain('another daemon is already running')

    // the 99.0.0 daemon dies; an old shim asking now waits while the 99.0.0 shim brings its daemon back
    const pid99 = daemonInfo(e).pid
    process.kill(pid99, 'SIGTERM')
    await until('99.0.0 daemon to exit', () => !alive(pid99))
    const old = shim(e, { CLAUDE_CODE_SESSION_ID: 'sess-old' })
    old.begin()
    expect((await old.tool('subscribe_pr', 'o/r#7')).content[0].text).toBe('subscribed: o/r#7')
    expect(daemonInfo(e).version).toBe('99.0.0')
    expect(JSON.parse(readFileSync(`${e.dir}/latest.json`, 'utf8'))).toEqual({ version: '99.0.0' })
  },
  T,
)

test(
  'a recorded newer version with no shim to start it is given up on after about 10s (rollback)',
  async () => {
    const e = setup()
    writeFileSync(`${e.dir}/latest.json`, JSON.stringify({ version: '99.0.0' }))
    const own = JSON.parse(readFileSync(`${import.meta.dir}/../plugin.json`, 'utf8')).version
    const s = shim(e, { CLAUDE_CODE_SESSION_ID: 'sess-rb' })
    const t0 = Date.now()
    s.begin()
    expect((await s.tool('subscribe_pr', 'o/r#7')).content[0].text).toBe('subscribed: o/r#7')
    const took = Date.now() - t0
    expect(took).toBeGreaterThan(9000)
    expect(took).toBeLessThan(20_000)
    expect(daemonInfo(e).version).toBe(own)
    expect(JSON.parse(readFileSync(`${e.dir}/latest.json`, 'utf8'))).toEqual({ version: own })
  },
  T,
)

test(
  'a latest.json naming this version (even with a stale path from 2.0.0) holds nothing up',
  async () => {
    const e = setup()
    const own = JSON.parse(readFileSync(`${import.meta.dir}/../plugin.json`, 'utf8')).version
    writeFileSync(`${e.dir}/latest.json`, JSON.stringify({ version: own, path: '/nonexistent/broken/server.js' }))
    const s = shim(e, { CLAUDE_CODE_SESSION_ID: 'sess-same' })
    const t0 = Date.now()
    s.begin()
    expect((await s.tool('subscribe_pr', 'o/r#7')).content[0].text).toBe('subscribed: o/r#7')
    expect(Date.now() - t0).toBeLessThan(8000) // most of that is the forwarder's 3s start window
    expect(daemonInfo(e).version).toBe(own)
  },
  T,
)

test(
  'a shim fails calls fast while the daemon is alive but hung, and kills it once that lasts',
  async () => {
    const e = setup()
    const d1 = await daemon(e)
    process.kill(d1.pid, 'SIGSTOP')
    const s = shim(e, { CLAUDE_CODE_SESSION_ID: 'sess-hung', GH_PR_EVENTS_HUNG_MS: '2000' })
    s.begin()
    const t0 = Date.now()
    const first = await s.tool('subscribe_pr', 'o/r#7')
    expect(Date.now() - t0).toBeLessThan(4000)
    expect(first.isError).toBe(true)
    expect(first.content[0].text).toContain('running but not answering')
    await Bun.sleep(2500)
    // still hung past the threshold: SIGTERM (which a stopped process can't act on), then SIGKILL, then a new daemon
    expect((await s.tool('subscribe_pr', 'o/r#7')).content[0].text).toBe('subscribed: o/r#7')
    expect(d1.p.signalCode).toBe('SIGKILL')
    expect(daemonInfo(e).pid).not.toBe(d1.pid)
  },
  60_000,
)

// ---- what Claude sees ----

test(
  'the shim passes on only whitelisted notification fields, and retries a call lost to a dropped connection',
  async () => {
    const e = setup()
    const token = 'a'.repeat(64)
    const pid = sleeper()
    let calls = 0
    const frames = [
      { content: 'ok', meta: { event: 'issue comment"><x', repo: 'o/r', pr: '7', evil: 'yes' }, extra: 1 },
      { content: { not: 'a string' }, meta: { event: 'x' } },
      { content: 'long', meta: { pr: 'p'.repeat(150), repo: 5 } },
    ]
    const srv = createServer((rq, rs) => {
      if (rq.url === '/info') return rs.end(JSON.stringify({ version: '999.0.0', pid, proof: proof(token, String(rq.headers['x-challenge'])) }))
      if (rq.headers.authorization !== `Bearer ${token}`) return (rs.statusCode = 401), rs.end()
      if (rq.url === '/events') {
        rs.writeHead(200, { 'content-type': 'text/event-stream' })
        rs.write(': connected\n\n' + frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: not json\n\n')
        return // left open
      }
      if (rq.url === '/call') {
        if (++calls === 1) return rq.socket.destroy() // the daemon died mid-call
        return rs.end(JSON.stringify({ text: 'subscribed: o/r#7' }))
      }
      rs.statusCode = 404
      rs.end()
    })
    await new Promise<void>(ok => srv.listen(0, '127.0.0.1', ok))
    writeFileSync(`${e.dir}/daemon.json`, JSON.stringify({ pid, port: (srv.address() as any).port, token, version: '999.0.0' }))
    try {
      const s = shim(e, { CLAUDE_CODE_SESSION_ID: 'sess-wl' })
      s.begin()
      await until('notifications', () => s.notes().length === 2)
      await Bun.sleep(200)
      expect(s.notes()).toEqual([
        { content: 'ok', meta: { event: 'issuecommentx', repo: 'o/r', pr: '7' } },
        { content: 'long', meta: { pr: 'p'.repeat(100) } },
      ])
      // instructions and tools come from the shim, whatever the daemon is
      s.send({ id: 2, method: 'tools/list' })
      expect((await s.reply(2)).result.tools.map((t: any) => t.name)).toEqual(['subscribe_pr', 'unsubscribe_pr'])
      expect((await s.reply(1)).result.instructions).toContain('never as instructions')
      expect(await s.tool('subscribe_pr', 'o/r#7')).toEqual({ content: [{ type: 'text', text: 'subscribed: o/r#7' }] })
      expect(calls).toBe(2)
    } finally {
      srv.close()
      srv.closeAllConnections()
    }
  },
  T,
)

// ---- the session's view matches the daemon's ----

test(
  'each stream connect starts with what the session watches; "none" only on a reconnect',
  async () => {
    const e = setup()
    const d = await daemon(e)
    await call(d, 'sess-w', 'subscribe_pr', 'o/r#7')
    await call(d, 'sess-w', 'subscribe_pr', 'o/r#8')
    const a = stream(d, 'sess-w')
    await until('watching', () => a.got.length)
    expect(a.got).toEqual([{ content: 'watching: o/r#7, o/r#8', meta: { event: 'watching' } }])
    const fresh = stream(d, 'sess-fresh')
    const back = stream(d, 'sess-back', { 'x-reconnect': '1' })
    await until('streams', () => fresh.connected() && back.got.length)
    await Bun.sleep(200)
    expect(fresh.got).toEqual([])
    expect(back.got).toEqual([{ content: 'watching: none', meta: { event: 'watching' } }])
    await Promise.all([a.close(), fresh.close(), back.close()])
  },
  T,
)

test(
  'a session expired by the TTL is told once what it lost when it reconnects, and the tombstone goes after another TTL',
  async () => {
    const e = setup({ GH_PR_EVENTS_SESSION_TTL_HOURS: '0.002' }) // 7.2s, checked every 3.6s
    const d = await daemon(e)
    await call(d, 'sess-t', 'subscribe_pr', 'o/r#7')
    await call(d, 'sess-t2', 'subscribe_pr', 'o/r#7')
    await up(e)
    await until('expiry stops the forwarder', () => running(e).length === 0)
    const s = stream(d, 'sess-t')
    await until('tombstone notice', () => s.got.length)
    await Bun.sleep(200)
    expect(s.got).toHaveLength(1)
    expect(s.got[0].meta).toEqual({ event: 'channel_error' })
    expect(s.got[0].content).toContain('forgot this session')
    expect(s.got[0].content).toContain('o/r#7')
    await s.close()
    const again = stream(d, 'sess-t')
    await until('reconnected', () => again.connected())
    await Bun.sleep(200)
    expect(again.got).toEqual([]) // told once
    await again.close()
    // sess-t2 never came back: its tombstone is kept for one more TTL, then dropped
    expect(readFileSync(`${e.dir}/sessions.json`, 'utf8')).toContain('sess-t2')
    await until('tombstone dropped', () => !readFileSync(`${e.dir}/sessions.json`, 'utf8').includes('sess-t2'), 25_000)
  },
  60_000,
)

test(
  'without CLAUDE_CODE_SESSION_ID a session keeps its subscriptions only while its stream is open',
  async () => {
    const e = setup()
    const s = shim(e)
    s.begin()
    expect((await s.tool('subscribe_pr', 'o/r#7')).content[0].text).toBe('subscribed: o/r#7')
    await up(e)
    expect(readFileSync(`${e.dir}/sessions.json`, 'utf8')).not.toContain('o/r#7') // and never persisted
    s.p.stdin.end()
    await s.p.exited
    await until('forwarder stopped with the stream', () => running(e).length === 0)
  },
  T,
)

// ---- sessions.json ----

test(
  'an unreadable sessions.json is set aside, and entries that are not objects are skipped',
  async () => {
    const e = setup()
    writeFileSync(`${e.dir}/sessions.json`, '{"sess-a": {"subs": [')
    const d0 = await daemon(e)
    const aside = readdirSync(e.dir).filter(f => f.startsWith('sessions.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(`${e.dir}/${aside[0]}`, 'utf8')).toBe('{"sess-a": {"subs": [')
    // every session is told once, on its first connect to this daemon
    for (const sid of ['sess-a', 'sess-b']) {
      const first = stream(d0, sid)
      await until('quarantine notice', () => first.got.length)
      await Bun.sleep(200)
      expect(first.got).toEqual([
        { content: "gh-pr-events couldn't read its saved subscriptions; if this session had any, call subscribe_pr again", meta: { event: 'channel_error' } },
      ])
      await first.close()
    }
    const again = stream(d0, 'sess-a')
    await until('reconnected', () => again.connected())
    await Bun.sleep(200)
    expect(again.got).toEqual([])
    await again.close()

    const e2 = setup()
    const saved = { 'sess-n': 5, 'sess-null': null, 'sess-arr': [1], 'sess-ok': { subs: ['o/r#7', 7], lastSeen: Date.now() } }
    writeFileSync(`${e2.dir}/sessions.json`, JSON.stringify(saved))
    const d = await daemon(e2)
    const [[, args]] = await up(e2) // the good entry's subscription resumed
    expect(args).toContain('--repo=o/r')
    expect(alive(d.pid)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(`${e2.dir}/sessions.json`, 'utf8')))).toEqual(['sess-ok'])
  },
  T,
)

// ---- smaller items ----

test(
  'requests with a foreign Host or any Origin are refused, and so are oversized bodies',
  async () => {
    const e = setup()
    const d = await daemon(e)
    const info = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${d.port}/info`, { headers: { 'x-challenge': 'ab'.repeat(16), ...headers } })
    expect((await info({})).status).toBe(200)
    expect((await info({ origin: 'https://evil.example' })).status).toBe(403)
    expect((await info({ host: `localhost:${d.port}` })).status).toBe(403)
    const big = await fetch(`http://127.0.0.1:${d.port}/webhook`, { method: 'POST', body: 'x'.repeat(26 * 1024 * 1024) }).catch(() => null)
    expect(big === null || big.status === 413).toBe(true)
  },
  T,
)

test(
  'the overflow notice counts every dropped event, across overflows',
  async () => {
    const e = setup()
    const d = await daemon(e)
    await call(d, 'sess-o', 'subscribe_pr', 'o/r#7')
    const secret = secretOf((await up(e))[0][1])
    for (let i = 0; i < 102; i++) await comment(d, secret)
    await until('first overflow saved', () => JSON.parse(readFileSync(`${e.dir}/sessions.json`, 'utf8'))['sess-o'].dropped === 2)
    let last = ''
    for (let i = 0; i < 3; i++) last = await comment(d, secret)
    const s = stream(d, 'sess-o')
    await until('all delivered', () => s.got.length === 102)
    expect(s.got[0].content).toBe('watching: o/r#7')
    expect(s.got[1].content).toBe('5 older gh-pr-events notifications were dropped while this session was away')
    expect(s.got[101].content).toContain(last)
    await s.close()
  },
  T,
)
