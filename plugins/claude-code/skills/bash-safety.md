---
name: bash-safety
description: Review bash commands for dangerous patterns and interpret exit codes correctly. Use when asked to "check this bash", "is this safe to run", "review this script", or when debugging a script that fails unexpectedly.
metadata:
  trigger: When asked to "check this bash", "is this safe to run", "review this script", or when debugging a script that's failing unexpectedly
  author: agentic-utils
---

# Bash Safety

Review bash commands for dangerous patterns and interpret exit codes correctly.

## Exit code semantics

Not every non-zero exit code is an error. The following commands use non-zero exits to convey information:

| Command       | Exit 0         | Exit 1                         | Exit 2+    |
| ------------- | -------------- | ------------------------------ | ---------- |
| `grep` / `rg` | Matches found  | No matches (not an error)      | Real error |
| `find`        | Success        | Some directories inaccessible  | Real error |
| `diff`        | No differences | Files differ (not an error)    | Real error |
| `test` / `[`  | Condition true | Condition false (not an error) | Real error |

**Common mistake**: treating `grep exit 1` as an error in a pipeline, causing the whole script to abort when `set -e` is active. Fix:

```bash
# Wrong — aborts on no matches
grep "pattern" file.txt

# Correct — treats no-match as non-error
grep "pattern" file.txt || true

# Or check explicitly
if grep -q "pattern" file.txt; then
  echo "found"
else
  echo "not found"  # exit 1, not an error
fi
```

## Dangerous patterns to review

### Command substitution injection

These patterns can execute arbitrary code:

- `$()` — command substitution
- `` ` ` `` — backtick substitution
- `<()` / `>()` — process substitution
- `=cmd` at word-start (zsh) — equals expansion, bypasses binary allowlists

### Heredoc injection

```bash
# Dangerous: heredoc inside $()
$(cat <<EOF
  rm -rf /
EOF
)
```

### IFS injection

```bash
# Dangerous: setting IFS changes how word-splitting works
IFS=/ read -r a b <<< "$path"
# Can cause unexpected word splitting in subsequent commands
```

### Dangerous variables

- `$LD_PRELOAD` — injects shared libraries into subsequent processes
- `$DYLD_INSERT_LIBRARIES` — macOS equivalent
- Unquoted `$@` or `$*` — word-splits on spaces in arguments

### Zsh-specific patterns to block

These zsh-specific patterns can bypass command allowlists or execute code through modules:

- `zmodload` — loads zsh modules that enable dangerous operations (file I/O, TCP, pseudo-terminals)
- `emulate -c` — eval-equivalent
- `sysopen`, `sysread`, `syswrite` — low-level file descriptor operations via zsh/system
- `ztcp`, `zsocket` — network operations via zsh/net
- `zf_rm`, `zf_mv`, `zf_chmod` — builtin filesystem operations that bypass binary checks

## Review checklist

Before running an unfamiliar script:

1. **Quoting** — are variables quoted? Unquoted `$var` splits on spaces and globs
2. **set -e behaviour** — if `set -e` is active, will grep/diff/test exits cause unexpected aborts?
3. **Destructive commands** — is `rm` or `rm -rf` present? What path does it target?
4. **Command substitution** — does `$()` or backtick expand user-controlled input?
5. **Redirections** — does `>` or `>>` target a sensitive file?
6. **sudo** — is sudo present? What command does it run?
7. **Network** — does the script make outbound connections (`curl`, `wget`, `nc`)?

## Reviewing a script

When asked to review a script, go through the checklist above and report:

- Any exit code interpretation issues (grep exit 1 treated as error, etc.)
- Any dangerous patterns found, with the specific line
- Whether the script is safe to run as-is, or what needs changing
