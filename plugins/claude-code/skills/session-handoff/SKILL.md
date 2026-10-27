---
name: session-handoff
description: Hand a task to a NEW local Claude Code session in its own tmux window or iTerm tab (detected automatically), with the brief attached as its first turn and the parent's name in it so the child hands its leftovers back via SendMessage and the parent then closes it and cleans up its worktree. Only for a clear tangent; work that feeds the current task goes to a subagent. Use when asked to "hand this off to another session", "launch a new claude session", "spin up a tab for this", "open a tmux window for this", "new session for X", "start a session to do Y", or "handoff".
---

# Session Handoff

Start a new Claude Code session in its own tmux window or iTerm tab with the brief already attached, so the brief is the session's first turn. The brief names the parent session, so the child knows who to report back to. When the child hands back, the parent closes it.

## When to use it

Only for a clear tangent: work that is independent of the current task, would derail this session, and ends in its own result (a separate PR, a fix in another repo) that nobody here waits on. Otherwise use a regular subagent (the Agent tool, or a fork): research, reviews, and anything whose answer this session needs to continue. A subagent reports straight back into this conversation and needs no tab, trust dialog or cleanup.

## Step 1: Find your own name

Run `ListAgents`. Its first line is this session's own name. The child will `SendMessage` that name when it is done.

## Step 2: Write the brief

Write it to a file. Keep it to about a page and self-contained: the child knows only what the brief says. First line:

```markdown
Parent session: `<your-name>`. Report back with SendMessage to `<your-name>` when done, or if blocked.
```

Then:

