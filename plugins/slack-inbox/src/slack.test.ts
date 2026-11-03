import { afterEach, expect, test } from 'bun:test'
import { checkConversation } from './slack'

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
