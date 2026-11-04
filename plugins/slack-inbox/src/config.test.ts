import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { loadConfig } from './config'
import { inHours, parseDays, parseHours } from './hours'

const dir = mkdtempSync(`${tmpdir()}/slack-inbox-test-`)
const at = (day: number, hh: number, mm = 0) => new Date(2026, 10, 1 + day, hh, mm) // 1 Nov 2026 is a Sunday

test('days', () => {
  expect([...parseDays('mon-fri')]).toEqual([1, 2, 3, 4, 5])
  expect([...parseDays('fri-mon')]).toEqual([5, 6, 0, 1])
  expect([...parseDays('mon,Wednesday')]).toEqual([1, 3])
  expect(parseDays('all').size).toBe(7)
  expect(() => parseDays('funday')).toThrow()
})

test('hours', () => {
  const h = parseHours('09:00-18:00')
  expect(inHours(h, at(1, 9))).toBe(true)
  expect(inHours(h, at(1, 8, 59))).toBe(false)
  expect(inHours(h, at(1, 18))).toBe(false)
  expect(inHours(h, at(0, 12))).toBe(false) // Sunday
  const night = parseHours('22:00-06:00', 'mon')
  expect(inHours(night, at(1, 23))).toBe(true)
  expect(inHours(night, at(2, 5))).toBe(true) // Monday's window, early Tuesday
  expect(inHours(night, at(1, 5))).toBe(false) // Sunday's window, not configured
  expect(inHours(undefined, at(0, 3))).toBe(true)
  expect(() => parseHours('9-5')).toThrow()
  expect(() => parseHours('09:00-09:00')).toThrow()
})

// its own empty config, so a real one in the home directory can't change these results
const emptyConfig = `${dir}/empty-config.json`
writeFileSync(emptyConfig, '{}')
const base = { SLACK_INBOX_CONFIG: emptyConfig, HOME: dir }

test('tokens from env, and prefix checked', () => {
  const cfg = loadConfig({}, { ...base, SLACK_INBOX_APP_TOKEN: 'xapp-1', SLACK_INBOX_USER_TOKEN: 'xoxp-1', SLACK_INBOX_ALLOW_BOTS: 'B1, A2' })
  expect(cfg.appToken).toBe('xapp-1')
  expect([...cfg.allowBots]).toEqual(['B1', 'A2'])
  expect(cfg.hours).toBeUndefined()
  expect(() => loadConfig({}, { ...base, SLACK_INBOX_APP_TOKEN: 'xapp-1', SLACK_INBOX_USER_TOKEN: 'xoxb-1' })).toThrow(/xoxp-/)
  expect(() => loadConfig({}, { ...base, SLACK_INBOX_APP_TOKEN: 'xapp-1' })).toThrow(/SLACK_INBOX_USER_TOKEN/)
})

test('SLACK_INBOX_INCLUDE_OWN switches on logging every message the user posts', () => {
  const env = { ...base, SLACK_INBOX_APP_TOKEN: 'xapp-1', SLACK_INBOX_USER_TOKEN: 'xoxp-1' }
  expect(loadConfig({}, env).includeOwn).toBe(false)
  expect(loadConfig({}, { ...env, SLACK_INBOX_INCLUDE_OWN: '1' }).includeOwn).toBe(true)
  expect(loadConfig({}, { ...env, SLACK_INBOX_INCLUDE_OWN: 'false' }).includeOwn).toBe(false)
  expect(() => loadConfig({}, { ...env, SLACK_INBOX_INCLUDE_OWN: 'maybe' })).toThrow(/on\/off/)
})

test('token files must be private', () => {
  const f = `${dir}/user-token`
  writeFileSync(f, 'xoxp-2\n')
  chmodSync(f, 0o644)
  const env = { ...base, SLACK_INBOX_APP_TOKEN: 'xapp-1', SLACK_INBOX_USER_TOKEN_FILE: f }
  expect(() => loadConfig({}, env)).toThrow(/chmod 600/)
  chmodSync(f, 0o600)
  expect(loadConfig({}, env).userToken).toBe('xoxp-2')
})

test('config file, overridden by flags', () => {
  const f = `${dir}/config.json`
  writeFileSync(f, JSON.stringify({ hours: '08:00-17:00', days: 'mon-thu', allow_bots: ['B3'], log_file: '~/x.jsonl' }))
  const env = { ...base, SLACK_INBOX_APP_TOKEN: 'xapp-1', SLACK_INBOX_USER_TOKEN: 'xoxp-1' }
  const cfg = loadConfig({ config: f }, env)
  expect(cfg.hours?.start).toBe(480)
  expect([...cfg.allowBots]).toEqual(['B3'])
  expect(cfg.logFile).not.toStartWith('~')
  expect(loadConfig({ config: f, hours: '10:00-11:00' }, env).hours?.start).toBe(600)
  expect(() => loadConfig({ config: `${dir}/missing.json` }, env)).toThrow(/config/)
})

test('relay mode needs no app token, and its URL must be https unless it is this machine', () => {
  const env = { ...base, SLACK_INBOX_USER_TOKEN: 'xoxp-1' }
  expect(() => loadConfig({}, env)).toThrow(/SLACK_INBOX_APP_TOKEN/)
  const cfg = loadConfig({}, { ...env, SLACK_INBOX_RELAY_URL: 'https://relay.example' })
  expect(cfg.relayUrl).toBe('https://relay.example')
  expect(cfg.appToken).toBe('')
  expect(loadConfig({}, { ...env, SLACK_INBOX_RELAY_URL: 'http://127.0.0.1:8799' }).relayUrl).toBe('http://127.0.0.1:8799')
  expect(() => loadConfig({}, { ...env, SLACK_INBOX_RELAY_URL: 'http://relay.example' })).toThrow(/https/)
})
