#!/bin/sh
# Usage: close-session.sh <pid> <name>
# Closes a child session after its handback: SIGTERM to <pid>, but only if that process
# was started with --name <name>, so a wrong or reused pid can't hit another session.
pid=$1
name=$2
if [ -z "$pid" ] || [ -z "$name" ]; then
  echo "usage: close-session.sh <pid> <name>" >&2
  exit 2
fi
cmd=$(ps -o command= -p "$pid") || { echo "close-session.sh: no process $pid" >&2; exit 1; }
case "$cmd " in
  *"--name $name "*) ;;
  *)
    echo "close-session.sh: $pid is not session $name, leaving it alone" >&2
    exit 1
    ;;
esac
kill -TERM "$pid"
n=50
while kill -0 "$pid" 2>/dev/null; do
  n=$((n - 1))
  if [ "$n" = 0 ]; then echo "close-session.sh: $pid still running after 5s" >&2; exit 1; fi
  sleep 0.1
done
echo "closed $name ($pid)"
