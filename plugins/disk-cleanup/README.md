# disk-cleanup

Scan for and clean up disk space on macOS. Finds Docker waste, dev caches, stale git worktrees, Python venvs, orphaned app data, and more.

## What it cleans

| Category          | Examples                                                              |
| ----------------- | --------------------------------------------------------------------- |
| Docker            | Images, volumes, build cache                                          |
| Dev caches        | npm, yarn, pip, poetry, go, homebrew, node-gyp                        |
| Python venvs      | `.venv` directories (recreatable)                                     |
| Git worktrees     | `.worktrees/` directories (checks for uncommitted changes first)      |
| App caches        | Spotify, Brave, Playwright, etc.                                      |
| iOS simulators    | CoreSimulator, XCPGDevices                                            |
| Orphaned app data | Leftover data from uninstalled apps (LM Studio, Ollama, Cursor, etc.) |

## Usage

```text
/disk-cleanup
```

The skill runs in 4 phases:

1. **Scan** — finds all reclaimable space and presents a summary table
2. **Choose** — lets you pick what to clean (all safe items, specific categories, or just show commands)
3. **Clean** — runs the cleanup commands
4. **Report** — shows before/after disk usage

## Install

```bash
claude plugin install @agentic-utils/disk-cleanup
```
