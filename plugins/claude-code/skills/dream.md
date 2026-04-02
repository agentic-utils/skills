---
name: dream
description: Consolidate and prune memory files using the 4-phase Orient/Gather/Consolidate/Prune algorithm. Removes stale entries, merges duplicates, and surfaces missing learnings from recent work.
metadata:
  trigger: When asked to "dream", "consolidate memory", "clean up memory", "tidy up memory", or when memory files have grown stale or bloated
  author: agentic-utils
---

# Dream

Consolidate and prune memory files on demand using a 4-phase process.

## When to run

- Memory files have grown large with outdated or overlapping entries
- A major project phase just completed and learnings should be captured
- Memory references are pointing to things that no longer exist
- Explicitly asked: "dream", "consolidate memory", "clean up memory"

## Phase 1: Orient

Read every memory file relevant to this project. Look for:

- Configuration files (`CLAUDE.md`, `.cursor/rules`, `AGENTS.md`, or equivalent)
- Any memory index files and the files they reference
- Any per-session or per-project memory files

For each file, note:

- When it was last modified (`stat <file>`)
- How many entries it has
- Entries older than 7 days with no recent reinforcement
- Duplicate or near-duplicate information across files

Do not make changes yet. Build a picture of what exists.

## Phase 2: Gather

Identify concrete learnings from recent work not yet captured in memory:

- Commands or patterns discovered this session
- Decisions made and the reasoning behind them
- Gotchas encountered (surprising failures, non-obvious behaviours)
- File paths, function names, or configurations that came up repeatedly

Check git log for recent commits:

```bash
git log --oneline -20 2>/dev/null
```

Flag anything worth adding that is currently missing.

## Phase 3: Consolidate

For each memory file:

1. **Merge overlapping entries** — if two entries say the same thing differently, keep the more specific one
2. **Update stale entries** — if an entry refers to a file, function, or config that no longer exists, verify it:

   ```bash
   ls <path> 2>/dev/null && echo EXISTS || echo MISSING
   grep -r "functionName" --include="*.ts" --include="*.py" -l 2>/dev/null | head -5
   ```

   Remove or correct entries that no longer reflect reality
3. **Add missing learnings** — write new entries for anything found in Phase 2

## Phase 4: Prune

Remove entries with low future value:

- Debugging sessions where the fix is now in the code
- Temporary decisions that have since been superseded
- Entries obvious from reading the code
- In-progress work that has since completed
- Exact duplicates of entries in other files

For index files: remove pointers to files that no longer exist.

## After completing all phases

Report:

- Files reviewed
- Entries added / updated / removed
- Any references that could not be verified
- Whether each memory file still accurately reflects current state

Do not delete memory files entirely — only prune entries within them.
