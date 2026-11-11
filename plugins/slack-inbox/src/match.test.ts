import { expect, test } from 'bun:test'
import {
  botBlocked,
  type EventsApiPayload,
  type Me,
  needsItemThread,
  needsThreadLookup,
  passesRelay,
  permalink,
  preview,
  reactionTriggers,
  type SlackMessage,
  type SlackReaction,
  screen,
  screenReaction,
  triggers,
  viaClaude,
} from './match'

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

const rx = (r: Partial<SlackReaction> = {}): SlackReaction => ({
  type: 'reaction_added',
  user: 'UOTHER',
  reaction: 'eyes',
  item_user: 'UPOSTER',
  item: { type: 'message', channel: 'C1', ts: '100.000200' },
  event_ts: '101.000000',
  ...r,
})
const rxPayload = (r: Partial<SlackReaction> = {}, p: Partial<EventsApiPayload> = {}) =>
  ({ type: 'event_callback', team_id: 'T1', event: rx(r) as unknown as SlackMessage, ...p }) as EventsApiPayload

test('screenReaction keeps reactions to messages, own ones flagged', () => {
  expect(screenReaction(rxPayload(), me)).toEqual({ reaction: rx(), own: false, external: false })
  expect(screenReaction(rxPayload({ type: 'reaction_removed' }), me)).toMatchObject({ own: false })
  expect(screenReaction(rxPayload({ user: 'UME' }), me)).toMatchObject({ own: true })
  expect(screenReaction(rxPayload({}, { is_ext_shared_channel: true }), me)).toMatchObject({ external: true })
  expect(screenReaction(rxPayload({ item: { type: 'file' } }), me)).toEqual({ skip: 'not_message_item' })
  expect(screenReaction(rxPayload({ item: { type: 'message', channel: 'C1' } }), me)).toEqual({ skip: 'not_message_item' })
  expect(screenReaction(payload({}), me)).toEqual({ skip: 'not_reaction' })
  expect(screenReaction({ type: 'url_verification' }, me)).toEqual({ skip: 'not_reaction' })
})

test('botBlocked applies allow_bots to a reacting bot by any of its ids', () => {
  expect(botBlocked('UOTHER', null, none)).toBe(false)
  expect(botBlocked('UBOT', ['B1', 'A1'], none)).toBe(true)
  expect(botBlocked('UBOT', ['B1', 'A1'], new Set(['B1']))).toBe(false)
  expect(botBlocked('UBOT', ['B1', 'A1'], new Set(['A1']))).toBe(false)
  expect(botBlocked('UBOT', [], new Set(['UBOT']))).toBe(false)
})

test('passesRelay stores reactions to messages, own included, and nothing else new', () => {
  expect(passesRelay(rxPayload(), me, none)).toBe(true)
  expect(passesRelay(rxPayload({ type: 'reaction_removed' }), me, none)).toBe(true)
  expect(passesRelay(rxPayload({ user: 'UME' }), me, none)).toBe(true)
  expect(passesRelay(rxPayload({ item: { type: 'file' } }), me, none)).toBe(false)
  // the 1.8.0 savings hold: bots, edits and other event types are still dropped
  expect(passesRelay(payload({ bot_id: 'B1' }), me, none)).toBe(false)
  expect(passesRelay(payload({ subtype: 'message_changed' }), me, none)).toBe(false)
  expect(passesRelay({ type: 'event_callback', event: { ...msg({}), type: 'pin_added' } }, me, none)).toBe(false)
  expect(passesRelay(payload({}), me, none)).toBe(true)
})

test('reactionTriggers', () => {
  const w = (...e: [string, boolean][]) => new Map(e)
  expect(reactionTriggers(rx(), me, w(), false, false)).toEqual([])
  expect(reactionTriggers(rx({ item_user: 'UME' }), me, w(), false, false)).toEqual(['on_own_message'])
  expect(reactionTriggers(rx(), me, w(['C1', false]), false, false)).toEqual(['watched_conversation'])
  // a thread's parent counts for that thread; a reply counts once its thread is known
  expect(reactionTriggers(rx(), me, w(['C1:100.000200', false]), false, false)).toEqual(['watched_thread'])
  expect(reactionTriggers(rx(), me, w(['C1:99.000100', false]), false, false)).toEqual([])
  expect(reactionTriggers(rx(), me, w(['C1:99.000100', false]), false, false, '99.000100')).toEqual(['watched_thread'])
  expect(reactionTriggers(rx(), me, w(['C2', false]), false, false)).toEqual([])
  // the user's own reactions: only where asked for
  const mine = rx({ user: 'UME', item_user: 'UME' })
  expect(reactionTriggers(mine, me, w(['C1', false]), true, false)).toEqual([])
  expect(reactionTriggers(mine, me, w(['C1', true]), true, false)).toEqual(['watched_conversation'])
  expect(reactionTriggers(mine, me, w(), true, true)).toEqual(['own'])
})

test('a reaction needs its thread only when a thread in that conversation is watched', () => {
  const w = (...k: string[]) => new Map(k.map(x => [x, false] as [string, boolean]))
  expect(needsItemThread(rx(), w())).toBe(false)
  expect(needsItemThread(rx(), w('C1'))).toBe(false)
  expect(needsItemThread(rx(), w('C1:100.000200'))).toBe(false)
  expect(needsItemThread(rx(), w('C2:99.000100'))).toBe(false)
  expect(needsItemThread(rx(), w('C1:99.000100'))).toBe(true)
  expect(needsItemThread(rx(), w('C10:99.000100'))).toBe(false)
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
