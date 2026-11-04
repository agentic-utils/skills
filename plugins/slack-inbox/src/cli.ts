#!/usr/bin/env bun
// slack-inbox run | check | relay-keygen [--config file] [--hours 09:00-18:00] [--days mon-fri] [--log file]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultRelayKeyFile, loadConfig, readSecretFile } from './config'
import { inHours } from './hours'
import { createPuller, generateRelayKeys, publicKeys, type RelayKeys } from './pull'
import { run } from './run'
import { myGroups, socketUrl, whoami } from './slack'

const USAGE = `usage: slack-inbox <run|check|relay-keygen> [--config file] [--hours HH:MM-HH:MM] [--days mon-fri] [--log file]

  run    listen and append one JSONL line per matching message to the log
  check  verify both tokens and the user token's scopes, then exit
  relay-keygen  create the private key for relay mode and print the public keys for the relay

Tokens are read from SLACK_INBOX_APP_TOKEN / SLACK_INBOX_USER_TOKEN, or from the
chmod 600 files named by SLACK_INBOX_APP_TOKEN_FILE / SLACK_INBOX_USER_TOKEN_FILE.`

function relayKeygen() {
  const path = process.env.SLACK_INBOX_RELAY_KEY_FILE ?? defaultRelayKeyFile()
  if (existsSync(path)) throw new Error(`${path} already exists; a new key could not read what is queued, so remove it yourself if you mean to`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const keys = generateRelayKeys()
  writeFileSync(path, JSON.stringify(keys), { mode: 0o600 })
  const pub = publicKeys(keys)
  console.log(`private key: ${path} (keep it on this machine)`)
  console.log(`RELAY_SEAL_PUBLIC_KEY=${pub.seal}`)
  console.log(`RELAY_VERIFY_PUBLIC_KEY=${pub.verify}`)
}

async function check(flags: Parameters<typeof loadConfig>[0]) {
  const cfg = loadConfig(flags)
  const id = await whoami(cfg.userToken)
  console.log(`user token: ok, user ${id.userId} in ${id.url}`)
  if (id.missingScopes.length) console.log(`user token: MISSING scopes ${id.missingScopes.join(', ')}`)
  if (id.missingSubscribeScopes.length)
    console.log(`user token: without ${id.missingSubscribeScopes.join(', ')}, subscribe_conversation can't check membership there (optional)`)
  const groups = await myGroups(cfg.userToken, id.userId)
  console.log(`user groups: member of ${groups.size}`)
  if (cfg.relayUrl) {
    // a throwaway handler and cursor: this drains nothing the real listener will miss, as its cursor is its own
    const res = await createPuller({ url: cfg.relayUrl, keys: JSON.parse(readSecretFile(cfg.relayKeyFile)) as RelayKeys, cursorFile: '/dev/null', handle: async () => {}, log: () => {} }).pull()
    console.log(res.error ? `relay: FAILED ${res.error}` : `relay: ok, pulling from ${cfg.relayUrl}`)
    if (res.error) process.exit(1)
  } else {
    await socketUrl(cfg.appToken) // an unused URL just expires
    console.log('app token: ok, Socket Mode connection allowed')
  }
  console.log(`log file: ${cfg.logFile}`)
  console.log(`working hours: ${cfg.hours ? (inHours(cfg.hours, new Date()) ? 'inside now' : 'outside now') : 'always on'}`)
  if (id.missingScopes.length) process.exit(1)
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { config: { type: 'string' }, hours: { type: 'string' }, days: { type: 'string' }, log: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
})
const cmd = positionals[0]
try {
  if (values.help || !cmd) console.log(USAGE)
  else if (cmd === 'run') await run(loadConfig(values))
  else if (cmd === 'check') await check(values)
  else if (cmd === 'relay-keygen') relayKeygen()
  else {
    console.error(USAGE)
    process.exit(2)
  }
} catch (e) {
  console.error(`slack-inbox: ${(e as Error).message}`)
  process.exit(1)
}
