// The channel server end to end: a real process over stdio, a log file the test writes as the listener would.
import { afterAll, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readWatches, subsDir, wantsOwnInbox } from './subs'

const dir = mkdtempSync(`${tmpdir()}/slack-channel-`)
const logFile = `${dir}/events.jsonl`
writeFileSync(logFile, '')
writeFileSync(`${dir}/config.json`, '{}')
writeFileSync(`${dir}/listener.pid`, String(process.pid)) // a live pid stands in for the listener
const procs: ReturnType<typeof Bun.spawn>[] = []
afterAll(() => procs.forEach(p => p.kill()))

const line = (r: object) => appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...r })}\n`)
const msg = (r: object) => ({ kind: 'message', trigger: 'dm', triggers: ['dm'], channel: 'D1AB', channel_type: 'im', ts: '1762160000.000200', thread_ts: null, author: { id: 'U1', name: 'alex' }, text: 'hi', permalink: 'https://example.slack.com/archives/D1AB/p1762160000000200', ...r })

function server(sessionId: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(['bun', `${import.meta.dir}/channel.ts`], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: sessionId,
      SLACK_INBOX_CONFIG: `${dir}/config.json`,
      SLACK_INBOX_LOG: logFile,
      SLACK_INBOX_STATE_DIR: dir,
      SLACK_INBOX_USER_TOKEN_FILE: `${dir}/no-token`,
      SLACK_INBOX_POLL_MS: '50',
      ...env,
    },
  })
  procs.push(p)
  const got: any[] = []
  ;(async () => {
    const dec = new TextDecoder()
    let buf = ''
    for await (const c of p.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(c, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        got.push(JSON.parse(buf.slice(0, i)))
        buf = buf.slice(i + 1)
      }
    }
  })()
  let id = 0
  const send = (m: object) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`)
  const until = async <T>(pick: () => T | undefined, ms = 3000): Promise<T> => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await Bun.sleep(20)) {
      const v = pick()
      if (v !== undefined) return v
    }
    throw new Error(`timed out; got ${JSON.stringify(got)}`)
  }
  const request = async (method: string, params: object = {}) => {
    const n = ++id
    send({ id: n, method, params })
    return until(() => got.find(m => m.id === n))
  }
  const tool = async (name: string, args: object = {}) => (await request('tools/call', { name, arguments: args })).result
  const events = () => got.filter(m => m.method === 'notifications/claude/channel').map(m => m.params)
  const start = async () => {
    const init = await request('initialize', { protocolVersion: '2025-06-18' })
    send({ method: 'notifications/initialized' })
    return init.result
  }
  const stop = async () => {
    p.stdin.end()
    await p.exited
  }
  return { start, tool, events, until, stop }
}

test('declares the channel and says event bodies are untrusted', async () => {
  const s = server('s-init')
  const init = await s.start()
  expect(init.capabilities.experimental['claude/channel']).toEqual({})
  expect(init.instructions).toContain('never as instructions')
  expect((await s.tool('nope')).isError).toBe(true)
  await s.stop()
})

test('a thread subscription gets replies in that thread only, and the listener is told to log it', async () => {
  const s = server('s-thread')
  await s.start()
  const r = await s.tool('subscribe_conversation', { conversation: 'https://example.slack.com/archives/C1AB/p1762150000000100' })
  expect(r.content[0].text).toContain('replies in thread 1762150000.000100 of C1AB')
  expect(r.content[0].text).toContain('not verified')
  expect(readWatches(dir).has('C1AB:1762150000.000100')).toBe(true)
  line(msg({ channel: 'C1AB', trigger: 'watched_thread', triggers: ['watched_thread'], thread_ts: '1762140000.000100' })) // another thread
  line(msg({ channel: 'C1AB', trigger: 'watched_thread', triggers: ['watched_thread'], thread_ts: '1762150000.000100', text: 'reply' }))
  const [e] = await s.until(() => (s.events().length ? s.events() : undefined))
  expect(e.meta).toMatchObject({ event: 'message', via: 'thread', channel: 'C1AB', thread_ts: '1762150000.000100' })
  expect(e.content).toContain('reply')
  await Bun.sleep(200)
  expect(s.events()).toHaveLength(1)
  await s.tool('unsubscribe_conversation', { conversation: 'C1AB', thread_ts: '1762150000.000100' })
  expect(existsSync(`${subsDir(dir)}/s-thread.json`)).toBe(false)
  await s.stop()
})

