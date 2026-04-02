# agentic-utils Skills

Custom Claude Code plugin marketplace.

## Installation

```bash
/plugin marketplace add https://github.com/agentic-utils/skills
```

Then use `/plugin` to browse and install available plugins.

## Plugins

| Plugin         | Description                                                    |
| -------------- | -------------------------------------------------------------- |
| [claude-code]  | Skills grounded in Claude Code internals                       |
| [disk-cleanup] | Scan for and clean up disk space on macOS (macOS only)         |
| [ty-lsp]       | Python type checking via [ty](https://github.com/astral-sh/ty) |
| [svelte-lsp]   | Svelte language server                                         |

[claude-code]: plugins/claude-code/README.md
[disk-cleanup]: plugins/disk-cleanup/README.md
[ty-lsp]: plugins/ty-lsp/README.md
[svelte-lsp]: plugins/svelte-lsp/README.md

## Contributing

See [AGENTS.md](AGENTS.md) for development guidelines.

1. Create or update a plugin directory under `plugins/`
2. Add skills in `plugins/<plugin-name>/skills/`
3. Add a `README.md` to the plugin directory
4. Update this `README.md` table
5. Submit a PR
