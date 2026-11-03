import { expect, test } from 'bun:test'
import { type EventsApiPayload, type Me, type SlackMessage, needsThreadLookup, permalink, preview, screen, triggers, viaClaude } from './match'

const me: Me = { userId: 'UME', teamId: 'T1' }
const msg = (m: Partial<SlackMessage>): SlackMessage => ({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'UOTHER', ts: '100.000200', text: '', ...m })
const payload = (m: Partial<SlackMessage>, p: Partial<EventsApiPayload> = {}): EventsApiPayload => ({ type: 'event_callback', team_id: 'T1', event: msg(m), ...p })
const none = new Set<string>()
const hits = (m: Partial<SlackMessage>, groups = none, inThread = false) => triggers(msg(m), me, groups, inThread)

test('screen drops own, bots and edits, and flags Slack Connect', () => {
  expect(screen(payload({ user: 'UME', thread_ts: '1.0' }), me, none)).toEqual({ skip: 'own', thread: 'C1:1.0', external: false })
  expect(screen(payload({ user: 'UME' }), me, none)).toEqual({ skip: 'own', thread: undefined, external: false })
  expect(screen(payload({ user: 'UME' }, { is_ext_shared_channel: true }), me, none)).toEqual({ skip: 'own', thread: undefined, external: true })
  expect(screen(payload({ bot_id: 'B1' }), me, none)).toEqual({ skip: 'bot' })
  expect(screen(payload({ subtype: 'bot_message', bot_id: 'B1', user: undefined }), me, none)).toEqual({ skip: 'bot' })
  expect(screen(payload({ user: 'USLACKBOT' }), me, none)).toEqual({ skip: 'bot' })
  expect(screen(payload({ subtype: 'message_changed' }), me, none)).toEqual({ skip: 'subtype' })
  expect(screen(payload({ subtype: 'channel_join' }), me, none)).toEqual({ skip: 'subtype' })
  expect(screen(payload({}, { is_ext_shared_channel: true }), me, none)).toMatchObject({ external: true })
  expect(screen(payload({ user_team: 'T2' }), me, none)).toMatchObject({ external: true })
  expect(screen(payload({ bot_id: 'B1' }, { is_ext_shared_channel: true }), me, none)).toEqual({ skip: 'bot' })
  expect(screen({ type: 'event_callback', event: { ...msg({}), type: 'reaction_added' } }, me, none)).toEqual({ skip: 'not_message' })
})

test('screen keeps people, allow-listed bots and Grid colleagues', () => {
  expect('message' in screen(payload({}), me, none)).toBe(true)
  expect('message' in screen(payload({ subtype: 'thread_broadcast' }), me, none)).toBe(true)
  expect('message' in screen(payload({ bot_id: 'B1' }), me, new Set(['B1']))).toBe(true)
  expect('message' in screen(payload({ bot_id: 'B9', bot_profile: { app_id: 'A1' } }), me, new Set(['A1']))).toBe(true)
  expect(screen(payload({ user_team: 'T2' }), { ...me, enterpriseId: 'E1' }, none)).toMatchObject({ external: false })
})

test('viaClaude spots the attribution line a Claude session ends a post with', () => {
  expect(viaClaude('done\n_✨ via <https://claude.ai/code/session_x|Claude session>_')).toBe(true)
  expect(viaClaude('done _✨ via <t3code://threads/a/b|Claude session>_ \n')).toBe(true)
  expect(viaClaude('_✨ via <https://claude.ai/code/session_x|Claude session>_ and then more')).toBe(false)
  expect(viaClaude('via Claude session')).toBe(false)
  expect(viaClaude(undefined)).toBe(false)
})

test('triggers', () => {
  expect(hits({ channel_type: 'im' })).toEqual(['dm'])
  expect(hits({ channel_type: 'mpim' })).toEqual(['group_dm'])
  expect(hits({ text: 'hey <@UME> look' })).toEqual(['mention'])
  expect(hits({ text: 'hey <@UME|me> look' })).toEqual(['mention'])
  expect(hits({ text: 'hey <@UMEX>' })).toEqual([])
  expect(hits({ text: '<!subteam^S1> help' }, new Set(['S1']))).toEqual(['group_mention'])
  expect(hits({ text: '<!subteam^S1|@team> and <!subteam^S2>' }, new Set(['S2']))).toEqual(['group_mention'])
  expect(hits({ text: '<!subteam^S1>' }, new Set(['S2']))).toEqual([])
  expect(hits({ thread_ts: '1.0', parent_user_id: 'UME' })).toEqual(['thread_reply'])
  expect(hits({ thread_ts: '1.0' }, none, true)).toEqual(['thread_reply'])
  expect(hits({ thread_ts: '1.0' })).toEqual([])
  // a thread parent is not a reply
  expect(hits({ thread_ts: '100.000200', parent_user_id: 'UME' })).toEqual([])
  expect(hits({ channel_type: 'im', text: '<@UME>', thread_ts: '1.0', parent_user_id: 'UME' })).toEqual(['dm', 'mention', 'thread_reply'])
})

test('thread lookup only when the event cannot say', () => {
  expect(needsThreadLookup(msg({}), me)).toBe(false)
  expect(needsThreadLookup(msg({ thread_ts: '1.0', parent_user_id: 'UME' }), me)).toBe(false)
  expect(needsThreadLookup(msg({ thread_ts: '1.0', parent_user_id: 'UX' }), me)).toBe(true)
})

test('preview is one line and bounded', () => {
  expect(preview('a\n\nb\tc\u0007d', 50)).toBe('a b c d')
  expect(preview('x'.repeat(30), 20)).toHaveLength(20)
  expect(preview(undefined, 20)).toBe('')
})

test('permalink', () => {
  expect(permalink('https://ws.slack.com/', msg({}))).toBe('https://ws.slack.com/archives/C1/p100000200')
  expect(permalink('https://ws.slack.com', msg({ thread_ts: '99.000100' }))).toBe(
    'https://ws.slack.com/archives/C1/p100000200?thread_ts=99.000100&cid=C1',
  )
})
