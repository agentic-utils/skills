import { expect, test } from 'bun:test'
import type { EventsApiPayload, Me, SlackMessage } from './match'
import { createHandler } from './run'
import type { Watches } from './subs'

const me: Me = { userId: 'UME', teamId: 'T1' }
const event = (m: Partial<SlackMessage>, p: Partial<EventsApiPayload> = {}): EventsApiPayload => ({
  type: 'event_callback',
  team_id: 'T1',
  event: { type: 'message', channel: 'C1', channel_type: 'channel', user: 'UOTHER', ts: '1762160000.000200', text: 'hello', ...m },
  ...p,
})

function setup(watches: Watches = new Map(), inThread = false) {
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
