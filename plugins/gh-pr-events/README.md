# gh-pr-events

A Claude Code [channel](https://code.claude.com/docs/en/channels) that pushes GitHub pull request activity into a running session. Claude subscribes to the PRs it cares about and reacts as comments, reviews and CI results land, with no polling.

## Tools

| Tool             | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `subscribe_pr`   | Start pushing a PR's events (takes a PR URL or `owner/repo#number`) |
| `unsubscribe_pr` | Stop pushing a PR's events                                          |

A subscribed PR delivers:

- PR opened, merged, closed, reopened, marked ready for review or converted to draft (merged or closed also unsubscribes it)
- Reviews with a body or a verdict (approved, changes requested), dismissed reviews, review comments, and review threads resolved or reopened
- Review requests made or withdrawn
- New commits pushed to the PR, with force pushes called out as rewriting history
- Labels added or removed, auto-merge switched on or off, and the PR entering or leaving the merge queue (with the reason)
- Merge conflicts: when a push to the base branch makes the PR unmergeable, and again when that clears. A PR that already has conflicts is reported when it's subscribed
- PR conversation comments
- Each finished GitHub Actions workflow (name, result, run link), and check suites from other apps

Cancelled and skipped runs are left out, and so are title or description edits, assignee changes and the empty reviews GitHub creates when someone replies in a review thread.

## Install

```bash
claude plugin install @agentic-utils/agentic-utils-gh-pr-events
gh extension install cli/gh-webhook
```

Custom channels are a research preview, so start Claude Code with the development-channels flag every session:

```bash
claude --dangerously-load-development-channels plugin:agentic-utils-gh-pr-events@agentic-utils
```

That flag shows a confirmation prompt each time. To skip it, allow the plugin in managed settings (`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, needs sudo) and use `--channels` instead:

```json
{ "allowedChannelPlugins": [{ "marketplace": "agentic-utils", "plugin": "agentic-utils-gh-pr-events" }] }
```

Without either flag the tools still work, but Claude Code silently drops every event.

## Requirements

- [Bun](https://bun.sh) (runs the bundled `server.js`)
- [gh](https://cli.github.com) logged in, with the [gh-webhook](https://github.com/cli/gh-webhook) extension
- Admin on each repo whose PRs you subscribe to

## How it works

Claude Code starts `server.js` once per session. That process is a small shim: it speaks just enough MCP over stdio and passes everything to one daemon per machine (`server.js daemon`) on localhost. The first shim that finds no daemon starts it in the background. The daemon writes its port and a random token to `~/.claude/state/gh-pr-events/daemon.json` (mode 0600 in a 0700 dir), and every request has to carry that token. Before sending it, a shim has the daemon prove it already holds the token (an HMAC of a random challenge), so a process that grabs the port after the daemon dies never sees it.

The first subscription to a PR in a repo, from any session, starts `gh webhook forward` for that repo. That creates a temporary repo webhook relayed by GitHub itself, so no third-party service sees your events. The daemon checks every delivery against a per-daemon HMAC secret and sends it to each session subscribed to that PR. When the last subscription in a repo goes, the forwarder stops and GitHub removes the webhook.

Subscriptions belong to a Claude session, identified by the `CLAUDE_CODE_SESSION_ID` Claude Code gives its MCP servers. `--resume` and `--continue` keep that id, so a resumed session gets its subscriptions back, and a second window open on the same session shares them. While a session is closed, the daemon keeps forwarding and queues up to 100 events for it, delivered when it reconnects. Queued events, comment and review text included, are stored in `sessions.json` (mode 0600) until then. Each time a session connects it is told which PRs it's watching. A session closed for longer than 72 hours is forgotten; if it comes back within another 72 hours it is told which subscriptions it lost. Without `CLAUDE_CODE_SESSION_ID` (older Claude Code), subscriptions end with the session. The daemon exits five minutes after nothing is subscribed or connected.

If the daemon dies, each shim starts a new one (only one wins) and reconnects. A daemon that is still running but not answering is left alone at first: tool calls fail fast with an error, and a shim kills it once it has stayed silent for 30 seconds. The new daemon restores the saved subscriptions, and stops any forwarders the old one left running before it starts its own. Shims record the newest plugin version they've seen in `latest.json`. After a plugin update, the first new shim replaces the running daemon. A shim from an older version, still running in another session, waits up to 10 seconds for the newer daemon to come back before it starts its own, so it can't bring the old version back. If no newer shim is around (for example after a rollback), it starts its own version and records that instead.

GitHub sends no webhook when a PR becomes unmergeable, so the forwarder also receives the repo's pushes. After a push to a subscribed PR's base branch, or to the PR itself, the daemon asks GitHub for the PR's mergeability and reports changes. Pushes themselves never reach Claude.

Comment and review bodies are written by other people, so the plugin tells Claude to treat them as information, never as instructions.

## Limits

- Events are only queued while the daemon runs: anything that arrives while the machine is off or asleep is lost.
- A forward to the same repo from outside the daemon (another machine, or a manual `gh webhook forward`) blocks it: subscribing there returns an error.
- The webhook secret is passed to `gh-webhook` on its command line, so other users on a shared machine can read it with `ps`. Use this on single-user machines.
- If a forwarder dies, its subscriptions are dropped and their sessions told; Claude has to call `subscribe_pr` again.
- GitHub computes mergeability lazily: the daemon retries for about 15s after a push, so a slow recompute can miss a conflict.
- Workflow runs from forks are not linked to the PR by GitHub, so they don't arrive.
- macOS and Linux. Windows is not supported yet.
- Sessions still running 1.x use the old broker, which can hold a forward the 2.0 daemon then can't take. Restart them after updating.

## Configuration

| Env var                          | Description                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GH_PR_EVENTS_STATE_DIR`         | Where the daemon keeps `daemon.json`, `sessions.json`, `forwarders.json`, `latest.json` and `daemon.log` (default `~/.claude/state/gh-pr-events`) |
| `GH_PR_EVENTS_PORT`              | Daemon port (default: any free port)                                                                                |
| `GH_PR_EVENTS_SESSION_TTL_HOURS` | Forget a closed session's subscriptions after this long (default 72)                                                |
| `GH_PR_EVENTS_BEAT_DIR`          | If set, touches `<dir>/<owner>_<repo>_<n>` every 4 minutes per watched PR while its session is connected, for hooks that need proof a PR is watched |

## Development

```bash
cd plugins/gh-pr-events
bun test
bun run build   # regenerates server.js; commit it with the source (CI checks they match)
```
