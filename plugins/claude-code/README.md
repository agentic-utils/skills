# claude-code

Seven skills grounded in Claude Code's source code. Each one surfaces an internal behaviour or technique that isn't documented anywhere.

## Skills

| Skill               | Trigger phrases                                                    | Description                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`dream`]           | "dream", "consolidate memory", "clean up CLAUDE.md"                | Consolidate and prune memory files using the 4-phase Orient/Gather/Consolidate/Prune algorithm                                                |
| [`memory-writer`]   | "write a memory", "add to CLAUDE.md", "update memory files"        | Write memory entries that get selected. Covers description field scoring, staleness, index limits                                             |
| [`compaction-prep`] | "prep for compaction", "checkpoint", "context is filling up"       | Checkpoint mid-task state so the compacted session resumes exactly where it left off                                                          |
| [`bash-safety`]     | "check this bash", "is this safe to run", "review this script"     | Exit code semantics table plus dangerous pattern checklist                                                                                    |
| [`ant-mode`]        | "enable ant mode", "use the Anthropic prompt"                      | Add the 5 Anthropic-employee prompt differences to your CLAUDE.md                                                                             |
| [`session-handoff`] | "hand this off to another session", "hand this off to codex"       | Hand a tangent nobody here waits on to a new Claude or codex session in its own tab and worktree; the child reports back to its parent        |
| [`codex-delegate`]  | "ask codex", "get codex's take", "have codex review/research this" | Get an answer this conversation needs from `codex exec` (needs the Codex CLI): credit preflight, background-safe run, answer plus token usage |

## Install

```bash
claude plugin install @agentic-utils/agentic-utils-claude-code
```

## Background

These skills are grounded in findings from the Claude Code source leak. Details in [What we can all learn from the Claude Code source](https://brtkwr.com/posts/2026-04-01-what-we-can-all-learn-from-the-claude-code-source/).

[`dream`]: skills/dream/SKILL.md
[`memory-writer`]: skills/memory-writer/SKILL.md
[`compaction-prep`]: skills/compaction-prep/SKILL.md
[`bash-safety`]: skills/bash-safety/SKILL.md
[`ant-mode`]: skills/ant-mode/SKILL.md
[`session-handoff`]: skills/session-handoff/SKILL.md
[`codex-delegate`]: skills/codex-delegate/SKILL.md
