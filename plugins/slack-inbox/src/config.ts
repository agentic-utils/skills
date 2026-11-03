// Settings come from flags, then env, then a JSON config file, then defaults. Tokens come only from env or 0600 files.
import { readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { type Hours, parseHours } from './hours'

export type Config = {
  appToken: string
  userToken: string
  logFile: string
  stateDir: string
  allowBots: Set<string>
  groupRefreshMinutes: number
  previewChars: number
  hours?: Hours
}

type FileConfig = {
  app_token_file?: string
  user_token_file?: string
  log_file?: string
  state_dir?: string
  allow_bots?: string[]
  group_refresh_minutes?: number
  preview_chars?: number
  hours?: string
  days?: string
}

type Env = Record<string, string | undefined>

const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir())

export const defaultLogFile = () =>
  platform() === 'darwin' ? `${homedir()}/Library/Logs/slack-inbox/events.jsonl` : `${homedir()}/.local/state/slack-inbox/events.jsonl`

// A token file anyone else can read is refused rather than used, so a leaked file is noticed instead of tolerated.
export function readSecretFile(path: string): string {
  const p = expand(path)
  const st = statSync(p)
  if (st.mode & 0o077) throw new Error(`${p} is readable by others (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 ${p}`)
  return readFileSync(p, 'utf8').trim()
}

function token(env: Env, name: string, file: string | undefined, prefix: string, what: string): string {
  const fromFile = env[`${name}_FILE`] ?? file
  const value = env[name] ?? (fromFile ? readSecretFile(fromFile) : undefined)
  if (!value) throw new Error(`no ${what}: set ${name} or ${name}_FILE (a chmod 600 file)`)
  if (!value.startsWith(prefix)) throw new Error(`${name} should start with ${prefix} (${what})`)
  return value
}

export type Flags = { config?: string; hours?: string; days?: string; log?: string }

function readFileConfig(flags: Flags, env: Env): FileConfig {
  const path = flags.config ?? env.SLACK_INBOX_CONFIG ?? `${homedir()}/.config/slack-inbox/config.json`
  try {
    return JSON.parse(readFileSync(expand(path), 'utf8'))
  } catch (e) {
    // a missing default file is fine; one named on purpose, or one that doesn't parse, is not
    if ((e as { code?: string }).code !== 'ENOENT' || flags.config || env.SLACK_INBOX_CONFIG) throw new Error(`config ${path}: ${(e as Error).message}`)
    return {}
  }
}

const logFileOf = (flags: Flags, env: Env, file: FileConfig) => expand(flags.log ?? env.SLACK_INBOX_LOG ?? file.log_file ?? defaultLogFile())
const stateDirOf = (env: Env, file: FileConfig) => expand(env.SLACK_INBOX_STATE_DIR ?? file.state_dir ?? `${homedir()}/.local/state/slack-inbox`)

export type Paths = { logFile: string; stateDir: string; userToken?: string }

// What a session's channel server needs: where the listener logs and keeps state, resolved the same way the
// listener resolves them (so settings that differ must live in the config file, not only in the LaunchAgent's env),
// and the user token if one can be found, for checking a conversation before subscribing. Never throws on a token.
export function loadPaths(env: Env = process.env): Paths {
  const file = readFileConfig({}, env)
  let userToken: string | undefined
  try {
    userToken = token(env, 'SLACK_INBOX_USER_TOKEN', file.user_token_file ?? `${homedir()}/.config/slack-inbox/user-token`, 'xoxp-', 'user token')
  } catch {}
  return { logFile: logFileOf({}, env, file), stateDir: stateDirOf(env, file), userToken }
}

export function loadConfig(flags: Flags, env: Env = process.env): Config {
  const file = readFileConfig(flags, env)
  const hours = flags.hours ?? env.SLACK_INBOX_HOURS ?? file.hours
  const days = flags.days ?? env.SLACK_INBOX_DAYS ?? file.days
  const allow = env.SLACK_INBOX_ALLOW_BOTS?.split(',') ?? file.allow_bots ?? []
  const num = (v: string | number | undefined, d: number, min: number) => {
    const n = Number(v ?? d)
    if (!Number.isFinite(n) || n < min) throw new Error(`bad number ${v}`)
    return n
  }
  return {
    appToken: token(env, 'SLACK_INBOX_APP_TOKEN', file.app_token_file, 'xapp-', 'app-level token with connections:write'),
    userToken: token(env, 'SLACK_INBOX_USER_TOKEN', file.user_token_file, 'xoxp-', 'user token from the same app'),
    logFile: logFileOf(flags, env, file),
    stateDir: stateDirOf(env, file),
    allowBots: new Set(allow.map(s => s.trim()).filter(Boolean)),
    groupRefreshMinutes: num(env.SLACK_INBOX_GROUP_REFRESH_MINUTES ?? file.group_refresh_minutes, 30, 1),
    previewChars: num(env.SLACK_INBOX_PREVIEW_CHARS ?? file.preview_chars, 200, 20),
    hours: hours ? parseHours(hours, days) : undefined,
  }
}
