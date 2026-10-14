#!/usr/bin/env bun
// Claude Code channel: pushes GitHub PR activity into the running session.
//
// Claude Code spawns `server.js` per session as a tiny stdio shim (shim.ts). GitHub allows one `gh webhook forward`
// per repo, so the shims share one daemon (`server.js daemon`, daemon.ts) on localhost, which any shim starts if
// none answers. The daemon gives each repo with a subscribed PR one forwarder (a GitHub-hosted relay; needs repo
// admin), verifies every delivery's HMAC, and sends each event to the sessions subscribed to its PR (events.ts turns
// payloads into summaries). It keeps subscriptions per Claude session id, which --resume keeps, and queues events
// for sessions that aren't connected. Opt-in only: nothing emits for a PR until a session calls subscribe_pr for it.
//
// Invariant:
// - each repo has at most one forwarder, running exactly while some live session (connected, or closed for less
//   than the TTL) subscribes to a PR in it;
// - a session gets every event for its PRs: live while connected, queued (up to 100) while not;
// - what a session is told it subscribes to matches the daemon's view (a subscription that dies is dropped, and the
//   session is told);
// - no forwarder or webhook outlives its last subscription, including across a daemon crash once the next one starts;
// - at most one daemon serves, and only shims holding its token can talk to it; a shim sends the token only to a
//   daemon that has proved it holds it, and a daemon is only replaced once its process is gone (a shim kills one
//   that stays alive but silent for 30s);
// - the newest running version serves: a shim older than the newest recorded version waits for that version's
//   daemon before starting its own, and gives up on it (a rollback) after about 10s.
//
// Env: GH_PR_EVENTS_STATE_DIR (daemon.json, sessions.json, daemon.log, forwarders.json, latest.json; default
//      ~/.claude/state/gh-pr-events), GH_PR_EVENTS_PORT (daemon port, default: any free port),
//      GH_PR_EVENTS_SESSION_TTL_HOURS (forget a closed session after this long, default 72),
//      GH_PR_EVENTS_BEAT_DIR - if set, touch <dir>/<owner>_<repo>_<n> every few minutes per watched PR
//      (lets a Stop hook check a PR is still being watched), GH_PR_EVENTS_FORWARDER and GH_PR_EVENTS_GH (tests only: stand-ins for gh-webhook and gh).
import { startDaemon } from './daemon'
import { shim } from './shim'
import { log } from './state'

if (process.argv[2] === 'daemon') {
  const d = await startDaemon()
  if (!d) {
    log('another daemon is already running')
    process.exit(0)
  }
  const quit = (why: unknown) => {
    log('exiting:', why)
    d.stop().finally(() => process.exit(0)) // stops the forwarders, so their webhooks go too
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => quit(sig))
  process.on('uncaughtException', quit)
  process.on('unhandledRejection', quit)
} else await shim()
