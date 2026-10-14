import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startBroker } from './broker'
import { dial } from './channel'

// A fake gh-webhook: logs its args, fails for o/dies like a repo without admin, takes 300ms to clean up on SIGINT.
function setup() {
  const dir = mkdtempSync(`${tmpdir()}/gpe-`)
  writeFileSync(
    `${dir}/fwd`,
    `#!/bin/sh
echo "start $*" >> ${dir}/calls
case "$*" in *--repo=o/dies*) sleep 1; echo "no admin on o/dies" >&2; exit 1;; esac
trap 'sleep ${'${FWD_STOP_SECS:-0.3}'}; echo stopped >> ${dir}/calls; exit 0' INT
while :; do sleep 0.1; done
`,
  )
  chmodSync(`${dir}/fwd`, 0o755)
  // a stand-in gh, so the broker's mergeability and force-push checks never reach GitHub
  mkdirSync(`${dir}/bin`)
  writeFileSync(`${dir}/bin/gh`, '#!/bin/sh\n')
  chmodSync(`${dir}/bin/gh`, 0o755)
  process.env.PATH = `${dir}/bin:${process.env.PATH}`
  process.env.GH_PR_EVENTS_FORWARDER = `${dir}/fwd`
  process.env.GH_PR_EVENTS_STATE_DIR = dir
  const calls = () => {
    try {
      return readFileSync(`${dir}/calls`, 'utf8').trim().split('\n')
    } catch {
      return []
    }
  }
  const sock = `${dir}/broker.sock`
  const session = (got: string[] = []) => dial(sock, m => got.push(m.content), () => {})
  // the fake was handed the broker's webhook url and secret, so a test can deliver as GitHub would
  const deliver = async (event: string, payload: object) => {
    const start = calls().find(l => l.startsWith('start') && l.includes('--secret='))!
    const [, url] = start.match(/--url=(\S+)/)!
    const [, secret] = start.match(/--secret=(\S+)/)!
    const body = JSON.stringify(payload)
    const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    await fetch(url, { method: 'POST', body, headers: { 'x-github-event': event, 'x-hub-signature-256': sig } })
  }
  return { dir, sock, calls, session, deliver }
}

const comment = (body: string) => ({
  action: 'created',
  repository: { full_name: 'o/r' },
  sender: { login: 'amy' },
  issue: { number: 7, pull_request: {} },
  comment: { html_url: 'h', body },
})

test('one forwarder per repo, events fan out to every subscribed session', async () => {
  const t = setup()
  const b = (await startBroker())!
  const got: string[][] = [[], []]
  const [a, c] = await Promise.all([t.session(got[0]), t.session(got[1])])
  expect(await a.request('sub', 'o/r#7')).toBeNull()
  expect(await c.request('sub', 'O/R#7')).toBeNull()
  expect(t.calls().filter(l => l.startsWith('start'))).toHaveLength(1)

  await t.deliver('issue_comment', comment('hi'))
  await Bun.sleep(100)
  expect(got).toEqual([['Comment by amy\nh\nhi'], ['Comment by amy\nh\nhi']])

  await a.request('unsub', 'o/r#7')
  expect(t.calls()).not.toContain('stopped') // the other session still watches the repo
  c.close()
  await Bun.sleep(800)
  expect(t.calls()).toContain('stopped')
  await b.stop()
}, 45_000)

test('a session that leaves while its forwarder starts leaves nothing running', async () => {
  const t = setup()
  const b = (await startBroker())!
  const [a, bystander] = await Promise.all([t.session(), t.session()])
  const pending = a.request('sub', 'o/r#1')
  await Bun.sleep(200)
  a.close()
  await pending
  await Bun.sleep(4000)
  // either it never started (cancelled in time) or it started and was stopped
  const c = t.calls()
  expect(c.filter(l => l === 'stopped').length).toBe(c.filter(l => l.startsWith('start')).length)
  bystander.close()
  await b.stop()
}, 45_000)

test('everyone waiting on a forwarder that fails to start gets the error', async () => {
  const t = setup()
  const b = (await startBroker())!
  const [a, c] = await Promise.all([t.session(), t.session()])
  const errs = await Promise.all([a.request('sub', 'o/dies#1'), c.request('sub', 'o/dies#2')])
  expect(errs).toEqual(['gh webhook forward failed for o/dies: no admin on o/dies', 'gh webhook forward failed for o/dies: no admin on o/dies'])
  a.close()
  c.close()
  await b.stop()
}, 45_000)

test("unsubscribing a PR nobody watches doesn't touch a forwarder that is starting", async () => {
  const t = setup()
  const b = (await startBroker())!
  const [a, c] = await Promise.all([t.session(), t.session()])
  const sub = a.request('sub', 'o/r#1')
  await Bun.sleep(300)
  await c.request('unsub', 'o/r#99')
  expect(await sub).toBeNull()
  expect(t.calls()).not.toContain('stopped')
  a.close()
  c.close()
  await b.stop()
}, 45_000)