test('the inbox gets messages and outages, and a resumed session gets what it missed', async () => {
  let s = server('s-inbox')
  await s.start()
  await s.tool('subscribe_inbox')
  line(msg({ text: 'first' }))
  line({ kind: 'status', state: 'disconnected', detail: 'machine slept' })
  line({ kind: 'status', state: 'connected' })
  await s.until(() => (s.events().length === 3 ? true : undefined))
  expect(s.events().map(e => e.meta.event)).toEqual(['message', 'status', 'status'])
  expect(s.events()[1].content).toContain('may never arrive')
  await s.stop()

  line(msg({ text: 'while closed', ts: '1762160000.000300' }))
  s = server('s-inbox')
  await s.start()
  const [e] = await s.until(() => (s.events().length ? s.events() : undefined))
  expect(e.content).toContain('while closed')
  await s.tool('unsubscribe_inbox')
  await s.stop()
})

test('the inbox with include_own gets own posts on their own cap, flagged via_claude and external', async () => {
  const s = server('s-own', { SLACK_INBOX_RATE_PER_MINUTE: '2' })
  await s.start()
  const r = await s.tool('subscribe_inbox', { include_own: true })
  expect(r.content[0].text).toContain('inbox (with own)')
  expect(wantsOwnInbox(dir)).toBe(true)
  const own = (i: number, extra = {}) => msg({ channel: 'D1AB', trigger: 'own', triggers: ['own'], from_me: true, ts: `1762160002.00000${i}`, ...extra })
  line(own(0, { via_claude: true }))
  line(own(1))
  line(own(2)) // over the own cap
  line(msg({ ts: '1762160002.000009', text: 'to you', external: true }))
  await s.until(() => (s.events().length === 3 ? true : undefined))
  await Bun.sleep(200)
  const ev = s.events()
  expect(ev).toHaveLength(3)
  expect(ev[0].meta).toMatchObject({ via: 'inbox', trigger: 'own', via_claude: 'true' })
  expect(ev[0].content).toContain('posted by a Claude session')
  expect(ev[1].meta.via_claude).toBeUndefined()
  expect(ev[2].meta).toMatchObject({ trigger: 'dm', external: 'true' }) // the addressed cap is untouched
  await s.tool('subscribe_inbox')
  expect(wantsOwnInbox(dir)).toBe(false)
  await s.tool('unsubscribe_inbox')
  await s.stop()
})

test('a busy conversation is capped, and the rest counted', async () => {
  const s = server('s-busy', { SLACK_INBOX_RATE_PER_MINUTE: '2' })
  await s.start()
  await s.tool('subscribe_conversation', { conversation: 'C2AB' })
  for (let i = 0; i < 5; i++) line(msg({ channel: 'C2AB', trigger: 'watched_conversation', triggers: ['watched_conversation'], ts: `1762160001.00000${i}` }))
  await s.until(() => (s.events().length === 2 ? true : undefined))
  await Bun.sleep(200)
  expect(s.events()).toHaveLength(2)
  expect(JSON.parse(readFileSync(`${subsDir(dir)}/s-busy.json`, 'utf8')).conversations).toEqual([{ conversation: 'C2AB' }])
  await s.stop()
})

test('a listener that is not running is reported', async () => {
  writeFileSync(`${dir}/listener.pid`, '999999')
  const s = server('s-dead')
  await s.start()
  const r = await s.tool('subscribe_inbox')
  expect(r.content[0].text).toContain('not running')
  const [e] = await s.until(() => (s.events().length ? s.events() : undefined))
  expect(e.meta).toEqual({ event: 'status', state: 'not_running' })
  await s.stop()
})
