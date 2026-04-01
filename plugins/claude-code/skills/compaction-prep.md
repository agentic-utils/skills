---
name: compaction-prep
description: Checkpoint mid-task state before context limits force compaction. Writes a handoff note so the compacted session picks up exactly where it left off.
metadata:
  trigger: When context is getting long, before a complex multi-step task, or when asked to "prep for compaction", "save state", "checkpoint", "context is filling up"
  author: agentic-utils
---

# Compaction Prep

When Claude Code hits ~95% context, it compacts: a forked agent summarises the conversation, the original session restores from that summary plus up to 5 files. If you are mid-task and compaction hits without preparation, the restored session may not have enough context to continue cleanly.

This skill creates an explicit checkpoint so the post-compaction session picks up exactly where it left off.

## What compaction restores

The compacted session gets:

- A summarised conversation (tool calls become counts, not full content)
- Up to 5 explicitly named files (restored verbatim)
- CLAUDE.md and active memory files (always loaded fresh)

It does NOT get: full tool call results, intermediate reasoning, the list of files being edited, anything held only in conversation.

## Process

### Step 1: Write a checkpoint

Create `.claude/checkpoint.md`:

```markdown
# Checkpoint

**Task**: [one sentence: what are we trying to accomplish?]
**Status**: [what has been done, what is left]
**Next step**: [exactly what to do next — specific enough to resume without re-reading context]

## Files in progress

- `path/to/file1.ts` — [what change is needed / what was just changed]
- `path/to/file2.py` — [same]

## Decisions made

- [Non-obvious decisions taken during this session that the next instance needs]

## Do not repeat

- [Anything already tried and failed, to avoid redoing it]

## Restore these files

1. `path/to/most-important.ts`
2. `path/to/second.ts`
3. `path/to/third.ts`
4. `path/to/fourth.ts`
5. `path/to/fifth.ts`
```

### Step 2: Choose the 5 restoration files

Priority order:

1. Files with uncommitted changes
2. The file that is the focus of the current task
3. Files with decisions or patterns the task depends on
4. Test files if the task involves making tests pass
5. Config files if the task involves configuration

### Step 3: Reference the checkpoint from CLAUDE.md

Add to the project's CLAUDE.md so it loads after compaction:

```markdown
## In-progress work

See `.claude/checkpoint.md` for current task state.
```

Remove this line once the task completes.

### Step 4: Commit (optional)

For long-running tasks that should survive beyond this session:

```bash
git add .claude/checkpoint.md && git commit -m "chore: checkpoint mid-task state"
```

## After compaction

The restored session loads CLAUDE.md (which references the checkpoint) and the 5 listed files. Read `.claude/checkpoint.md` and continue from **Next step**.

Once the task is complete, delete `.claude/checkpoint.md` and remove the CLAUDE.md reference.
