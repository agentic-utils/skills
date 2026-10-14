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
//   than the TTL) subscribes to a PR in it; one that exits (as gh-webhook does whenever its connection drops) is
//   restarted, and its subscriptions dropped only after 10 failed restarts in a row;
// - a session gets every event for its PRs: live while connected, queued (up to 100) while not;
// - a merged PR stays subscribed for the grace window (60 min) so late reviews and bot comments still arrive, then
//   is unsubscribed, its sessions told; one closed without merging stays subscribed for the reopen window (24h) and
//   is unsubscribed, its sessions told, if it isn't reopened in time; both windows survive a restart and are
//   covered by catch-ups, and a forwarder kept only for such a PR stops when its window ends;
// - nothing is lost to a gap, while the machine slept (a 5s timer firing over 30s late), a forwarder was down, or no
//   daemon ran: the gap opens at the last moment each PR had everything, and live events don't close it; once the
//   forwarder is back, each PR is caught up from GitHub's API (issue events, comments, review comments, reviews,
//   head moves, CI) from the gap's start, recovered events are marked as such, and a catch-up that keeps failing
//   tells the PR's sessions and leaves the gap open; one that finishes after the PR fell behind again leaves the new
//   gap open too. GitHub deletes a forwarder's webhook, delivery log included,
//   as soon as its connection dies, so that log is no use;
// - a catch-up never repeats an event already delivered (kept per PR in sessions.json, matched by id, or for a PR
//   action by kind and time), and live events are never dropped as repeats of each other;
// - once stop() begins, no forwarder is started, so none outlives the daemon;
// - what a session is told it subscribes to matches the daemon's view (a subscription that dies is dropped, and the
//   session is told);
// - no forwarder or webhook outlives its last subscription, including across a daemon crash once the next one starts;
// - at most one daemon serves, and only shims holding its token can talk to it; a shim sends the token only to a
//   daemon that has proved it holds it, and a daemon is only replaced once its process is gone (a shim kills one
//   that stays alive but silent for 30s);
// - the newest running version serves: a shim older than the newest recorded version waits for that version's
//   daemon before starting its own, and gives up on it (a rollback) after about 10s.
//
// Env (named after the plugin's old name, gh-pr-events, so existing settings keep working): GH_PR_EVENTS_STATE_DIR (daemon.json, sessions.json, daemon.log, forwarders.json, latest.json; default
//      ~/.claude/state/pr-events), GH_PR_EVENTS_PORT (daemon port, default: any free port),
//      GH_PR_EVENTS_SESSION_TTL_HOURS (forget a closed session after this long, default 72),
//      GH_PR_EVENTS_REOPEN_HOURS (keep a PR closed without merging subscribed this long, default 24),
//      GH_PR_EVENTS_MERGED_GRACE_MINUTES (keep a merged PR subscribed this long for late comments, default 60),
//      GH_PR_EVENTS_BEAT_DIR - if set, touch <dir>/<owner>_<repo>_<n> every few minutes per watched PR
//      (lets a Stop hook check a PR is still being watched), GH_PR_EVENTS_FORWARDER and GH_PR_EVENTS_GH (tests only: stand-ins for gh-webhook and gh),
//      GH_PR_EVENTS_GAP_MS and GH_PR_EVENTS_RETRY_MS (tests only: how late the 5s timer must fire to count as a
//      sleep, default 30000; the wait between catch-up attempts, default 30000).
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
  log(`daemon ${process.pid} ready`) // state loaded and signals handled; tests wait for this line
} else await shim()
