#!/usr/bin/env bun
// slack-inbox run | check | relay-keygen | replay [--config file] [--hours 09:00-18:00] [--days mon-fri] [--log file]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultRelayKeyFile, loadConfig, readSecretFile } from './config'
import { inHours } from './hours'
import { createPuller, generateRelayKeys, publicKeys, type RelayKeys } from './pull'
import { parseWhen, replay } from './replay'
import { run } from './run'
import { inThread, myGroups, socketUrl, userName, whoami } from './slack'

const USAGE = `usage: slack-inbox <run|check|relay-keygen|replay> [--config file] [--hours HH:MM-HH:MM] [--days mon-fri] [--log file]

  run    listen and append one JSONL line per matching message to the log
  check  verify both tokens and the user token's scopes, then exit
  relay-keygen  create the private key for relay mode and print the public keys for the relay
  replay --since 2d [--until time] [--channel id] [--all] [--out file]
         write what the relay still holds to a file of its own, in full; --all for every message, not only yours

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
    await createPuller({ url: cfg.relayUrl, keys: JSON.parse(readSecretFile(cfg.relayKeyFile)) as RelayKeys, cursorFile: '/dev/null', handle: async () => {}, log: () => {} }).ping()
    console.log(`relay: ok, pulling from ${cfg.relayUrl}`)
  } else {
    await socketUrl(cfg.appToken) // an unused URL just expires
    console.log('app token: ok, Socket Mode connection allowed')
  }
  console.log(`log file: ${cfg.logFile}`)
  console.log(`working hours: ${cfg.hours ? (inHours(cfg.hours, new Date()) ? 'inside now' : 'outside now') : 'always on'}`)
  if (id.missingScopes.length) process.exit(1)
}

async function replayCommand(v: { since?: string; until?: string; channel?: string; all?: boolean; out?: string } & Parameters<typeof loadConfig>[0]) {
  if (!v.since) throw new Error('replay needs --since, such as --since 2d')
  const cfg = loadConfig(v)
  if (!cfg.relayUrl) throw new Error('replay reads the relay, and no relay_url is set')
  const now = Date.now()
  const id = await whoami(cfg.userToken)
  const outFile = v.out ?? `${dirname(cfg.logFile)}/replay-${new Date(now).toISOString().replace(/[:.]/g, '-')}.jsonl`
  let lookupsFailed = 0
  const r = await replay({
    url: cfg.relayUrl,
    keys: JSON.parse(readSecretFile(cfg.relayKeyFile)) as RelayKeys,
    me: { userId: id.userId, teamId: id.teamId, enterpriseId: id.enterpriseId },
    teamUrl: id.url,
    allowBots: cfg.allowBots,
    groups: await myGroups(cfg.userToken, id.userId),
    userInThread: async (channel, ts) => {
      try {
        return await inThread(cfg.userToken, id.userId, channel, ts)
      } catch {
        lookupsFailed++
        return false
      }
    },
    userName: u => userName(cfg.userToken, u),
    filter: { since: parseWhen(v.since, now), until: v.until ? parseWhen(v.until, now) : undefined, channel: v.channel, all: v.all === true },
    outFile,
    log: m => console.error(m),
  })
  // counts only: the file holds other people's messages, so its text never goes to a terminal or a transcript
  console.log(`${r.written} message${r.written === 1 ? '' : 's'} written to ${outFile}`)
  if (r.expired) console.log(`${r.expired} older event${r.expired === 1 ? '' : 's'} had already gone from the relay`)
  if (r.skipped) console.log(`${r.skipped} event${r.skipped === 1 ? '' : 's'} could not be opened or handled`)
  if (lookupsFailed) console.log(`${lookupsFailed} thread lookup${lookupsFailed === 1 ? '' : 's'} failed, so replies there may be missing`)
  if (r.error) throw new Error(`stopped early, so this is incomplete: ${r.error}`)
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    hours: { type: 'string' },
    days: { type: 'string' },
    log: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    since: { type: 'string' },
    until: { type: 'string' },
    channel: { type: 'string' },
    all: { type: 'boolean' },
    out: { type: 'string' },
  },
})
const cmd = positionals[0]
try {
  if (values.help || !cmd) console.log(USAGE)
  else if (cmd === 'run') await run(loadConfig(values))
  else if (cmd === 'check') await check(values)
  else if (cmd === 'relay-keygen') relayKeygen()
  else if (cmd === 'replay') await replayCommand(values)
  else {
    console.error(USAGE)
    process.exit(2)
  }
} catch (e) {
  console.error(`slack-inbox: ${(e as Error).message}`)
  process.exit(1)
}
