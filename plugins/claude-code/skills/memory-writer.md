---
name: memory-writer
description: Write effective CLAUDE.md and memory file entries. Covers what gets selected, why staleness matters, how the description field drives relevance scoring, and what format makes entries actionable.
metadata:
  trigger: When asked to "write a memory", "add to CLAUDE.md", "update my memory files", "how should I write this memory", or when creating new CLAUDE.md entries for a project
  author: agentic-utils
---

# Memory Writer

How to write memory entries that get selected, stay fresh, and give Claude enough context to act.

## How memory selection works

At the start of each session, Claude Code runs a selection pass over your memory files. Up to 5 files are loaded. The selection uses the `description` field in each file's frontmatter to score relevance against the current task.

This means:

- The `description` field is the most important thing you write — it determines whether the file loads at all
- Files with vague descriptions ("general notes") lose to files with specific ones ("how to run migrations in this repo")
- Files older than 1 day get a staleness warning injected into the session — stale files still load but are flagged
- API documentation for tools currently in use is excluded automatically — don't store tool docs in memory files

## The MEMORY.md index

`MEMORY.md` is always loaded regardless of the 5-file limit. It's an index, not a place for memory content. Keep it short: the first 200 lines are loaded, the rest are truncated.

Each entry is one line, under ~150 characters:

```markdown
- [Short Title](file.md) — specific hook: what this memory is about and when it matters
```

Good:

```markdown
- [DB Migration Pattern](db-migrations.md) — always run `two db reset --upgrade` after switching worktrees
```

Bad:

```markdown
- [Notes](notes.md) — various notes about the project
```

## File frontmatter

Every memory file needs:

```markdown
---
name: short-kebab-name
description: one-line description — THIS is what the selection algorithm reads to score relevance
type: feedback | user | project | reference
---
```

**Write the description as if answering "when should this file load?"**

Good: `"When writing bash scripts or debugging exit code errors in this repo"`  
Bad: `"Bash notes"`

Good: `"When the user asks about Linear tickets or git commits at Two"`  
Bad: `"Work workflow"`

## Memory types and their formats

**feedback** — corrections and confirmed approaches:

```markdown
Lead with the rule, then explain it.

**Why:** the reason the user gave or the incident that prompted this
**How to apply:** when this kicks in and what to do
```

Both corrections ("don't do X") and confirmations ("yes, that was right") are worth saving. Confirmations prevent drifting away from approaches the user has already validated.

**user** — who the user is, how they want to collaborate:

```markdown
User is a senior Go engineer, new to the React side of this repo.
Frame frontend explanations using backend analogues.
```

Keep these to things that change how you write code or explain things — not biographical details.

**project** — decisions, constraints, deadlines:

```markdown
Auth middleware rewrite is driven by compliance requirements, not tech debt.

**Why:** Legal flagged session token storage as non-compliant
**How to apply:** Scope decisions should favour compliance over ergonomics; don't revert toward the old pattern
```

Convert relative dates to absolute when saving ("Thursday" → "2026-03-05") so the memory stays interpretable after time passes.

**reference** — where things live in external systems:

```markdown
Pipeline bugs tracked in Linear project "INGEST".
Oncall latency dashboard at grafana.internal/d/api-latency — check when editing request-path code.
```

## What makes entries actionable

Include the **Why** and **How to apply** lines — not just what to do but when and why. Future sessions often face edge cases where the rule isn't obviously applicable; context lets you judge rather than blindly follow.

Before saving, ask:

- Would I know what to do differently because of this entry?
- Is this specific enough to act on, or vague enough to ignore?
- Will this still be true in a month?

## What not to save

- Code patterns and conventions — read the code
- Git history, recent changes — `git log` is authoritative  
- Debugging sessions where the fix is now in the code — the commit message has the context
- In-progress work or current session state — ephemeral
- Things already in CLAUDE.md

## Global vs project-specific

`~/.claude/memory/` — global, loads in every project. Use for preferences, communication style, cross-project workflows.

`.claude/memory/` — project-specific. Use for project constraints, decisions, patterns unique to this codebase.

When in doubt, prefer project-specific. Global memory accumulates quickly and lowers selection quality across all projects.

## Keeping memory fresh

Staleness degrades quality faster than you expect. Set a reminder to run `dream` after completing a major project phase — it prunes outdated entries and prevents the 1-day staleness warning from polluting sessions with noise.
