# agentic-utils Skills

Custom Claude Code plugin marketplace.

## Installation

```bash
/plugin marketplace add https://github.com/agentic-utils/skills
```

Then use `/plugin` to browse and install available plugins.

## Plugins

| Plugin / Skill                    | Description                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **claude-code**                   | Skills grounded in Claude Code internals                                                             |
| [`dream`]                         | Consolidate and prune memory files using the 4-phase Orient/Gather/Consolidate/Prune algorithm       |
| [`memory-writer`]                 | Write effective CLAUDE.md entries that get selected — covers the description field, staleness rules, and MEMORY.md index constraints |
| [`compaction-prep`]               | Checkpoint mid-task state before context limits force compaction; identifies the 5 files the restored session needs |
| [`bash-safety`]                   | Exit code semantics table (grep/diff/find exit 1 ≠ error) plus dangerous pattern checklist          |
| [`ant-mode`]                      | Add the Anthropic-employee prompt differences to your CLAUDE.md — communication style, comment rules, faithful reporting, and more |
| **disk-cleanup**                  | Scan for and clean up disk space on macOS                                                            |
| [`disk-cleanup`]                  | Find Docker waste, dev caches, stale worktrees, Python venvs, and orphaned app data; choose what to remove |
| [`ty-lsp`]                        | Python type checking via [ty](https://github.com/astral-sh/ty)                                       |
| [`svelte-lsp`]                    | Svelte language server                                                                               |

[`dream`]: plugins/claude-code/skills/dream.md
[`memory-writer`]: plugins/claude-code/skills/memory-writer.md
[`compaction-prep`]: plugins/claude-code/skills/compaction-prep.md
[`bash-safety`]: plugins/claude-code/skills/bash-safety.md
[`ant-mode`]: plugins/claude-code/skills/ant-mode.md
[`disk-cleanup`]: plugins/disk-cleanup/skills/disk-cleanup.md
[`ty-lsp`]: plugins/ty-lsp/README.md
[`svelte-lsp`]: plugins/svelte-lsp/README.md

## Contributing

1. Create or update a plugin directory under `plugins/`
2. Add skills in `plugins/<plugin-name>/skills/`
3. Update `README.md`
4. Submit a PR
