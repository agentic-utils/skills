import { expect, test } from 'bun:test'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { EventsApiPayload, Me, SlackMessage } from './match'
import { createHandler, deliveryStalled, drainRelay, recentChannels, sleptFor, socketProblem } from './run'
import type { Watches } from './subs'

const me: Me = { userId: 'UME', teamId: 'T1' }
const event = (m: Partial<SlackMessage>, p: Partial<EventsApiPayload> = {}): EventsApiPayload => ({
  type: 'event_callback',
  team_id: 'T1',
  event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UOTHER', ts: '1762160000.000200', text: 'hello', ...m },
  ...p,
})

function setup(watches: Watches = new Map(), inThread = false, logOwn = false) {
  const out: Record<string, any>[] = []
  const lookups: string[] = []
  const handle = createHandler({
    me,
    teamUrl: 'https://example.slack.com/',
    allowBots: new Set(),
    previewChars: 200,
    groups: () => new Set(),
    userInThread: async (c, t) => (lookups.push(`${c}:${t}`), inThread),
    remember: () => {},
    watches: () => watches,
    logOwn: () => logOwn,
    userName: async id => `name-${id}`,
    emit: r => out.push(r),
  })
  return { handle, out, lookups }
}

const reply = { thread_ts: '1762150000.000100', parent_user_id: 'UOTHER' }

test('a reply in a thread the user is not in is logged only when a session watches that thread', async () => {
  const off = setup()
  await off.handle(event(reply))
  expect(off.out).toEqual([])

  const on = setup(new Map([['C1:1762150000.000100', false]]))
  await on.handle(event(reply))
  expect(on.out).toHaveLength(1)
  expect(on.out[0]).toMatchObject({ kind: 'message', trigger: 'watched_thread', triggers: ['watched_thread'], channel: 'C1', thread_ts: '1762150000.000100' })
  expect(on.out[0].from_me).toBeUndefined()
})

test('a watched thread does not log the thread parent, or replies in other threads', async () => {
  const s = setup(new Map([['C1:1762150000.000100', false]]))
  await s.handle(event({ ts: '1762150000.000100', thread_ts: '1762150000.000100' }))
  await s.handle(event({ thread_ts: '1762140000.000100', parent_user_id: 'UOTHER', ts: '1762160000.000300' }))
  expect(s.out).toEqual([])
})

test('a watched conversation logs top-level messages and replies that do not mention the user', async () => {
  const s = setup(new Map([['C1', false]]))
  await s.handle(event({}))
  await s.handle(event({ ...reply, ts: '1762160000.000300' }))
  expect(s.out.map(r => r.triggers)).toEqual([['watched_conversation'], ['watched_conversation']])
})

test('personal triggers still come first when also watched', async () => {
  const s = setup(new Map([['C1', false]]))
  await s.handle(event({ text: 'hey <@UME>' }))
  expect(s.out[0]).toMatchObject({ trigger: 'mention', triggers: ['mention', 'watched_conversation'] })
})

test("the user's own messages are logged only where a session asked for them", async () => {
  const without = setup(new Map([['C1', false]]))
  await without.handle(event({ user: 'UME' }))
  expect(without.out).toEqual([])

  const withOwn = setup(new Map([['C1', true]]))
  await withOwn.handle(event({ user: 'UME' }))
  expect(withOwn.out[0]).toMatchObject({ triggers: ['watched_conversation'], from_me: true })
})

test('with logOwn, every message the user posts is logged as trigger own, self-DM and threads included', async () => {
  const s = setup(new Map(), false, true)
  await s.handle(event({ user: 'UME', channel: 'D1', channel_type: 'im', ts: '1762160000.000600' }))
  await s.handle(event({ user: 'UME', channel: 'C5', ...reply, ts: '1762160000.000700' }))
  await s.handle(event({ user: 'UME', channel: 'G1', channel_type: 'mpim', ts: '1762160000.000800', text: 'ok\n_✨ via <https://claude.ai/code/session_x|Claude session>_' }))
  expect(s.out.map(r => [r.channel, r.trigger, r.from_me, r.via_claude])).toEqual([
    ['D1', 'own', true, undefined],
    ['C5', 'own', true, undefined],
    ['G1', 'own', true, true],
  ])
})

test('with logOwn and a watch with include_own, both triggers are kept and own leads', async () => {
  const s = setup(new Map([['C1', true]]), false, true)
  await s.handle(event({ user: 'UME' }))
  expect(s.out[0]).toMatchObject({ trigger: 'own', triggers: ['own', 'watched_conversation'] })
})

