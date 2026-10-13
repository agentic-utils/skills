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

Without the flag the tools still work, but Claude Code silently drops every event.

## Requirements

- [Bun](https://bun.sh) (runs the bundled `server.js`)
- [gh](https://cli.github.com) logged in, with the [gh-webhook](https://github.com/cli/gh-webhook) extension
- Admin on each repo whose PRs you subscribe to

## How it works

The first `subscribe_pr` in a repo starts `gh webhook forward` for that repo. That creates a temporary repo webhook relayed by GitHub itself, so no third-party service sees your events. Every delivery is checked against a per-session HMAC secret. When the last PR in a repo is unsubscribed, or the session ends, the forwarder stops and GitHub removes the webhook. Idle sessions hold no webhook.

GitHub sends no webhook when a PR becomes unmergeable, so the forwarder also receives the repo's pushes. After a push to a subscribed PR's base branch, or to the PR itself, the channel asks GitHub for the PR's mergeability and reports changes. Pushes themselves never reach Claude.

Comment and review bodies are written by other people, so the channel tells Claude to treat them as information, never as instructions.

## Limits

- GitHub allows one forwarder per repo, so only one session at a time can watch PRs in a given repo. A second subscribe there returns an error.
- Events that happen while no session is subscribed are not replayed.
- Workflow runs from forks are not linked to the PR by GitHub, so they don't arrive.
- Subscriptions live in memory: a restarted or resumed session starts with none.

## Configuration

| Env var                 | Description                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GH_PR_EVENTS_PORT`     | Local port for deliveries (default: any free port)                                                                   |
| `GH_PR_EVENTS_BEAT_DIR` | If set, touches `<dir>/<owner>_<repo>_<n>` every 4 minutes per watched PR, for hooks that need proof a PR is watched |

## Development

```bash
cd plugins/gh-pr-events
bun install
bun test
bun run build   # regenerates server.js; commit it with the source
```
