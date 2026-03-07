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
| `list` | | List all running Neovim instances and their sockets |
| `diagnostics` | `[file]` | Get LSP diagnostics (optionally filtered to a file) |
| `hover` | `<file> <line> <col>` | Get hover/type information at a position |
| `definition` | `<file> <line> <col>` | Get definition location for a symbol |
| `references` | `<file> <line> <col>` | Find all references to a symbol |
| `completions` | `<file> <line> <col>` | Get completion candidates at a position |

### Examples

```bash
# List running Neovim instances
bun run index.ts list

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

The tool automatically discovers running Neovim instances by scanning socket files in `$TMPDIR`. When multiple instances are found, it automatically selects the one whose working directory matches your current directory (exact match or parent directory). If no match is found, it prompts you to select one.

To skip the prompt, set the `NVIM_LISTEN_ADDRESS` environment variable:

```bash
export NVIM_LISTEN_ADDRESS=/path/to/nvim/socket
```

You can manually specify the socket path when starting Neovim:
```bash
nvim --listen /tmp/nvim.sock
```
