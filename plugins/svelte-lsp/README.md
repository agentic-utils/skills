# svelte-lsp

Svelte language server for Claude Code, providing code intelligence for Svelte components.

## Supported Extensions

`.svelte`

## Install

```bash
claude plugin install @agentic-utils/svelte-lsp
```

## Requirements

- Node.js and npm must be installed

The LSP is automatically installed via `npx svelte-language-server` on first use. No manual installation required.

## Testing

After installing, restart Claude Code. Create a file with type errors:

```svelte
<!-- test.svelte -->
<script lang="ts">
  let count: number = "not a number";
</script>
```

Verify the LSP is running:

```bash
ps aux | grep svelte
```

Edit or read the file - diagnostics should appear in system reminders:

```text
test.svelte:
  ✘ [Line 3:7] Type 'string' is not assignable to type 'number'. [2322] (ts)
```

## More Information

- [svelte-language-server on npm](https://www.npmjs.com/package/svelte-language-server)
- [Svelte Documentation](https://svelte.dev/docs)