test('a session that falls behind still gets every event', async () => {
  const t = setup()
  const b = (await startBroker())!
  // a separate process, so its busy spell doesn't also stall the broker
  writeFileSync(
    `${t.dir}/slow.ts`,
    `import { dial } from '${import.meta.dir}/channel'
const got: string[] = []
const c = await dial(process.argv[2], m => got.push(m.content), () => {})
await c.request('sub', 'o/r#7')
await Bun.write('${t.dir}/ready', '')
const until = Date.now() + 1500
while (Date.now() < until) {}
await Bun.sleep(1500)
await Bun.write('${t.dir}/result', got.length + ' ' + got.every(s => s.endsWith('ü'.repeat(1500))))
process.exit(0)`,
  )
  const slow = Bun.spawn(['bun', `${t.dir}/slow.ts`, t.sock], { stdout: 'inherit', stderr: 'inherit' })
  for (let i = 0; i < 100 && !existsSync(`${t.dir}/ready`); i++) await Bun.sleep(100)
  for (let i = 0; i < 8; i++) await t.deliver('issue_comment', comment('ü'.repeat(1500)))
  await Promise.race([slow.exited, Bun.sleep(10_000)])
  slow.kill()
  expect(readFileSync(`${t.dir}/result`, 'utf8')).toBe('8 true')
  await b.stop()
}, 45_000)

test('after a crash, sessions restarting together get exactly one broker, which stops the old forwarders', async () => {
  const t = setup()
  const env = { ...process.env }
  const broker = () => Bun.spawn(['bun', `${import.meta.dir}/server.ts`, 'broker'], { env, stdout: 'ignore', stderr: 'ignore' })
  const first = broker()
  let a!: Awaited<ReturnType<typeof t.session>>
  for (let i = 0; i < 100 && !a; i++) a = await t.session().catch(() => Bun.sleep(100).then(() => a))
  expect(await a.request('sub', 'o/r#1')).toBeNull()
  first.kill('SIGKILL')
  await first.exited
  const racers = [broker(), broker(), broker(), broker()]
  await Bun.sleep(2500)
  expect(racers.filter(p => p.exitCode === null)).toHaveLength(1)
  expect(t.calls()).toContain('stopped') // the orphan from the killed broker
  racers.forEach(p => p.kill('SIGTERM'))
}, 45_000)

test('a malformed or invalid request gets an error reply and the broker carries on', async () => {
  const t = setup()
  const b = (await startBroker())!
  const replies: string[] = []
  const raw = await Bun.connect({ unix: t.sock, socket: { data: (_s, d) => void replies.push(d.toString()) } })
  raw.write('not json\nnull\n{"id":1,"op":"unsub"}\n{"id":2,"op":"sub","pr":"o/../x#1"}\n{"id":3,"op":"nuke","pr":"o/r#1"}\n')
  await Bun.sleep(200)
  expect(replies.join('')).toBe(
    '{"id":1,"err":"expected owner/repo#number"}\n{"id":2,"err":"expected owner/repo#number"}\n{"id":3,"err":"unknown op: nuke"}\n',
  )
  const a = await t.session()
  expect(await a.request('sub', 'o/r#1')).toBeNull()
  raw.end()
  a.close()
  await b.stop()
}, 45_000)

test('subscribes to many repos at once all get answered', async () => {
  const t = setup()
  const b = (await startBroker())!
  const a = await t.session()
  const errs = await Promise.all(Array.from({ length: 12 }, (_, i) => a.request('sub', `o/r${i}#1`)))
  expect(errs).toEqual(Array(12).fill(null))
  a.close()
  await b.stop()
}, 45_000)

test('a forwarder whose pid cannot be recorded is still stopped', async () => {
  const t = setup()
  const b = (await startBroker())!
  const a = await t.session()
  expect(await a.request('sub', 'o/r#1')).toBeNull()
  rmSync(`${t.dir}/forwarders.json`)
  mkdirSync(`${t.dir}/forwarders.json`) // writes to it now fail
  a.close()
  await Bun.sleep(1000)
  expect(t.calls()).toContain('stopped')
  await b.stop()
}, 45_000)

test('a stopping broker leaves the socket of the broker that replaced it', async () => {
  const t = setup()
  const env = { ...process.env, FWD_STOP_SECS: '2' }
  const broker = () => Bun.spawn(['bun', `${import.meta.dir}/server.ts`, 'broker'], { env, stdout: 'ignore', stderr: 'ignore' })
  // brokers start in their own processes, so wait for them rather than guess how long that takes
  const session = async () => {
    for (let i = 0; ; i++)
      try {
        return await t.session()
      } catch (e) {
        if (i > 100) throw e
        await Bun.sleep(100)
      }
  }
  const old = broker()
  const a = await session()
  expect(await a.request('sub', 'o/r#1')).toBeNull()
  old.kill('SIGTERM') // its forwarder takes 2s to stop, and the replacement is elected meanwhile
  const next = broker()
  await old.exited
  expect(existsSync(t.sock)).toBe(true)
  const c = await session()
  expect(await c.request('sub', 'o/q#1')).toBeNull()
  c.close()
  next.kill('SIGTERM')
  await next.exited
}, 45_000)

test('a subscribe undone while its forwarder starts is not reported as subscribed', async () => {
  const t = setup()
  const b = (await startBroker())!
  const a = await t.session()
  const sub = a.request('sub', 'o/w#1')
  await Bun.sleep(300)
  expect(await a.request('unsub', 'o/w#1')).toBeNull()
  expect(await sub).toBe('unsubscribed while the forwarder started')
  a.close()
  await b.stop()
}, 45_000)
