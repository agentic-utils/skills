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

## Testing

After installing, restart Claude Code. Create a file with type errors:

```python
# test.py
x: int = "not an int"

def add(a: int, b: int) -> int:
    return a + b

result: str = add(1, 2)
```

Verify the LSP is running:

```bash
ps aux | grep "ty server"
```

Edit or read the file - diagnostics should appear in system reminders:

```text
test.py:
  ✘ [Line 2:10] Object of type `Literal["not an int"]` is not assignable to `int` [invalid-assignment] (ty)
  ✘ [Line 7:15] Object of type `int` is not assignable to `str` [invalid-assignment] (ty)
```

## More Information

- [ty on GitHub](https://github.com/astral-sh/ty)
- [ty Documentation](https://docs.astral.sh/ty/)
