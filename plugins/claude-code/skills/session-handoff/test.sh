#!/bin/sh
# Regression tests for open-tab.sh and close-session.sh. Needs tmux; no iTerm or claude needed.
set -u
dir=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
sock="handoff-test-$$"
fails=0
pids=
trap 'tmux -L "$sock" kill-server 2>/dev/null; [ -n "$pids" ] && kill $pids 2>/dev/null; rm -rf "$tmp"' EXIT

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

# --- close-session.sh: `sh -c` processes carrying --name stand in for child sessions
fake() { sh -c 'sleep 30; :' fake --name "$1" & pids="$pids $!"; }
fake worker-a
a=$!
"$dir/close-session.sh" "$a" worker-a > /dev/null
code=$?
check "close: closes the named session" sh -c "[ $code = 0 ] && ! kill -0 $a 2>/dev/null"
fake worker-ab
ab=$!
"$dir/close-session.sh" "$ab" worker-a 2> /dev/null
code=$?
check "close: refuses a pid whose name only starts with it" sh -c "[ $code = 1 ] && kill -0 $ab"
"$dir/close-session.sh" "$ab" other 2> /dev/null
code=$?
check "close: refuses a pid with another name" sh -c "[ $code = 1 ] && kill -0 $ab"
"$dir/close-session.sh" 999999 worker-a 2> /dev/null
check "close: no such pid exits 1" [ $? = 1 ]
"$dir/close-session.sh" "$ab" 2> /dev/null
check "close: missing name exits 2" [ $? = 2 ]

# codex children carry their name as --add-dir <...>/handoff/<name>
fakecodex() { sh -c 'sleep 30; :' codex -s workspace-write --add-dir "$tmp/handoff/$1" "brief" & pids="$pids $!"; }
fakecodex coder-a
c=$!
"$dir/close-session.sh" "$c" coder-a > /dev/null
code=$?
check "close: closes the named codex session" sh -c "[ $code = 0 ] && ! kill -0 $c 2>/dev/null"
fakecodex coder-ab
cab=$!
"$dir/close-session.sh" "$cab" coder-a 2> /dev/null
code=$?
check "close: refuses a codex pid whose name only starts with it" sh -c "[ $code = 1 ] && kill -0 $cab"

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
