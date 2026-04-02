---
name: compaction-prep
description: Checkpoint mid-task state before context limits hit. Use when asked to "prep for compaction", "checkpoint", "save state", or when context is getting long.
metadata:
  trigger: When context is getting long, before a complex multi-step task, or when asked to "prep for compaction", "save state", "checkpoint", "context is filling up"
  author: agentic-utils
---

# Compaction Prep

When context gets long enough, AI assistants summarise the conversation and start fresh. State held only in the conversation — intermediate reasoning, file edit history, decisions made — may not survive. If you are mid-task when this happens, the resumed session may not have enough context to continue cleanly.

This skill creates an explicit checkpoint so the session resumes exactly where it left off.

## What survives a context reset

Typically survives:

- A summarised version of the conversation
- Memory and config files loaded at session start
- Files explicitly referenced or recently edited

Typically does not survive:

- Full tool call results
- Intermediate reasoning steps
- The list of files being actively edited
- Anything held only in conversation

## Process

### Step 1: Write a checkpoint

Create a checkpoint file (e.g. `.ai/checkpoint.md` or `checkpoint.md`):

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

## Key files

- `path/to/most-important.ts`
- `path/to/second.ts`
- `path/to/third.ts`
```

### Step 2: Identify key files

Which files, if loaded at the start of the next session, would give enough context to continue? Prioritise:

1. Files with uncommitted changes
2. The file that is the focus of the current task
3. Files with decisions or patterns the task depends on
4. Test files if the task involves making tests pass
5. Config files if the task involves configuration

### Step 3: Reference the checkpoint from your memory config

Add a pointer to the checkpoint in whatever config or memory file the AI loads at session start (e.g. `CLAUDE.md`, `AGENTS.md`):

```markdown
## In-progress work

See `checkpoint.md` for current task state.
```

Remove this line once the task completes.

### Step 4: Commit (optional)

For long-running tasks that should survive beyond this session:

```bash
git add checkpoint.md && git commit -m "chore: checkpoint mid-task state"
```

## After resuming

Read the checkpoint file and continue from **Next step**. Once the task is complete, delete the checkpoint and remove the reference from the memory config.
