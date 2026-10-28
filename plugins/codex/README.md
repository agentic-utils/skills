# codex

Delegate self-contained tasks from Claude Code to the [Codex CLI](https://github.com/openai/codex) (`codex exec`) and get back one answer plus its token usage.

## Skills

| Skill        | Trigger phrases                                                     | Description                                                                                                 |
| ------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`delegate`] | "ask codex", "delegate to codex", "have codex review/research this" | Credit preflight, a background-safe `codex exec` run, sandbox and effort choices, and a relay-only subagent |

## Bundled scripts

| Script         | What it does                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `codex-credit` | Reads Codex's remaining usage from `codex app-server` without starting a task. Exit 0 go, 1 no usage left, 2 check failed   |
| `codex-run.sh` | Preflight, then `codex exec` with stdin closed and stderr kept; prints the answer path and the `turn.completed` token usage |

## Requirements

- `codex` on `PATH`, logged in
- `python3` (for `codex-credit`)

## Install

```bash
claude plugin install @agentic-utils/agentic-utils-codex
```

[`delegate`]: skills/delegate/SKILL.md
