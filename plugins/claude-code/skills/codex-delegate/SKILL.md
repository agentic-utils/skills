---
name: codex-delegate
description: Get an answer from the Codex CLI (`codex exec`) that THIS conversation needs, such as a second opinion, a review of a diff or design, web research or a non-interactive edit. One headless run; the answer and token usage come back here. Covers the credit preflight, a background-safe invocation, sandbox and reasoning-effort choices, and relaying through a cheap subagent. Use when asked to "ask codex", "get codex's take", "get a second opinion from codex", "have codex review this", "have codex research this", "run codex exec", or, when codex is installed, before spawning a Claude subagent for self-contained work codex could do. For separate work codex should carry on in its own tab, use session-handoff instead.
---

# Delegate to Codex

Hand one self-contained task to `codex exec` and get back a single answer plus its token usage. Good fits: a second model's view on a design or diff, an adversarial review, web research, and non-interactive edits you want off your own quota.

**Which skill.** Use this one when this conversation waits for the answer. Separate work that ends in its own result (a branch, a PR, a fix in another repo), which codex should carry on in its own tab, goes to `session-handoff` instead. "Have codex do X" means this skill for a question, review or research, and `session-handoff` for implementation that ends in its own PR.

**When not to.** If the task needs this conversation's context, use a fork. If it needs a Claude-only tool or MCP server, use a Claude subagent.

Needs the [Codex CLI](https://github.com/openai/codex) installed and logged in. If `codex` isn't on `PATH`, this skill doesn't apply: do the work in-session and don't install codex unasked. The preflight below checks for it.

## Step 1: Preflight

Run the bundled credit check before every codex run, including `codex review` and runs made from a subagent:

```bash
${CLAUDE_SKILL_DIR}/codex-credit
# allowed=true used=10% resets=2026-11-04 07:08 UTC credits=false reason=none free_resets=2
```

It asks the local `codex app-server` for the same limits `/status` shows, without starting a task.

| Exit | Meaning                                               | Do                                                        |
| ---- | ----------------------------------------------------- | --------------------------------------------------------- |
| 0    | Codex can take work                                   | Go to step 2                                              |
| 1    | Usage limit reached or credits used up                | Don't launch codex; do the work yourself                  |
| 2    | Check failed (codex not installed, logged out, crash) | Report it; don't launch codex blind; do the work yourself |

**Never spend a free rate-limit reset** (`free_resets` above, the app-server's `account/rateLimitResetCredit/consume`) without asking the user first. They are scarce and the user decides when one is worth it.

## Step 2: Run it

Use the bundled wrapper. It runs the preflight, closes stdin, keeps stderr, and prints where the answer is plus the usage line:

```bash
${CLAUDE_SKILL_DIR}/codex-run.sh -o "$OUT" -f prompt.md            # read-only, config effort
${CLAUDE_SKILL_DIR}/codex-run.sh -o "$OUT" -e high -f prompt.md    # adversarial review
${CLAUDE_SKILL_DIR}/codex-run.sh -o "$OUT" -s workspace-write -C "$REPO" -f prompt.md
```

```text
out=/path/to/out
allowed=true used=10% resets=... free_resets=2
answer=/path/to/out/answer.md
usage={"input_tokens":28134,"cached_input_tokens":13184,"output_tokens":6,"reasoning_output_tokens":0}
```

Exit codes: 0 answer written, 1 and 2 as in the preflight (nothing ran), 3 codex ran but produced no answer (the stderr tail is printed). It is safe to background with `run_in_background`.

Write the prompt to a file and pass `-f`: it avoids quoting trouble and keeps the prompt reviewable. A positional prompt works too. Codex knows nothing of this conversation, so the prompt must be self-contained: goal, file paths, constraints and the shape of answer you want back.

### The raw command

If you can't use the wrapper, this is what it runs. Keep every part:

```bash
codex exec --skip-git-repo-check -s read-only --json -o "$OUT/answer.md" "$PROMPT" \
  < /dev/null > "$OUT/events.jsonl" 2> "$OUT/stderr.log"
grep -a '"turn.completed"' "$OUT/events.jsonl" | tail -1   # token usage
```

- `-o FILE` captures only the final message. `--json` streams JSONL events to stdout, and the last `turn.completed` event carries `usage` for the run. Always report it back.
- `< /dev/null` is required whenever codex has no tty (backgrounded, `&`, cron, a subagent's shell). Without it codex can sit on `Reading additional input from stdin...` forever, even with the prompt passed as an argument. A foreground test in a terminal succeeds because it has a tty, so it proves nothing about the backgrounded call.
- **Never `2>/dev/null`.** Stdin-wait and `ERROR: Your workspace is out of credits` both go only to stderr. With stderr discarded, both look like an empty answer file, which also looks like "still running". Check `pgrep -f "codex exec"` before reporting a run as in progress.
- Headless MCP OAuth errors (`rmcp::transport::worker ... AuthRequired`) on stderr are harmless noise. Don't silence them with `-c mcp_servers={}`, which can stall the run.
- `--skip-git-repo-check` lets it run outside a git repo; `-C DIR` sets its working root.

## Options

**Model.** Always the default from `~/.codex/config.toml`. Pass `-m` only when the user names a model. The `--json` events don't name the model that ran, so read the config if you need to say which one it was.

**Sandbox.**

| `-s`              | Use for                                           |
| ----------------- | ------------------------------------------------- |
| `read-only`       | Research, review, questions (default)             |
| `workspace-write` | Letting codex edit files under the `-C` directory |

`--dangerously-bypass-approvals-and-sandbox` exists, but only for an environment that is already sandboxed externally.

**Reasoning effort.** The config default suits everyday work. For an adversarial review (a cross-repo change, a sequencing or migration plan, a seam between systems) raise it for that run only: `-e high` on the wrapper, or `-c model_reasoning_effort="high"` on the raw command. Don't edit the config to do it.

**Web research.** `codex exec` can search the web and read pages with no extra flag or config, including under `-s read-only`. Its `--json` stream shows `web_search` items. Send research there instead of spawning an in-session agent to do it. The interactive `codex --search` flag is not needed and `codex exec` doesn't accept it.

## Relay through a cheap subagent

For anything beyond a short answer, don't call codex from the main session. Spawn a background subagent on the cheapest model tier (name it `haiku-codex-<task>`) whose only job is:

1. Run `codex-run.sh` with the prompt it was handed.
2. Read `answer.md`.
3. Return the answer (or a faithful summary if it's long) plus the `usage=` line.

That keeps codex's output out of the main context, and the delegation shows up as a named agent instead of an opaque shell command. The runner **relays only**: codex did the thinking, and a cheap tier re-analysing it adds errors, not value. Skip the runner only when you asked codex for an answer small enough to read directly.

### Failure goes back to the parent

Each runner wraps exactly one codex run and is single-shot. On any failure (exit 1, 2 or 3, rate limit, empty answer) it reports the failure, with the printed stderr tail, and stops. It never retries, never switches to another delegation tool, and never attempts the task itself (it is the wrong tier for that). The parent decides what happens next: do the work in-session, or dispatch elsewhere as a fresh, explicit choice.
