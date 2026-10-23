#!/bin/sh
# Regression tests for open-tab.sh and exit-session.sh. Needs tmux; no iTerm or claude needed.
set -u
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
sock="handoff-test-$$"
fails=0
pid=
trap 'tmux -L "$sock" kill-server 2>/dev/null; [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$tmp"' EXIT

check() { # <description> <command...>
  d=$1
  shift
  if "$@"; then echo "ok   $d"; else echo "FAIL $d"; fails=$((fails + 1)); fi
}

wait_for() { # <seconds> <command...>: true once the command succeeds
  n=$(($1 * 10))
  shift
  while [ "$n" -gt 0 ]; do
    "$@" && return 0
    sleep 0.1
    n=$((n - 1))
  done
  return 1
}

# --- open-tab.sh, tmux: runs inside a private tmux server so $TMUX is set
tmux -L "$sock" new-session -d -s t -n base "sleep 60"
windows() { tmux -L "$sock" list-windows -t t -F '#{window_name}'; }
tmux -L "$sock" new-window -t t -n runner \
  "'$dir/open-tab.sh' child sh -c 'printf \"%s|%s\" \"\$0\" \"\$1\" > \"\$2\"; sleep 1' 'a b' \"it's\" '$tmp/args'; sleep 30"
check "tmux: opens a window with the given name" wait_for 5 sh -c "tmux -L $sock list-windows -t t -F '#{window_name}' | grep -qx child"
check "tmux: passes spaces and quotes through untouched" wait_for 5 sh -c "[ \"\$(cat '$tmp/args' 2>/dev/null)\" = \"a b|it's\" ]"
check "tmux: window closes when its command exits" wait_for 5 sh -c "! tmux -L $sock list-windows -t t -F '#{window_name}' | grep -qx child"

# --- open-tab.sh, iTerm: a fake osascript records what it would run
mkdir "$tmp/bin"
cat > "$tmp/bin/osascript" <<EOF
#!/bin/sh
printf '%s\n' "\$2" > "$tmp/osa-arg"
cat > "$tmp/osa-script"
EOF
chmod +x "$tmp/bin/osascript"
env -u TMUX TERM_PROGRAM=iTerm.app PATH="$tmp/bin:$PATH" "$dir/open-tab.sh" child /path/launch.sh '/a dir' name
check "iTerm: single-quotes each argument" [ "$(cat "$tmp/osa-arg")" = "'/path/launch.sh' '/a dir' 'name' " ]
check "iTerm: opens a window when none is open" grep -q 'create window with default profile command' "$tmp/osa-script"
check "iTerm: never types into a session" sh -c "! grep -q 'write text' '$tmp/osa-script'"

# --- open-tab.sh, neither
env -u TMUX TERM_PROGRAM=other "$dir/open-tab.sh" child true 2> "$tmp/err"
code=$?
check "other terminal: exits 1 with a message" sh -c "[ $code = 1 ] && grep -q 'start it yourself' '$tmp/err'"

# --- exit-session.sh: a symlink to sh named claude stands in for the session process.
# Each case is double-forked so it is reparented to pid 1: a broken walk can't reach
# a real claude running these tests.
ln -s /bin/sh "$tmp/claude" # a copy of a system binary gets killed on macOS
( "$tmp/claude" -c "sleep 0.5; echo \$\$ > '$tmp/pid'; sh -c '\"$dir/exit-session.sh\"'; sleep 10; echo survived" > "$tmp/out" 2>&1 & )
wait_for 5 [ -s "$tmp/pid" ]
pid=$(cat "$tmp/pid" 2>/dev/null)
check "exit: fake claude started" [ -n "$pid" ]
check "exit: kills its nearest claude ancestor" wait_for 3 sh -c "[ -n '$pid' ] && ! kill -0 '$pid' 2>/dev/null"
check "exit: the ancestor dies before running on" sh -c "! grep -q survived '$tmp/out'"
( sh -c "sleep 0.5; '$dir/exit-session.sh' 2> '$tmp/err'; echo \$? > '$tmp/code'" & )
check "exit: no claude ancestor exits 1" wait_for 5 sh -c "[ \"\$(cat '$tmp/code' 2>/dev/null)\" = 1 ] && grep -q 'no claude ancestor' '$tmp/err'"

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
