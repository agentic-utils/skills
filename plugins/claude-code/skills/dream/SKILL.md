---
name: dream
description: Consolidate and prune project auto-memory by mining recent session transcripts and existing memory files. Use when asked to "dream", "consolidate memory", "clean up memory", or after significant project work to capture learnings.
---

# Dream: Memory Consolidation

A reflective pass over project auto-memory. Synthesise recent learnings into durable, well-organised memories so future sessions orient quickly.

- **Memory directory**: `~/.claude/projects/<project>/memory/` — write here directly with the Write tool. Do NOT run `mkdir` or check existence; it already exists.
- **Session transcripts**: `~/.claude/projects/<project>/*.jsonl` — large append-only logs. Grep narrowly with hypothesis-driven terms; never read whole files.
- **Resolve `<project>`** by mapping the current working directory: `/Users/me/Code/foo/bar` → `-Users-me-Code-foo-bar`.

## When to run

- Memory files have grown large with outdated or overlapping entries
- A major project phase just completed and learnings should be captured
- Memory references point to things that no longer exist
- Explicitly asked: "dream", "consolidate memory", "clean up memory"

## Phase 1 — Orient

- `ls` the memory directory to see what already exists
- Read `MEMORY.md` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates
- If `logs/` or `sessions/` subdirectories exist (assistant-mode layout), review recent entries there
- `git log --oneline -20` for recent project activity to anchor what's changed

For each existing memory file, note:

- Last modified time (`stat <file>`)
- Entries older than 7 days with no recent reinforcement
- Duplicate or near-duplicate information across files

Do not make changes yet. Build a picture of what exists.

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Daily logs** (`logs/YYYY/MM/YYYY-MM-DD.md`) if present — the append-only stream from a paired auto-memory writer.
2. **Existing memories that drifted** — facts that contradict something visible in the codebase now. Verify with `ls`/`grep` before correcting.
3. **Transcript search** — narrow, hypothesis-driven greps for things you already suspect matter:

   ```bash
   grep -rn "<narrow term>" ~/.claude/projects/<project>/ --include="*.jsonl" | tail -50
   ```

   Patterns worth grepping for across recent sessions:
   - **User corrections**: `"don't"`, `"stop doing"`, `"never"`, `"why did you"`, `"you should have"` — strong feedback signals
   - **Reinforced patterns**: same command/path/decision appearing across multiple sessions
   - **Surprising failures**: `"argh"`, `"wtf"`, `"still failing"` — gotchas worth capturing
   - **Validated approaches**: `"perfect"`, `"keep doing that"`, `"exactly"` — confirmations of non-obvious choices
   - **Non-obvious gotchas**: things the user explained that aren't documented in the code
4. **This session's learnings** — if invoked mid-conversation, capture decisions, gotchas, or process feedback from the current turn.

Don't exhaustively read transcripts. Only chase specific hypotheses. Prefer `tail -50` over unbounded grep output. Flag anything worth adding that is currently missing.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from the auto-memory section of the system prompt — that's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:

- **Merge** new signal into existing topic files rather than creating near-duplicates. If two entries say the same thing differently, keep the more specific one.
- **Convert relative dates** ("yesterday", "last week", "Thursday") to absolute dates so memories remain interpretable later.
- **Delete contradicted facts at the source** — if today's investigation disproves an old memory, fix the file, don't just add a contradicting note alongside.
- **Score before promoting**: a single one-off observation is rarely worth a memory. Prefer signals reinforced across sessions, or stated explicitly by the user as a standing rule.
- **Counterfactual check**: before writing a feedback memory, ask "would this rule have helped in past sessions where it should have applied?" If no, it's probably too narrow to keep.

## Phase 4 — Prune and index

Update `MEMORY.md` so it stays under 200 lines. It's an **index**, not a dump — link to memory files with one-line descriptions. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: keep the gist in the index, move the detail into the topic file
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one
- For broken pointers: remove them, don't leave them with a "TODO" annotation

Remove entries with low future value:

- Debugging sessions where the fix is now in the code
- Temporary decisions that have since been superseded
- Entries obvious from reading the code
- In-progress work that has since completed
- Exact duplicates of entries in other files

## Verification before deleting

If a memory cites a specific path, function, flag, or command, verify it before pruning:

```bash
ls <path> 2>/dev/null && echo EXISTS || echo MISSING
grep -rn "functionName" --include="*.py" --include="*.ts" -l 2>/dev/null | head -5
```

Memory drift is real, but so is deleting a memory that encodes a constraint not visible in the current diff. When in doubt, leave it.

## Report

Return a brief summary of what was consolidated, updated, or pruned:

- Files reviewed
- Entries added / updated / removed
- Any references that could not be verified
- Whether each memory file still accurately reflects current state

If nothing changed (memories already tight), say so plainly. Don't pad. Do not delete memory files entirely — only prune entries within them.
