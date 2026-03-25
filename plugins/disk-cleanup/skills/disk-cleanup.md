---
name: disk-cleanup
description: Scan for and clean up disk space on macOS. Finds Docker waste, dev caches, stale worktrees, Python venvs, orphaned app data, and more — then lets the user choose what to remove.
metadata:
  trigger: When disk is full, low on space, or user wants to free up disk space periodically
  author: agentic-utils
---

# Disk Cleanup

Free disk space by finding and removing recreatable or stale data on macOS.

## Process

### Phase 1: Scan

Run all scans in parallel and present a summary table sorted by size descending.

```bash
# Overall disk usage
df -h /

# Docker (if running)
docker system df 2>/dev/null

# Dev caches
du -sh ~/Library/Caches/Yarn/ ~/Library/Caches/pypoetry/ ~/Library/Caches/pip/ ~/Library/Caches/go-build/ ~/Library/Caches/Homebrew/ ~/Library/Caches/node-gyp/ ~/.npm 2>/dev/null

# Docker data
du -sh ~/Library/Containers/com.docker.docker/ ~/.docker 2>/dev/null

# Python venvs
find ~ -name ".venv" -type d -maxdepth 5 2>/dev/null | while read d; do du -sh "$d"; done | sort -hr

# Git worktrees
find ~ -name ".worktrees" -type d -maxdepth 4 2>/dev/null | while read d; do du -sh "$d"; done | sort -hr

# App caches (>100MB)
for d in ~/Library/Caches/*/; do du -sh "$d" 2>/dev/null; done | sort -hr | awk -F'\t' '{size=$1; if (size ~ /[0-9.]+G/ || (size ~ /[0-9.]+M/ && size+0 > 100)) print}' | head -15

# iOS/Xcode simulators
du -sh ~/Library/Developer/CoreSimulator ~/Library/Developer/XCPGDevices 2>/dev/null

# Homebrew stale packages
brew cleanup --dry-run 2>/dev/null | tail -5

# Large Application Support dirs (>500MB)
for d in ~/Library/Application\ Support/*/; do du -sh "$d" 2>/dev/null; done | sort -hr | head -10

# Orphaned app data — leftover data from uninstalled applications
# Check common dotdirs and Application Support for apps not in /Applications
# Dotdirs: map name to expected app
for app_dir in ~/.lmstudio ~/.ollama ~/.cursor ~/.windsurf ~/.vscode ~/.vscode-insiders; do
  [ -d "$app_dir" ] || continue
  du -sh "$app_dir" 2>/dev/null
done
# Application Support: flag large dirs (>500MB) for review
for d in ~/Library/Application\ Support/*/; do
  du -sh "$d" 2>/dev/null
done | sort -hr | awk -F'\t' '{size=$1; if (size ~ /[0-9.]+G/ || (size ~ /[0-9.]+M/ && size+0 > 500)) print}' | head -10
```

Present results as a numbered table:

```
| # | Category | Size | Risk | Command |
|---|----------|------|------|---------|
```

Risk levels:
- **Safe** — caches that are automatically rebuilt (npm, pip, poetry, go, brew, yarn)
- **Safe** — Docker build cache, dangling images, unused volumes
- **Safe** — Python .venvs (recreatable with `uv sync`, `poetry install`, or `pip install`)
- **Safe** — orphaned app data (only if the application is no longer installed)
- **Check** — git worktrees (may have uncommitted changes)
- **Check** — Application Support dirs (may contain user data)
- **Manual** — requires user to decide (e.g. Docker volumes with data)

### Phase 2: Choose

Use AskUserQuestion to ask the user which categories to clean. Offer options like:
1. Clean all safe items
2. Clean specific categories (let me pick)
3. Just show me the commands

### Phase 3: Clean

For each selected category, run the appropriate cleanup commands.

#### Docker
```bash
docker system prune -af --volumes
docker builder prune -af
```

#### Dev caches
```bash
npm cache clean --force
yarn cache clean
poetry cache clear --all pypi -n 2>/dev/null
pip cache purge 2>/dev/null || python3 -m pip cache purge 2>/dev/null
go clean -cache -modcache
brew cleanup --prune=all
rm -rf ~/Library/Caches/node-gyp
```

#### Python venvs
```bash
# List and confirm before removing
find ~ -name ".venv" -type d -maxdepth 5 -exec rm -rf {} +
```

#### Git worktrees
Before removing, check each worktree for uncommitted changes:
```bash
# For each .worktrees directory, check git status
cd <worktree> && git status --porcelain
```
Only remove worktrees with clean working trees. Warn about dirty ones.

#### App caches
Remove the large app cache directories identified in the scan.
- Browser caches require the browser to be closed first
- Skip any caches the user wants to keep
- Use `rm -rf ~/Library/Caches/<dirname>` for each selected cache

#### iOS/Xcode simulators
```bash
rm -rf ~/Library/Developer/CoreSimulator
rm -rf ~/Library/Developer/XCPGDevices
```

#### Orphaned app data
Only remove directories for applications that are confirmed NOT installed:
- Check `/Applications` for the corresponding `.app` bundle before removing
- Remove both the dotdir (`~/.appname`) and `~/Library/Application Support/AppName` if the app is absent
- Ask the user to confirm before removing any Application Support directories

### Phase 4: Report

Show before/after disk usage with `df -h /` and a summary of space freed per category.

## Safety rules

- **NEVER delete** `~/Library/Application Support/Claude/` — contains conversation history
- **NEVER delete** `~/Library/Application Support/Codex/` or OpenAI data — contains conversation history
- **Never delete** `~/Library/Application Support/` dirs without explicit user confirmation
- **Never delete** Docker volumes without confirming they're not in use
- **Always check** worktrees for uncommitted changes before removing
- **Always show** what will be deleted and the size before running destructive commands
- All deleted items should be recreatable (caches, build artifacts, venvs)
- Only remove orphaned app data when the application is confirmed to be uninstalled
