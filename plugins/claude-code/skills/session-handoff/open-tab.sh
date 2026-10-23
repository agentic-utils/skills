#!/bin/sh
# Usage: open-tab.sh <name> <command> [args...]
# Runs the command in a new tmux window when inside tmux, else in a new iTerm tab.
name=$1
shift
if [ -n "$TMUX" ]; then
  # several arguments: tmux execs them directly, no shell quoting involved
  exec tmux new-window -n "$name" -- "$@"
elif [ "$TERM_PROGRAM" = iTerm.app ]; then
  # ponytail: an argument containing a single quote breaks this; keep paths plain
  cmd=$(printf "'%s' " "$@")
  exec osascript - "$cmd" <<'AS'
on run argv
  tell application "iTerm2"
    if (count of windows) = 0 then
      create window with default profile command (item 1 of argv)
    else
      tell current window to create tab with default profile command (item 1 of argv)
    end if
  end tell
end run
AS
else
  echo "open-tab.sh: not inside tmux or iTerm, start it yourself: $*" >&2
  exit 1
fi