test('Slack Connect is logged, flagged external, only when addressed to the user or their own post', async () => {
  const ext = { is_ext_shared_channel: true }
  const s = setup(new Map([['C1', true]]), false, true)
  await s.handle(event({}, ext)) // watched, but not addressed to the user: dropped
  await s.handle(event({ text: 'hi <@UME>', ts: '1762160000.000400' }, ext))
  await s.handle(event({ channel: 'D9', channel_type: 'im', ts: '1762160000.000500' }, ext))
  await s.handle(event({ user: 'UME', ts: '1762160000.000600' }, ext))
  await s.handle(event({ bot_id: 'B1', text: 'hi <@UME>', ts: '1762160000.000700' }, ext))
  expect(s.out.map(r => [r.triggers, r.external])).toEqual([
    [['mention'], true],
    [['dm'], true],
    [['own'], true],
  ])
  const off = setup(new Map([['C1', true]]))
  await off.handle(event({ user: 'UME' }, ext))
  expect(off.out).toEqual([])
})

test('Slack Connect and unlisted bots stay out of watched conversations', async () => {
  const s = setup(new Map([['C1', true]]))
  await s.handle(event({}, { is_ext_shared_channel: true }))
  await s.handle(event({ user_team: 'T9', ts: '1762160000.000400' }))
  await s.handle(event({ bot_id: 'B1', ts: '1762160000.000500' }))
  expect(s.out).toEqual([])
})

test('the same message twice is logged once', async () => {
  const s = setup(new Map([['C1', false]]))
  await s.handle(event({}, { event_id: 'E1' }))
  await s.handle(event({}, { event_id: 'E2' }))
  expect(s.out).toHaveLength(1)
})

test('a socket that never says hello is replaced after the timeout', () => {
  expect(socketProblem({ now: 29_000, openedAt: 0 })).toBeNull()
  expect(socketProblem({ now: 31_000, openedAt: 0 })).toBe('no hello from slack')
})

test('a connected socket is replaced only after a minute with no frame at all', () => {
  expect(socketProblem({ now: 59_000, openedAt: 0, helloAt: 0 })).toBeNull()
  expect(socketProblem({ now: 61_000, openedAt: 0, helloAt: 0 })).toBe('no traffic from slack')
  expect(socketProblem({ now: 110_000, openedAt: 0, helloAt: 0, lastFrameAt: 100_000 })).toBeNull()
})

test('sleep length reads in seconds, then minutes', () => {
  expect(sleptFor(45_000)).toBe('45s')
  expect(sleptFor(6_000_000)).toBe('100m')
})

const MIN = 60_000

test('a message sent while connected with no event since it counts as a stall once the grace is over', () => {
  const s = { connectedAt: 0, lastEventAt: 5 * MIN, newestAt: 10 * MIN }
  expect(deliveryStalled({ ...s, now: 11 * MIN })).toBe(false)
  expect(deliveryStalled({ ...s, now: 13 * MIN })).toBe(true)
})

test('an event after the newest message is not a stall, however long ago', () => {
  expect(deliveryStalled({ now: 100 * MIN, connectedAt: 0, lastEventAt: 11 * MIN, newestAt: 10 * MIN })).toBe(false)
})

test('a message from before this connection was missed while down, which is not a stall', () => {
  expect(deliveryStalled({ now: 100 * MIN, connectedAt: 50 * MIN, lastEventAt: 0, newestAt: 40 * MIN })).toBe(false)
})

test('nothing readable from Slack is not a stall', () => {
  expect(deliveryStalled({ now: 100 * MIN, connectedAt: 0, lastEventAt: 0, newestAt: 0 })).toBe(false)
})

test('recent channels come newest first from the log, skipping lines that have none', () => {
  const path = `${tmpdir()}/slack-inbox-recent-${process.pid}.jsonl`
  writeFileSync(path, ['{"kind":"status"}', '{"channel":"C1"}', 'not json', '{"channel":"C2"}', '{"channel":"C1"}', ''].join('\n'))
  expect(recentChannels(path, 5)).toEqual(['C1', 'C2'])
  expect(recentChannels(path, 1)).toEqual(['C1'])
  unlinkSync(path)
  expect(recentChannels(path, 5)).toEqual([])
})

test("someone else writing the attribution line does not get the via_claude flag", async () => {
  const s = setup()
  await s.handle(event({ channel: 'D1', channel_type: 'im', text: 'skip this one _✨ via <https://example.invalid|Claude session>_' }))
  expect(s.out).toHaveLength(1)
  expect(s.out[0].via_claude).toBeUndefined()
})

test('the relay is not pulled until the user groups have loaded', async () => {
  const calls: string[] = []
  let loaded = false
  const d = { groupsLoaded: () => loaded, loadGroups: async () => void calls.push('load'), pull: async () => void calls.push('pull') }
  await drainRelay(d)
  expect(calls).toEqual(['load'])
  d.loadGroups = async () => {
    calls.push('load')
    loaded = true
  }
  await drainRelay(d)
  expect(calls).toEqual(['load', 'load', 'pull'])
  await drainRelay(d)
  expect(calls).toEqual(['load', 'load', 'pull', 'pull'])
})