- **Goal**: one or two sentences
- **Findings to re-verify**: what you already know, labelled as claims to check, not facts
- **Plan**: numbered steps
- **Rules and constraints**: what it must not do, who merges, what needs asking first
- **Handback shape**: exactly what to send back (results, PR URLs, what's left, any follow-up it wants the parent to schedule)
- **Handback and stop**: the closing block below

End every brief with:

````markdown
When done or blocked, hand back and stop:

1. SendMessage the parent: results, PR URLs, the worktree path and branch, and every piece of leftover work (open PRs to watch, review threads, follow-ups to schedule). The parent takes all of it over, so leave nothing only you know about.
2. Also put the handback in your final message, in case the parent has exited.
3. Then stop. Don't start anything new and don't exit: the parent closes this session once it has taken the handback.
````

Never `@`-import files in the brief; point at paths and let the child read them.

## Step 3: Write the launcher script

In zsh `claude` is usually an alias or a shell function, so `command -v claude` returns alias text and a launcher built from it exits at once ("A session ended very soon after starting"). Resolve the real binary with `whence -p`:

```bash
S=~/.claude/handoff            # stable: temp dirs get cleaned, and a missing launcher fails silently
mkdir -p "$S"
C=$(whence -p claude)
cat > "$S/launch.sh" <<EOF
#!/bin/zsh -l
# \$1 = trusted launch dir, \$2 = session (and worktree) name, \$3 = brief file
cd "\$1" || exit 1
source ~/.claude.env      # whatever secrets file your claude() function sources
exec "$C" \${=CCS_CLAUDE_ARGS} --worktree "\$2" --name "\$2" "\$(cat "\$3")"
EOF
chmod +x "$S/launch.sh"
```

- `#!/bin/zsh -l` gives the login `PATH` and profile env vars.
- `whence -p` skips your `claude()` function, so the launcher must do what it does: source the same secrets file and pass the same flags. `${=CCS_CLAUDE_ARGS}` stands for whatever extra flags your wrapper adds (channels, permission mode); `${=...}` makes zsh word-split it.
- `"$(cat brief)"` passes the brief as one argv element without re-expanding it, so quotes, backticks and `$VARS` arrive intact. Trailing newlines are stripped.
- Put flags before the prompt. Variadic flags placed after it swallow the prompt as another value.

## Step 4: Launch

Open it with the bundled `open-tab.sh`, which picks the terminal for you:

```bash
${CLAUDE_SKILL_DIR}/open-tab.sh <name> "$S/launch.sh" <repo-main-checkout> <name> "$S/brief.md"
```

- **Inside tmux** (`$TMUX` set): a new window named `<name>`. The arguments go to tmux as separate words, so nothing needs quoting.
- **In iTerm** (`$TERM_PROGRAM` is `iTerm.app`): a new tab in the current window, or a new window if none is open. Each argument is single-quoted into the AppleScript `command`, so avoid paths containing `'`.
- **Anything else**: it exits 1 and prints the command to start by hand.

Either way the command is attached when the tab or window is created. Never create a tab and then `write text` into `current session` (or `send-keys` to the current pane): if the create silently fails, that is YOUR terminal, and the command gets typed into your own prompt. `test.sh` next to the scripts covers all three paths and `close-session.sh`; run it after changing either script.

- **Never** start a bare session and `SendMessage` the brief afterwards. It queues behind the trust dialog, and cross-session messaging is for sessions that already exist.

### Trust

The "trust this directory" dialog gates the start, prompt attached or not. Trust is per directory and does not cover new subfolders, so a fresh worktree asks every time.

- **Repo already trusted**: launch from its main checkout with `--worktree <name>`. The trust check is on the launch folder, and Claude Code creates (or reopens) `.claude/worktrees/<name>` itself.
- **Repo not trusted**: launch from a trusted directory without `--worktree`, and have the brief tell the child to create its own worktree.

### Several launches in a loop

Run the loop under bash, not zsh. zsh does not word-split unquoted variables, so `set -- $t` puts the whole line in `$1`:

```bash
# jobs.txt: one "<name> <launch-dir> <brief-file>" per line
bash -c 'while read -r t; do
  set -- $t
  "$0" "$1" ~/.claude/handoff/launch.sh "$2" "$1" "$3"
done < ~/.claude/handoff/jobs.txt' ${CLAUDE_SKILL_DIR}/open-tab.sh
```

## Names

Name the session for what it does, in plain words (`cloudrun-deploy-signal`, `fix-flaky-auth-tests`), never a ticket id; the name has to be readable in a tab strip. Put the ticket URL in the brief.

Pick a name none of your own subagents or forks has used. `SendMessage` resolves a name to your own agent (even a stopped one) before a peer session, so a clash resumes the wrong agent.

## Step 5: Check it launched

- `pgrep -f "[n]ame <name>"`: the process is up, within seconds. (The `[n]` stops the pattern matching the shell running the check.)
- `ls -lt /tmp/cc-socks/`: a new socket.
- The brief text appears in the newest `~/.claude/projects/<slug>/*.jsonl`: the prompt landed.

`ListAgents` lags until the socket binds. A session waiting on the trust dialog is invisible to everything except `pgrep`: no transcript, absent from `ListAgents`. If only `pgrep` sees it, go and click the dialog.

## Step 6: Take the handback and clean up

The handback arrives as a `<cross-session-message from-name="<name>">`. Then:

1. **Take over the leftover work**: subscribe to the child's PRs (its subscriptions end when it closes), reply to open threads, schedule the follow-ups it asked for. If anything in the handback is unclear, ask the child now, while it's still open.
2. **Close the child**, with the pid from the message's `from="uds:/tmp/cc-socks/<pid>.sock"` attribute:

   ```bash
   ${CLAUDE_SKILL_DIR}/close-session.sh <pid> <name>
   ```

   It sends SIGTERM only if that process was started with `--name <name>`, so a wrong or reused pid can't close another session, and it waits for the exit. The tab or window closes with it.
3. **Remove its worktree**, from the repo's main checkout:

   ```bash
   git -C <repo-main-checkout> worktree remove .claude/worktrees/<name>   # refuses if dirty: read what's there, never --force blindly
   git -C <repo-main-checkout> branch -d <branch>                         # refuses if unmerged: keep it while its PR is open
   ```

   Do this only after `close-session.sh` reports it closed and the branch is pushed. A dirty worktree means the child left something out of its handback, so ask it (or read the diff) before discarding anything.

## Debugging a launch that exits early

Wrap the launcher so the tab or window stays open and stderr is kept:

```bash
cat > "$S/debug.sh" <<'EOF'
#!/bin/zsh -l
"$HOME/.claude/handoff/launch.sh" "$@" 2> "$HOME/.claude/handoff/launch.err"
echo "exit $?"; sleep 600
EOF
chmod +x "$S/debug.sh"
```

Launch `debug.sh` instead of `launch.sh`, then read `launch.err`.
