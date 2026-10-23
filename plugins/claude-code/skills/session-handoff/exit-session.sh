#!/bin/sh
# Ends the Claude Code session that runs this: SIGTERM to its nearest claude ancestor.
p=$$
while [ "$p" -gt 1 ]; do
  case "$(ps -o comm= -p "$p")" in *claude) exec kill -TERM "$p" ;; esac
  p=$(ps -o ppid= -p "$p" | tr -d ' ')
done
echo "no claude ancestor found" >&2
exit 1
