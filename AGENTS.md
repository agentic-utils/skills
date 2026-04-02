# Plugin Development

This repo is a Claude Code plugin marketplace. Each plugin lives under `plugins/` and can contain skills, LSP servers, or both.

## Structure

```text
.claude-plugin/
  marketplace.json        # Marketplace manifest — lists all plugins
plugins/
  <plugin-name>/
    plugin.json           # Plugin metadata
    README.md             # Required — describes the plugin and its skills
    skills/
      <skill-name>.md     # One file per skill
```

## Creating a Plugin

1. Create `plugins/<plugin-name>/plugin.json`
2. Add an entry in `.claude-plugin/marketplace.json` (required — plugin will not appear in the marketplace otherwise)
3. Add skills under `plugins/<plugin-name>/skills/`
4. Write a `README.md` (required — see below)
5. Update the root `README.md` table

## Plugin README (required)

Every plugin must have a `README.md`. It should include:

- A one-line description of what the plugin does
- A skills table with trigger phrases and descriptions
- An install command
- Any background context worth linking to

Use `plugins/claude-code/README.md` as a reference.

## Creating a Skill

Create `plugins/<plugin-name>/skills/<skill-name>.md`:

```yaml
---
name: skill-name
description: Trigger-oriented description of when this skill should be used.
metadata:
  trigger: Specific phrases that should load this skill
  author: agentic-utils
---
```

Guidelines:

- Keep the skill file concise and action-oriented
- Lead with what the skill does and when to use it
- Use concrete commands and examples over abstract advice
- Include safety rules and failure handling where relevant

## Updating a Plugin

### When to bump the version

Claude Code caches plugins and only re-fetches when the version in `plugin.json` changes. Bump it whenever a change would affect behaviour for existing users:

- Skill instructions changed (different process, new steps, updated commands)
- Trigger phrases added or removed
- Safety rules or constraints changed
- Bug fix that changes what the skill does

Do **not** bump for:

- Typo or wording fixes that don't change behaviour
- README-only changes
- Adding a new skill to the plugin (the new skill has no cached version to invalidate)

### How to bump

`plugin.json` uses semver. Follow these rules:

- **Patch** (`1.0.0` → `1.0.1`) — bug fix or minor clarification that changes behaviour
- **Minor** (`1.0.0` → `1.1.0`) — new skill added to the plugin, or meaningful new capability in an existing skill
- **Major** (`1.0.0` → `2.0.0`) — breaking change (skill renamed, trigger phrases removed, process changed in a way that invalidates cached expectations)

Also bump the version in `.claude-plugin/marketplace.json` to match.

## Formatting

All markdown files are formatted with `rumdl`. The pre-commit hook runs automatically on commit. To run manually:

```bash
pre-commit run --all-files
```

Table columns should be manually aligned — rumdl does not auto-align them.
