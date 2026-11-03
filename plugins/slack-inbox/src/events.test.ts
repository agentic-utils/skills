import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { lastStatus, messageNotification, RateCap, readNew, route, statusNews } from './events'
import type { SessionFile } from './subs'

const msg = (r: Record<string, unknown> = {}) => ({ kind: 'message', channel: 'C1', ts: '1762160000.000200', thread_ts: null, triggers: ['dm'], ...r })
const subs = (s: Partial<SessionFile>): SessionFile => ({ inbox: false, conversations: [], ...s })

test('route picks the most specific subscription', () => {
  const s = subs({ inbox: true, conversations: [{ conversation: 'C1' }, { conversation: 'C1', thread_ts: '1762150000.000100' }] })
  expect(route(msg({ thread_ts: '1762150000.000100' }), s)).toEqual({ via: 'thread', key: 'C1:1762150000.000100' })
  expect(route(msg(), s)).toEqual({ via: 'conversation', key: 'C1' })
  expect(route(msg({ channel: 'D2' }), s)).toEqual({ via: 'inbox', key: 'inbox' })
  expect(route({ kind: 'status', state: 'connected' }, s)).toBeNull()
})

test("route keeps the inbox to personal triggers, and own messages to include_own", () => {
  expect(route(msg({ channel: 'C7', triggers: ['watched_conversation'] }), subs({ inbox: true }))).toBeNull()
  expect(route(msg({ from_me: true }), subs({ inbox: true, conversations: [{ conversation: 'C1' }] }))).toBeNull()
  expect(route(msg({ from_me: true }), subs({ conversations: [{ conversation: 'C1', include_own: true }] }))?.via).toBe('conversation')
  // the parent of a watched thread is not a reply in it
  expect(route(msg({ ts: '1762150000.000100', thread_ts: '1762150000.000100' }), subs({ conversations: [{ conversation: 'C1', thread_ts: '1762150000.000100' }] }))).toBeNull()
})

test('route sends own messages to an inbox with include_own, on a cap of their own', () => {
  const own = msg({ from_me: true, triggers: ['own'] })
  expect(route(own, subs({ inbox: true }))).toBeNull()
  expect(route(own, subs({ inbox: true, inbox_own: true }))).toEqual({ via: 'inbox', key: 'inbox:own' })
  expect(route(msg({ from_me: true, triggers: ['watched_conversation'] }), subs({ inbox: true, inbox_own: true }))).toBeNull()
  // a conversation watched with include_own is more specific
  expect(route(msg({ from_me: true, triggers: ['own', 'watched_conversation'] }), subs({ inbox: true, inbox_own: true, conversations: [{ conversation: 'C1', include_own: true }] }))?.via).toBe('conversation')
})

test('route keeps Slack Connect to the inbox, never a conversation', () => {
  const s = subs({ inbox: true, inbox_own: true, conversations: [{ conversation: 'C1', include_own: true }] })
  expect(route(msg({ external: true, triggers: ['mention'] }), s)).toEqual({ via: 'inbox', key: 'inbox' })
  expect(route(msg({ external: true, from_me: true, triggers: ['own'] }), s)).toEqual({ via: 'inbox', key: 'inbox:own' })
  expect(route(msg({ external: true, triggers: ['mention'] }), subs({ conversations: [{ conversation: 'C1' }] }))).toBeNull()
  const n = messageNotification(msg({ external: true, trigger: 'mention' }), { via: 'inbox', key: 'inbox' })
  expect(n.meta.external).toBe('true')
  expect(n.content).toContain('never reply or post there')
})

test('statusNews reports each outage once, and the recovery after it', () => {
  expect(statusNews(undefined, 'connected')).toBe(false)
  expect(statusNews('connected', 'disconnected')).toBe(true)
  expect(statusNews('disconnected', 'disconnected')).toBe(false)
  expect(statusNews('disconnected', 'paused')).toBe(true)
  expect(statusNews('paused', 'connected')).toBe(true)
  expect(statusNews('not_running', 'started')).toBe(false)
  expect(statusNews('connected', 'connected')).toBe(false)
})

test('RateCap lets `limit` through per key per minute and counts the rest', () => {
  const c = new RateCap(2)
  expect([c.allow('C1', 0), c.allow('C1', 1), c.allow('C1', 2), c.allow('C2', 3)]).toEqual([true, true, false, true])
  expect(c.flush(30_000)).toEqual([])
  expect(c.allow('C1', 61_000)).toBe(false) // still counted until reported
  expect(c.flush(61_000)).toEqual([{ key: 'C1', dropped: 2 }])
  expect(c.allow('C1', 61_001)).toBe(true)
})

test('messageNotification keeps meta to safe characters', () => {
  const n = messageNotification(msg({ trigger: 'dm', channel: 'C1"><x', author: { id: 'U1', name: 'alex' }, text: 'hi' }), { via: 'inbox', key: 'inbox' })
  expect(n.meta.channel).toBe('C1x')
  expect(n.content).toContain('dm from alex (U1)')
})

test('readNew starts at the end, keeps partial lines, and follows rotation', () => {
  const dir = mkdtempSync(`${tmpdir()}/slack-log-`)
  const f = `${dir}/events.jsonl`
  writeFileSync(f, '{"a":1}\n')
  let r = readNew(f, {})
  expect(r.lines).toEqual([])
  appendFileSync(f, '{"a":2}\n{"a":')
  r = readNew(f, r.pos)
  expect(r.lines).toEqual(['{"a":2}'])
  appendFileSync(f, '3}\n')
  r = readNew(f, r.pos)
  expect(r.lines).toEqual(['{"a":3}'])
  renameSync(f, `${f}.0`)
  writeFileSync(f, '{"a":4}\n')
  r = readNew(f, r.pos)
  expect(r.lines).toEqual(['{"a":4}'])
  appendFileSync(f, '{"kind":"status","state":"paused"}\n')
  expect(lastStatus(f)?.state).toBe('paused')
})
