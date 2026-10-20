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
Run them under `bash`: zsh aborts a loop on the first unmatched glob.

```bash
# Overall disk usage. `/` is the read-only system volume on modern macOS;
# user data lives on the Data volume
df -h /System/Volumes/Data

# Docker (if running)
docker system df 2>/dev/null

# Dev caches
du -sh ~/Library/Caches/Yarn/ ~/Library/Caches/pypoetry/ ~/Library/Caches/pip/ ~/Library/Caches/go-build/ ~/Library/Caches/Homebrew/ ~/Library/Caches/node-gyp/ ~/.npm ~/.cache/uv ~/.cache/pre-commit ~/go/pkg/mod 2>/dev/null

# Docker data, plus a stalled Docker Desktop update download
du -sh ~/Library/Containers/com.docker.docker/ ~/.docker ~/Library/Application\ Support/com.docker.install/in_progress 2>/dev/null

# Biggest dirs in the usual hiding places. This catches runaway logs the fixed
# lists miss (e.g. ~/.config/gcloud/logs mirrors every command's stdout, so one
# unbounded `gcloud logging read` can write a 20GB+ file) and media downloads
# (Podcasts episodes live in a Group Container)
du -sh ~/* ~/.[!.]* ~/.config/* ~/.cache/* ~/Library/Containers/* ~/Library/Group\ Containers/* 2>/dev/null \
  | grep -viE 'claude|codex|openai|anthropic' | sort -hr | head -25

# Full macOS installers (~15-20GB each), left behind after an update was staged
du -sh /Applications/Install\ macOS*.app 2>/dev/null

# Python venvs
find ~ -name ".venv" -type d -maxdepth 6 -not -path "*/Library/*" 2>/dev/null | while read d; do du -sh "$d"; done | sort -hr

# Git worktrees: both the .worktrees and .claude/worktrees conventions
find ~ -maxdepth 5 -type d \( -name ".worktrees" -o -path "*/.claude/worktrees" \) 2>/dev/null | while read d; do du -sh "$d"; done | sort -hr

# App caches (>100MB), agent data filtered out
for d in ~/Library/Caches/*/; do
  case "$(basename "$d")" in *[Cc]laude*|*[Cc]odex*|*openai*|*anthropic*) continue ;; esac
  du -sh "$d" 2>/dev/null
done | sort -hr | awk -F'\t' '{size=$1; if (size ~ /[0-9.]+G/ || (size ~ /[0-9.]+M/ && size+0 > 100)) print}' | head -15

# iOS/Xcode simulators
du -sh ~/Library/Developer/CoreSimulator ~/Library/Developer/XCPGDevices 2>/dev/null

# fnm shims — one dir per shell ever opened, never pruned (count clutter, ~0 bytes)
ls -1 ~/.local/state/fnm_multishells 2>/dev/null | wc -l

# Homebrew stale packages
brew cleanup --dry-run 2>/dev/null | tail -5

# Orphaned app data — leftover data from uninstalled applications
# Check common dotdirs and Application Support for apps not in /Applications
# Dotdirs: map name to expected app
for app_dir in ~/.lmstudio ~/.ollama ~/.cursor ~/.windsurf ~/.vscode ~/.vscode-insiders; do
  [ -d "$app_dir" ] || continue
  du -sh "$app_dir" 2>/dev/null
done
# Application Support: flag large dirs (>500MB) for review.
# Agent data (Claude, Codex, OpenAI) is never a cleanup candidate — it holds
# conversation history, so filter it out here rather than relying on the
# deletion-step rule to catch it.
for d in ~/Library/Application\ Support/*/; do
  case "$(basename "$d")" in Claude|Codex|OpenAI|*.anthropic.*|*openai*) continue ;; esac
  du -sh "$d" 2>/dev/null
done | sort -hr | awk -F'\t' '{size=$1; if (size ~ /[0-9.]+G/ || (size ~ /[0-9.]+M/ && size+0 > 500)) print}' | head -10
```

Present results as a numbered table:

```text
| # | Category | Size | Risk | Command |
|---|----------|------|------|---------|
```

Risk levels:

