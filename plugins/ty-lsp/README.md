# ty-lsp

Python language server (ty) for Claude Code, providing static type checking and code intelligence.

## Supported Extensions
`.py`, `.pyi`

## Requirements

- [uv](https://docs.astral.sh/uv/) must be installed

The LSP is automatically installed via `uvx ty@latest server` on first use - no manual installation required.

## Notes

### Monorepo Usage

For monorepos with multiple Python projects, start Claude Code from within the specific project directory:

```bash
# Instead of:
cd ~/Code/monorepo && claude

# Do this:
cd ~/Code/monorepo/my-python-project && claude
```

This ensures ty uses the correct project's `.venv` and `pyproject.toml`.

## More Information
- [ty on GitHub](https://github.com/astral-sh/ty)
- [ty Documentation](https://docs.astral.sh/ty/)
