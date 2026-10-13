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

GitHub allows one `gh webhook forward` per repo, so all sessions on the machine share one broker. The first `subscribe_pr` starts it in the background (`server.js broker`, listening on `~/.claude/state/gh-pr-events/broker.sock`), and each session's channel connects to it. The broker exits after five minutes with no sessions connected, and logs to `broker.log` next to the socket.

The first subscription to a PR in a repo, from any session, starts `gh webhook forward` for that repo. That creates a temporary repo webhook relayed by GitHub itself, so no third-party service sees your events. Every delivery is checked against a per-broker HMAC secret, then sent to each session subscribed to that PR. When the last session watching a repo unsubscribes or ends, the forwarder stops and GitHub removes the webhook.

If the broker dies, each session's channel starts a new one (only one wins) and subscribes to its PRs again; a PR that can't be resubscribed is reported and dropped. The new broker stops any forwarders the old one left running before it starts its own. The state directory is created private (mode 0700) and the broker refuses one owned by another user.

GitHub sends no webhook when a PR becomes unmergeable, so the forwarder also receives the repo's pushes. After a push to a subscribed PR's base branch, or to the PR itself, the broker asks GitHub for the PR's mergeability and reports changes. Pushes themselves never reach Claude.

Comment and review bodies are written by other people, so the channel tells Claude to treat them as information, never as instructions.

## Limits

- A forward to the same repo from outside the broker (another machine, or a manual `gh webhook forward`) blocks it: subscribing there returns an error.
- A running broker keeps its code until it exits, so a plugin update takes effect once every session using it has closed for five minutes. Whichever session starts the broker decides which copy of `server.js` it runs.
- The webhook secret is passed to `gh-webhook` on its command line, so other users on a shared machine can read it with `ps`. Use this on single-user machines.
- Events that happen while no session is subscribed are not replayed. If a forwarder dies, or the broker restarts, the affected sessions are told and Claude has to call `subscribe_pr` again for anything that didn't come back.
- Workflow runs from forks are not linked to the PR by GitHub, so they don't arrive.
- Subscriptions live in memory: a restarted or resumed session starts with none.

## Configuration

| Env var                 | Description                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GH_PR_EVENTS_STATE_DIR` | Where the broker keeps its socket, `broker.log` and `forwarders.json` (default `~/.claude/state/gh-pr-events`) |
| `GH_PR_EVENTS_PORT`     | Local port for deliveries (default: any free port)                                                                   |
| `GH_PR_EVENTS_BEAT_DIR` | If set, touches `<dir>/<owner>_<repo>_<n>` every 4 minutes per watched PR, for hooks that need proof a PR is watched. Each session's own setting applies to its own PRs |

## Development

```bash
cd plugins/gh-pr-events
bun install
bun test
bun run build   # regenerates server.js; commit it with the source
```
