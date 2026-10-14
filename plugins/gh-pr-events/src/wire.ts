// What the broker and the channels share: where the socket lives, and newline-delimited JSON over it.
import type { Socket } from 'bun'
import { chmodSync, lstatSync, mkdirSync, statSync } from 'node:fs'

export const log = (...a: unknown[]) => console.error('[gh-pr-events]', ...a) // stdout is the channel's MCP pipe

// read on use, not at import, so a test can point it elsewhere
export const stateDir = () => process.env.GH_PR_EVENTS_STATE_DIR ?? `${process.env.HOME}/.claude/state/gh-pr-events`
export const sockPath = () => `${stateDir()}/broker.sock`

// Holds the socket, log and pid file: whoever can write it can pose as the broker, so it must be ours alone.
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

// A bad line is logged and skipped, never thrown: in the broker a throw would take every session down with it.
export function lines(onMessage: (m: any) => unknown) {
  const dec = new TextDecoder() // stream mode keeps a multi-byte character split across chunks intact
  let buf = ''
  return (chunk: Uint8Array) => {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line))
      } catch (e) {
        log('bad message:', e)
      }
    }
  }
}

// Bun's socket.write sends what fits in the kernel buffer and drops the rest, so keep the rest and resend on drain.
// A peer that stops reading for good gets disconnected (and reconnects) rather than growing this without bound.
export function writer(sock: Socket<any>, max = 4 << 20) {
  let pending = Buffer.alloc(0)
  const flush = () => {
    if (pending.length) pending = pending.subarray(Math.max(sock.write(pending), 0))
  }
  const send = (m: object) => {
    pending = Buffer.concat([pending, Buffer.from(JSON.stringify(m) + '\n')])
    if (pending.length > max) {
      log('peer stopped reading, dropping it')
      pending = Buffer.alloc(0)
      sock.end()
    } else flush()
  }
  return { send, flush }
}
