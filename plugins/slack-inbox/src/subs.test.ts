import { expect, test } from 'bun:test'
import { mkdtempSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ensureSubsDir, parseTarget, pruneStale, readWatches, SESSION_TTL_MS, subsDir, writeSessionFile } from './subs'

test('parseTarget takes ids and message links', () => {
  expect(parseTarget('C0123ABC')).toEqual({ conversation: 'C0123ABC' })
  expect(parseTarget('D0123ABC', '1762150000.000100')).toEqual({ conversation: 'D0123ABC', thread_ts: '1762150000.000100' })
  // a reply's link names the thread it is in
  expect(parseTarget('https://example.slack.com/archives/C0123ABC/p1762160000123456?thread_ts=1762150000.000100&cid=C0123ABC')).toEqual({
    conversation: 'C0123ABC',
    thread_ts: '1762150000.000100',
  })
  // a top-level message's link names the thread it starts
  expect(parseTarget('https://example.slack.com/archives/G0123ABC/p1762160000123456')).toEqual({ conversation: 'G0123ABC', thread_ts: '1762160000.123456' })
  expect(parseTarget('https://example.slack.com/archives/C0123ABC')).toEqual({ conversation: 'C0123ABC' })
  expect(() => parseTarget('general')).toThrow(/conversation id/)
  expect(() => parseTarget('C0123ABC', 'yesterday')).toThrow(/ts/)
})

test('readWatches unions live sessions, ORs include_own, and skips stale or bad entries', () => {
  const dir = mkdtempSync(`${tmpdir()}/slack-subs-`)
  ensureSubsDir(dir)
  writeSessionFile(`${subsDir(dir)}/a.json`, { inbox: true, conversations: [{ conversation: 'C1AB' }, { conversation: 'C2AB', thread_ts: '1762150000.000100' }] })
  writeSessionFile(`${subsDir(dir)}/b.json`, { inbox: false, conversations: [{ conversation: 'C1AB', include_own: true }, { conversation: 'nope' } as any] })
  writeSessionFile(`${subsDir(dir)}/old.json`, { inbox: false, conversations: [{ conversation: 'C9AB' }] })
  const old = (Date.now() - SESSION_TTL_MS - 60_000) / 1000
  utimesSync(`${subsDir(dir)}/old.json`, old, old)
  expect(Object.fromEntries(readWatches(dir))).toEqual({ C1AB: true, 'C2AB:1762150000.000100': false })
  pruneStale(dir)
  expect(existsSync(`${subsDir(dir)}/old.json`)).toBe(false)
  expect(existsSync(`${subsDir(dir)}/a.json`)).toBe(true)
  expect(readWatches(`${dir}/missing`).size).toBe(0)
})
