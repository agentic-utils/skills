// What the daemon and the shims share: the private state dir, the daemon's address file and how to check it.
import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'

export const log = (...a: unknown[]) => console.error('[pr-events]', ...a) // stdout is the shim's MCP pipe

// read on use, not at import, so a test can point it elsewhere
export const stateDir = () => process.env.GH_PR_EVENTS_STATE_DIR ?? `${process.env.HOME}/.claude/state/pr-events`

// Holds the daemon's token and pid files: whoever can read it can talk to the daemon, so it must be ours alone.
export function privateStateDir(): string {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // ponytail: checks the dir itself, not its parents; point GH_PR_EVENTS_STATE_DIR only at a path under your home
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symlink`)
  const st = statSync(dir)
  if (st.uid !== process.getuid!()) throw new Error(`${dir} belongs to another user`)
  if (st.mode & 0o077) chmodSync(dir, 0o700)
  return dir
}

// Where a running daemon listens, and the token every request must carry.
export type DaemonInfo = { pid: number; port: number; token: string; version: string }
export const daemonFile = () => `${stateDir()}/daemon.json`

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// Written whole or not at all, so a reader never sees half a file, and synced first so a crash can't leave it empty.
export function writeJson(path: string, value: unknown) {
  const fd = openSync(`${path}.tmp`, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(`${path}.tmp`, path)
}

export const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

// A daemon proves it holds the token by keying an HMAC of the caller's random challenge with it, so nobody gets
// sent the token (or trusted) just for listening on the port daemon.json names.
export const proof = (token: string, challenge: string) => createHmac('sha256', token).update(`pr-events info ${challenge}`).digest('hex')

// The daemon `info` names, if it answers as that daemon; null if it doesn't, or not within a second.
export async function reachable(info: DaemonInfo | null): Promise<{ version: string; pid: number } | null> {
  if (!info || typeof info.token !== 'string') return null
  const challenge = randomBytes(16).toString('hex')
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/info`, { headers: { 'x-challenge': challenge }, signal: AbortSignal.timeout(1000) })
    const got = r.ok ? ((await r.json()) as { version: string; pid: number; proof: string }) : null
    return got?.proof === proof(info.token, challenge) && got.pid === info.pid ? got : null
  } catch {
    return null
  }
}

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Whether pid is a running pr-events daemon (any 3.x version), checked by its argv so a reused pid doesn't count: the
// plugin's cache dir (agentic-utils-github/<version>) or a checkout's plugins/github.
export const isDaemon = (pid: unknown) =>
  Number.isInteger(pid) &&
  (pid as number) > 1 &&
  alive(pid as number) &&
  /(agentic-utils-github|plugins\/github)\/(.+\/)?server\.[jt]s daemon$/.test(Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)]).stdout.toString().trim())
