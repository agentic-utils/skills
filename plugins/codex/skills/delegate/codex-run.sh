#!/bin/sh
# Run one `codex exec` task safely, foreground or backgrounded: credit preflight,
# stdin closed, stderr kept, answer and token usage captured.
#
# usage: codex-run.sh [-s SANDBOX] [-e EFFORT] [-C DIR] [-o OUTDIR] (-f PROMPT_FILE | PROMPT...)
#   -s  read-only (default) or workspace-write
#   -e  reasoning effort for this run only, e.g. high (default: codex config)
#   -C  working root for codex (default: current directory)
#   -o  where to write answer.md, events.jsonl, stderr.log (default: a new temp dir)
#
# Exit: 0 answer written; 1 no Codex usage left (nothing ran);
#       2 credit check failed (nothing ran); 3 codex ran but gave no answer; 64 bad usage.
set -u
here=$(cd "$(dirname "$0")" && pwd)

usage() {
  sed -n 5,9p "$0" >&2
  exit 64
}

sandbox=read-only effort= workdir= out= prompt_file=
while getopts s:e:C:o:f: opt; do
  case $opt in
    s) sandbox=$OPTARG ;;
    e) effort=$OPTARG ;;
    C) workdir=$OPTARG ;;
    o) out=$OPTARG ;;
    f) prompt_file=$OPTARG ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))

if [ -n "$prompt_file" ]; then
  prompt=$(cat "$prompt_file") || exit 64
elif [ $# -gt 0 ]; then
  prompt=$*
else
  usage
fi
[ -n "$prompt" ] || usage

[ -n "$out" ] || out=$(mktemp -d "${TMPDIR:-/tmp}/codex-run.XXXXXX")
mkdir -p "$out"
echo "out=$out"

"$here/codex-credit"
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

set -- --skip-git-repo-check -s "$sandbox" --json -o "$out/answer.md"
[ -n "$effort" ] && set -- "$@" -c "model_reasoning_effort=\"$effort\""
[ -n "$workdir" ] && set -- "$@" -C "$workdir"

# </dev/null: a non-tty codex otherwise waits on stdin and never answers.
# stderr to a file: stdin-wait and out-of-credits errors only show up there.
codex exec "$@" "$prompt" </dev/null >"$out/events.jsonl" 2>"$out/stderr.log"
rc=$?

if [ "$rc" -ne 0 ] || [ ! -s "$out/answer.md" ]; then
  echo "codex-run: codex exited $rc with no answer. stderr (MCP auth noise dropped):"
  grep -a -v 'rmcp::' "$out/stderr.log" | tail -20
  exit 3
fi

echo "answer=$out/answer.md"
# The last turn.completed event carries token usage for the whole run.
grep -a '"turn.completed"' "$out/events.jsonl" | tail -1 | sed 's/.*"usage":/usage=/; s/}}$/}/'
