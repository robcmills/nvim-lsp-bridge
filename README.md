# nvim-lsp-bridge

A CLI tool that connects to a running Neovim instance via its RPC socket and exposes LSP features as JSON output. This lets external tools (like AI agents) query Neovim's LSP for diagnostics, hover info, definitions, references, and completions.

## Install

```bash
bun install
```

## Usage

```bash
bun run index.ts <command> [args...]
```

### Commands

| Command | Args | Description |
|---------|------|-------------|
| `diagnostics` | `[file]` | Get LSP diagnostics (optionally filtered to a file) |
| `hover` | `<file> <line> <col>` | Get hover/type information at a position |
| `definition` | `<file> <line> <col>` | Get definition location for a symbol |
| `references` | `<file> <line> <col>` | Find all references to a symbol |
| `completions` | `<file> <line> <col>` | Get completion candidates at a position |

### Examples

```bash
# Get all diagnostics
bun run index.ts diagnostics

# Get diagnostics for a specific file
bun run index.ts diagnostics src/main.ts

# Get hover info at line 10, column 5
bun run index.ts hover src/main.ts 10 5

# Go to definition
bun run index.ts definition src/main.ts 10 5

# Find references
bun run index.ts references src/main.ts 10 5

# Get completions
bun run index.ts completions src/main.ts 10 5
```

## Neovim Instance Selection

The tool automatically discovers running Neovim instances by scanning socket files in `$TMPDIR`. If multiple instances are found, it prompts you to select one.

To skip the prompt, set the `NVIM_LISTEN_ADDRESS` environment variable:

```bash
export NVIM_LISTEN_ADDRESS=/path/to/nvim/socket
```
