#!/usr/bin/env bun
// Claude Code channel: pushes GitHub PR activity into the running session.
//
// `server.js` runs as each session's channel (channel.ts). GitHub allows one `gh webhook forward` per repo, so the
// channels share one broker (`server.js broker`, broker.ts) over a unix socket; the first channel that finds none
// starts it detached, and it exits after five idle minutes. The broker gives each repo with a subscribed PR one
// forwarder (a GitHub-hosted relay; needs repo admin), verifies every delivery's HMAC, and sends each event to the
// sessions subscribed to its PR (events.ts turns payloads into summaries). Opt-in only: nothing emits for a PR
// until a session calls subscribe_pr for it.
//
// Invariant:
// - each repo has at most one forwarder, running exactly while some connected session subscribes to a PR in it;
// - a session gets every event for its PRs while the broker is up, and its channel's view of what it subscribes
//   to matches the broker's (a subscription that dies is dropped on both sides, and the session is told);
// - no forwarder or webhook outlives its last subscriber, including across a broker crash once the next one starts;
// - at most one broker serves the socket.
//
// Env: GH_PR_EVENTS_STATE_DIR (socket, broker.log, forwarders.json; default ~/.claude/state/gh-pr-events),
//      GH_PR_EVENTS_PORT (broker's webhook port, default: any free port),
//      GH_PR_EVENTS_BEAT_DIR - if set, touch <dir>/<owner>_<repo>_<n> every few minutes per watched PR
//      (lets a Stop hook check a PR is still being watched), GH_PR_EVENTS_FORWARDER (tests only: fake gh-webhook).
import { startBroker } from './broker'
import { channel } from './channel'
import { log } from './wire'

if (process.argv[2] === 'broker') {
  const b = await startBroker()
  if (!b) {
    log('another broker is already running')
    process.exit(0)
  }
  const quit = (why: unknown) => {
    log('exiting:', why)
    b.stop().finally(() => process.exit(0)) // stops the forwarders, so their webhooks go too
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => quit(sig))
  process.on('uncaughtException', quit)
  process.on('unhandledRejection', quit)
} else await channel()
