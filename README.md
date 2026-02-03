# agentic-utils Claude Plugins

Custom Claude Code plugin marketplace with additional LSP servers.

## Available Plugins

| Plugin | Description | Requirements |
|--------|-------------|--------------|
| [ty-lsp](plugins/ty-lsp) | Python type checking via [ty](https://github.com/astral-sh/ty) | [uv](https://docs.astral.sh/uv/) |
| [svelte-lsp](plugins/svelte-lsp) | Svelte language server | Node.js |

LSP servers are auto-installed on first use via `uvx`/`npx`.

## Installation

Add the marketplace to Claude Code:

```bash
/plugin marketplace add https://github.com/agentic-utils/claude-plugins
```

Install plugins:

```bash
/plugin install ty-lsp@agentic-utils
/plugin install svelte-lsp@agentic-utils
```

Restart Claude Code after installation.

## Local Development

For local development, add to `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "agentic-utils": {
      "source": {
        "source": "directory",
        "path": "/path/to/claude-plugins"
      }
    }
  }
}
```

## Testing

See individual plugin READMEs for testing instructions. After installing a plugin, restart Claude Code to start the LSP server. Diagnostics appear in system reminders after tool use.
