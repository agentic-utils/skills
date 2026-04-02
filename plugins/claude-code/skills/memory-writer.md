---
name: memory-writer
description: Write effective memory file entries. Covers what makes entries get loaded, why staleness matters, how to write descriptions that score well for relevance, and what format makes entries actionable.
metadata:
  trigger: When asked to "write a memory", "add to memory", "update my memory files", "how should I write this memory", or when creating new entries for a project config file
  author: agentic-utils
---

# Memory Writer

How to write memory entries that get loaded, stay fresh, and give the AI enough context to act.

## What makes a good description

Most AI assistants with memory systems use the `description` field to decide which files to load for a given task. Treat it as the answer to "when should this file load?"

Good: `"When writing bash scripts or debugging exit code errors in this repo"`
Bad: `"Bash notes"`

Good: `"When the user asks about database migrations in this project"`
Bad: `"Work workflow"`

Vague descriptions lose to specific ones. If the description could apply to any project, it is not specific enough.

## Memory index files

If your tool uses an index file (e.g. `MEMORY.md`) to track memory files, keep it short and scannable. Each entry should be one line:

```markdown
- [Short Title](file.md) — specific hook: what this memory is about and when it matters
```

Good:

```markdown
- [DB Migration Pattern](db-migrations.md) — always run reset after switching worktrees
```

Bad:

```markdown
- [Notes](notes.md) — various notes about the project
```

## File format

A common memory file format uses frontmatter for metadata and markdown for content:

```markdown
---
name: short-kebab-name
description: one-line description — used to decide relevance
type: feedback | user | project | reference
---

The memory content.
```

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

Include **Why** and **How to apply** lines — not just what to do but when and why. Future sessions often face edge cases where the rule is not obviously applicable; context lets you judge rather than blindly follow.

Before saving, ask:

- Would I know what to do differently because of this entry?
- Is this specific enough to act on, or vague enough to ignore?
- Will this still be true in a month?

## What not to save

- Code patterns and conventions — read the code
- Git history, recent changes — `git log` is authoritative
- Debugging sessions where the fix is now in the code — the commit message has the context
- In-progress work or current session state — ephemeral
- Things already in your project config file

## Keeping memory fresh

Stale memory is worse than no memory — the AI may confidently cite things that no longer exist. Run `dream` periodically to prune outdated entries and keep memory files reflecting current reality.
