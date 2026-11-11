import { afterEach, expect, test } from 'bun:test'
import { checkConversation, newestMessageAt } from './slack'

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})
const slack = (body: object) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch
}

test('checkConversation refuses what the listener cannot see', async () => {
  slack({ ok: true, channel: { name: 'ops', is_member: false } })
  expect(await checkConversation('xoxp-1', 'C1AB')).toMatchObject({ ok: false, reason: expect.stringContaining('not a member of #ops') })
  slack({ ok: true, channel: { name: 'shared', is_member: true, is_ext_shared: true } })
  expect(await checkConversation('xoxp-1', 'C1AB')).toMatchObject({ ok: false, reason: expect.stringContaining('Slack Connect') })
  slack({ ok: false, error: 'channel_not_found' })
  expect((await checkConversation('xoxp-1', 'C1AB')).ok).toBe(false)
})

test('checkConversation accepts members, and accepts unverified when it cannot ask', async () => {
  slack({ ok: true, channel: { name: 'ops', is_member: true } })
  expect(await checkConversation('xoxp-1', 'C1AB')).toEqual({ ok: true, name: '#ops' })
  slack({ ok: true, channel: { is_im: true } })
  expect(await checkConversation('xoxp-1', 'D1AB')).toEqual({ ok: true, name: 'DM D1AB' })
  slack({ ok: false, error: 'missing_scope' })
  expect(await checkConversation('xoxp-1', 'D1AB')).toMatchObject({ ok: true, note: expect.stringContaining('im:read') })
  expect(await checkConversation(undefined, 'C1AB')).toMatchObject({ ok: true, note: expect.stringContaining('no user token') })
})

test('newestMessageAt skips what the relay drops, so a chatty bot reads as no stall', async () => {
  const me = { userId: 'UME', teamId: 'T1' }
  slack({ ok: true, messages: [{ type: 'message', subtype: 'bot_message', bot_id: 'B1', ts: '30' }, { type: 'message', user: 'UOTHER', bot_id: 'B2', ts: '20' }, { type: 'message', user: 'UOTHER', ts: '10' }] })
  expect(await newestMessageAt('xoxp-1', 'C1', me, new Set())).toBe(10_000)
  expect(await newestMessageAt('xoxp-1', 'C1', me, new Set(['B1']))).toBe(30_000)
  slack({ ok: true, messages: [{ type: 'message', user: 'UME', bot_id: 'BCLAUDE', ts: '40' }] })
  expect(await newestMessageAt('xoxp-1', 'C1', me, new Set())).toBe(40_000)
  slack({ ok: true, messages: [{ type: 'message', subtype: 'bot_message', bot_id: 'B1', ts: '30' }] })
  expect(await newestMessageAt('xoxp-1', 'C1', me, new Set())).toBe(0)
})
