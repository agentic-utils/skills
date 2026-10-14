# github

A Claude Code [channel](https://code.claude.com/docs/en/channels) that pushes GitHub pull request activity into a running session. Claude subscribes to the PRs it cares about and reacts as comments, reviews and CI results land, with no polling.

## Tools

| Tool             | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `subscribe_pr`   | Start pushing a PR's events (takes a PR URL or `owner/repo#number`) |
| `unsubscribe_pr` | Stop pushing a PR's events                                          |

A subscribed PR delivers:

- PR opened, merged, closed, reopened, marked ready for review or converted to draft. A merged PR stays subscribed for 60 minutes, so late reviews and bot comments still arrive; the merge notice says until when, and when the window ends the session is told and the PR unsubscribed (`unsubscribe_pr` ends it sooner). A PR closed without merging stays subscribed for 24 hours in case it's reopened, then is unsubscribed and its session told
- Reviews with a body or a verdict (approved, changes requested), dismissed reviews, review comments, and review threads resolved or reopened
- Review requests made or withdrawn
- New commits pushed to the PR, with force pushes called out as rewriting history
- Labels added or removed, auto-merge switched on or off, and the PR entering or leaving the merge queue (with the reason)
- Merge conflicts: when a push to the base branch makes the PR unmergeable, and again when that clears. A PR that already has conflicts is reported when it's subscribed
- PR conversation comments
- Each finished GitHub Actions workflow (name, result, run link), and check suites from other apps

Each event starts with the PR's name (`owner/repo#number`), so you can tell which PR it's about even where Claude Code cuts the line short at the terminal width. Claude Code renders no markdown or links in these lines, so the full PR URL follows, for Claude.

Cancelled and skipped runs are left out, and so are title or description edits, assignee changes and the empty reviews GitHub creates when someone replies in a review thread.

## Install

```bash
claude plugin install @agentic-utils/agentic-utils-github
gh extension install cli/gh-webhook
```

Custom channels are a research preview, so start Claude Code with the development-channels flag every session:

```bash
claude --dangerously-load-development-channels plugin:agentic-utils-github@agentic-utils
```

That flag shows a confirmation prompt each time. To skip it, allow the plugin in managed settings (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, needs sudo) and use `--channels` instead:

```json
{ "allowedChannelPlugins": [{ "marketplace": "agentic-utils", "plugin": "agentic-utils-github" }] }
```

Without either flag the tools still work, but Claude Code silently drops every event.

## Requirements

- [Bun](https://bun.sh) (runs the bundled `server.js`)
- [gh](https://cli.github.com) logged in, with the [gh-webhook](https://github.com/cli/gh-webhook) extension
- Admin on a repo for live events; without it (or when someone else holds the repo's forward) its PRs are polled

## How it works

Claude Code starts `server.js` once per session. That process is a small shim: it speaks just enough MCP over stdio and passes everything to one daemon per machine (`server.js daemon`) on localhost. The first shim that finds no daemon starts it in the background. The daemon writes its port and a random token to `~/.claude/state/pr-events/daemon.json` (mode 0600 in a 0700 dir), and every request has to carry that token. Before sending it, a shim has the daemon prove it already holds the token (an HMAC of a random challenge), so a process that grabs the port after the daemon dies never sees it.

The first subscription to a PR in a repo, from any session, starts `gh webhook forward` for that repo. That creates a temporary repo webhook relayed by GitHub itself, so no third-party service sees your events. The daemon checks every delivery against a per-daemon HMAC secret and sends it to each session subscribed to that PR. When the last subscription in a repo goes, the forwarder stops and GitHub removes the webhook.

Subscriptions belong to a Claude session, identified by the `CLAUDE_CODE_SESSION_ID` Claude Code gives its MCP servers. `--resume` and `--continue` keep that id, so a resumed session gets its subscriptions back, and a second window open on the same session shares them. While a session is closed, the daemon keeps forwarding and queues up to 100 events for it, delivered when it reconnects. Queued events, comment and review text included, are stored in `sessions.json` (mode 0600) until then. When a session connects it is told which PRs it's watching; reconnecting to the same daemon repeats that only if its subscriptions changed or it missed events while away. A session closed for longer than 72 hours is forgotten; if it comes back within another 72 hours it is told which subscriptions it lost. Without `CLAUDE_CODE_SESSION_ID` (older Claude Code), subscriptions end with the session. The daemon exits five minutes after nothing is subscribed or connected.

If the daemon dies, each shim starts a new one (only one wins) and reconnects. A daemon that is still running but not answering is left alone at first: tool calls fail fast with an error, and a shim kills it once it has stayed silent for 30 seconds. The new daemon restores the saved subscriptions, and stops any forwarders the old one left running before it starts its own. Shims record the newest plugin version they've seen in `latest.json`. After a plugin update, the first new shim replaces the running daemon. A shim from an older version, still running in another session, waits up to 10 seconds for the newer daemon to come back before it starts its own, so it can't bring the old version back. If no newer shim is around (for example after a rollback), it starts its own version and records that instead.

`gh webhook forward` exits whenever its connection to GitHub drops (a sleep, a network change), and GitHub deletes its webhook, delivery log included, as soon as the connection dies. So the daemon restarts a forwarder that exits, retrying for about six minutes before it drops the repo's subscriptions and tells their sessions. It also watches for sleeps: a 5-second timer that fires more than 30 seconds late means the machine was asleep, and the daemon restarts every forwarder. Each of these, and a new daemon starting, opens a gap for the repo's PRs at the last moment each had all its events; live events that arrive meanwhile don't close it. Once the forwarder is back, the daemon catches each PR up from GitHub's API under your `gh` login, from the start of its gap: issue events (merged, closed, reopened, draft changes, labels, review requests, auto-merge, the merge queue), comments, review comments, reviews, new commits (including force pushes, named after the head commit's author) and finished CI, including workflow runs started during the gap. These go through the same path as live webhooks, prefixed `(recovered after a gap)`. Each PR keeps its recently delivered events in `sessions.json`, so a catch-up never repeats one, whether it arrived live, recovered, or before a restart. Live events are never dropped as repeats of each other; a recovered PR action counts as the live one of the same kind closest to it in time, within two minutes. If a catch-up still fails after five tries, the PR's sessions are told which PR, from when, and why, and the gap stays open for the next restart to retry.

GitHub allows one `gh webhook forward` per repo, and only for admins. When it refuses one (a colleague or another machine already holds the repo's forward, or you aren't admin), the subscription still succeeds and the repo is polled instead: the session is told once (`pr-events: polling owner/repo#n every 60s (forward unavailable: <reason>)`), and every 60 seconds each PR is caught up through the same path as after a gap, with the same summaries and no repeats. Each poll first asks GitHub whether the PR or its head's CI changed, with a conditional request (ETag), so an unchanged PR costs a 304 that doesn't count against the rate limit; a full catch-up runs anyway every five minutes. If GitHub sends `X-Poll-Interval` or `Retry-After`, polling waits that long. The forward is retried every five minutes, and once it starts the repo switches back to live events, catching up from the last poll first.

GitHub sends no webhook when a PR becomes unmergeable, so the forwarder also receives the repo's pushes. After a push to a subscribed PR's base branch, or to the PR itself, the daemon asks GitHub for the PR's mergeability and reports changes. Pushes themselves never reach Claude.

After a merge the daemon keeps the PR subscribed for a grace window (60 minutes by default), because bot reviewers and colleagues often comment seconds to minutes after a merge. The merge time is saved in `sessions.json`, so the window survives a daemon restart, and a catch-up after a sleep or restart covers it like any other subscription. When it ends, each session gets one `stopped watching <pr>, merged <n>m ago` notice and the subscription is dropped; if nothing else in the repo is subscribed, its forwarder stops then too.

Comment and review bodies are written by other people, so the plugin tells Claude to treat them as information, never as instructions.

## Limits

- What a sleep, a dead forwarder or a stopped daemon missed is recovered from the PR API, which doesn't cover everything a webhook would: dismissed reviews, resolved review threads, and the reasons auto-merge was switched off or a PR left the merge queue are not recovered. CI is recovered on the PR's head before and after the gap, plus any workflow run started during it; check suites from other apps on a head pushed and replaced within the gap are not.
- If a dying forwarder hands over a PR action (a label, say) after a catch-up has already recovered it, it arrives twice. Live PR actions are never dropped as repeats, so that a real repeat is never lost.
- Catching up needs gh 2.48 or later (`gh api --slurp`); with an older gh the daemon logs it, and each catch-up tells its sessions so.
- A repo shared with someone else's forward (another machine, a colleague, or a manual `gh webhook forward`), or one you aren't admin on, is polled: events arrive up to about a minute late (longer if GitHub asks for a longer poll interval), and only what the catch-up recovers (see above) arrives at all.
- The webhook secret is passed to `gh-webhook` on its command line, so other users on a shared machine can read it with `ps`. Use this on single-user machines.
- If a forwarder can't be restarted for about six minutes (offline for that long, say), its subscriptions are dropped and their sessions told; Claude has to call `subscribe_pr` again.
- GitHub computes mergeability lazily: the daemon retries for about 15s after a push, so a slow recompute can miss a conflict.
- Workflow runs from forks are not linked to the PR by GitHub, so they don't arrive.
- macOS and Linux. Windows is not supported yet.
- Up to 2.x this plugin was `agentic-utils-gh-pr-events`. 3.0 keeps its state in a new place, so subscriptions don't carry over: Claude subscribes again. Sessions still running the old plugin keep its daemon, which can hold a repo's forward that 3.0 then can't take, so uninstall it and restart them. The `GH_PR_EVENTS_*` environment variables keep their names.

## Configuration

| Env var                          | Description                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GH_PR_EVENTS_STATE_DIR`         | Where the daemon keeps `daemon.json`, `sessions.json`, `forwarders.json`, `latest.json` and `daemon.log` (default `~/.claude/state/pr-events`) |
| `GH_PR_EVENTS_PORT`              | Daemon port (default: any free port)                                                                                |
| `GH_PR_EVENTS_SESSION_TTL_HOURS` | Forget a closed session's subscriptions after this long (default 72)                                                |
| `GH_PR_EVENTS_REOPEN_HOURS`      | Keep a PR closed without merging subscribed this long in case it's reopened (default 24)                            |
| `GH_PR_EVENTS_MERGED_GRACE_MINUTES` | Keep a merged PR subscribed this long for late reviews and comments (default 60)                          |
| `GH_PR_EVENTS_POLL_SECONDS`      | How often a repo that can't be forwarded is polled (default 60)                                                     |
| `GH_PR_EVENTS_BEAT_DIR`          | If set, touches `<dir>/<owner>_<repo>_<n>` every 4 minutes per watched PR while its session is connected, for hooks that need proof a PR is watched |

## Development

```bash
cd plugins/github
bun test
bun run build   # regenerates server.js; commit it with the source (CI checks they match)
```