- **Safe** — caches that are automatically rebuilt (npm, pip, poetry, go, brew, yarn)
- **Safe** — Docker build cache, dangling images, unused volumes
- **Safe** — Python .venvs (recreatable with `uv sync`, `poetry install`, or `pip install`)
- **Safe** — fnm shims for dead PIDs (frees no disk; flag it when the count exceeds ~1000)
- **Safe** — orphaned app data (only if the application is no longer installed)
- **Safe** — CLI debug logs (e.g. `~/.config/gcloud/logs`, which gcloud ages out after 30 days anyway)
- **Check** — git worktrees (may have uncommitted or unpushed commits)
- **Check** — downloaded media (Podcasts episodes, a staged `Install macOS*.app`)
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
UV_LOCK_TIMEOUT=20 uv cache prune
```

Long-running `uvx` processes (MCP servers started by every agent session) hold the uv cache
lock, so `uv cache prune` waits 5 minutes and fails. If it times out, ask before
`uv cache clean --force`: it frees the most but can break those running processes until they
restart.

#### Python venvs

```bash
# List and confirm before removing
find ~ -name ".venv" -type d -maxdepth 6 -not -path "*/Library/*" -exec rm -rf {} +
```

#### Git worktrees

Clean is not enough: a clean worktree can hold commits that exist nowhere else. Remove a
worktree only when its status is clean **and** one of these holds (fetch first):

- HEAD equals or is behind its upstream (`git rev-list --count @{u}..HEAD` is `0`)
- HEAD is an ancestor of `origin/<default>` (`git merge-base --is-ancestor HEAD origin/main`)
- its PR is merged and HEAD equals the PR head (`gh pr list --head <branch> --state merged --json headRefOid`),
  which covers squash merges and deleted remote branches

Then `git worktree remove <path>` (never `-f`: it refuses locked and dirty trees, which is
the point) and `git branch -D <branch>`. Skip any worktree modified in the last 3 days, since
a live session may own it. List what was kept, and why, for the user.

#### App caches

Remove the large app cache directories identified in the scan.

- Browser caches require the browser to be closed first
- Skip any caches the user wants to keep
- Use `rm -rf ~/Library/Caches/<dirname>` for each selected cache

#### fnm shims

fnm creates `~/.local/state/fnm_multishells/<pid>_<timestamp>` per shell and never prunes it.
Removing them frees no disk, since they are symlinks, but the count grows without bound. Keep
any shim whose PID is still running, or that shell loses `node`:

```bash
cd ~/.local/state/fnm_multishells || exit 1
ps -A -o pid= | tr -d ' ' | sort -u > /tmp/live_pids.txt
ls -1 > /tmp/all_shims.txt
awk -F_ 'NR==FNR{live[$0];next} !($1 in live){print}' /tmp/live_pids.txt /tmp/all_shims.txt \
  | tr '\n' '\0' | xargs -0 -n 200 rm -rf
```

Run the `ps` and the `rm` in the same invocation — a shell that exits between them shifts the
live set. Use shell `rm -rf` rather than Python's `shutil.rmtree`, which fails on every entry
here with a null errno. Verify afterwards with `fnm current` and `node -v`.

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

#### Space `du` cannot see

If `df` used is well above what the home and `/Applications` scans add up to, the rest is in
root-only dirs. Ask the user to run this (it takes minutes, so run it in the background):

```bash
sudo du -xh -d 3 /System/Volumes/Data 2>/dev/null | sort -hr | head -30
```

Expect the Spotlight index, system databases and endpoint-security agent data. Flag anything
outsized, but leave managed security tooling to whoever owns it.

### Phase 4: Report

Show before/after disk usage with `df -h /System/Volumes/Data` and the space freed per
category. Take a `df` reading around each step rather than adding up `du` sizes: venvs and
the uv cache share blocks through APFS clones, so their `du` sizes overstate what deleting
them frees.

## Safety rules

- **NEVER delete** `~/Library/Application Support/Claude/` — contains conversation history
- **NEVER delete** `~/Library/Application Support/Codex/` or OpenAI data — contains conversation history
- **Never delete** `~/Library/Application Support/` dirs without explicit user confirmation
- **Never delete** Docker volumes without confirming they're not in use
- **Always check** worktrees for uncommitted changes before removing
- **Always show** what will be deleted and the size before running destructive commands
- All deleted items should be recreatable (caches, build artifacts, venvs)
- Only remove orphaned app data when the application is confirmed to be uninstalled
- **Never surface** Claude, Codex or OpenAI data in scan output — filter it out so it is never offered as a candidate, rather than relying on the user to decline it
