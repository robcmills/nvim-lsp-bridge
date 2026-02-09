# nvim-lsp-bridge

A CLI tool that connects to a running Neovim instance via its RPC socket and exposes LSP features as JSON output. This lets external tools (like AI agents) query Neovim's LSP for diagnostics, hover info, definitions, references, and completions.

Includes a [Model Context Protocol](https://github.com/ModelContextProtocol/model-context-protocol) server for AI agents to use.

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

## MCP Server

An MCP (Model Context Protocol) server is included so AI agents like Claude Code can use Neovim's LSP features as tools.

### Running

```bash
bun run mcp.ts
```

### Socket Selection

The MCP server uses non-interactive socket selection:
- If `NVIM_LISTEN_ADDRESS` is set, it uses that socket
- If exactly one Neovim instance is running, it auto-connects
- If multiple instances are found, it returns an error asking you to set `NVIM_LISTEN_ADDRESS`

### Available Tools

| Tool | Input | Description |
|------|-------|-------------|
| `get_diagnostics` | `{ file?: string }` | Get LSP diagnostics, optionally filtered to a file |
| `get_hover` | `{ file, line, col }` | Get hover/type info at a position (1-based) |
| `get_definition` | `{ file, line, col }` | Get definition location for a symbol |
| `get_references` | `{ file, line, col }` | Find all references to a symbol |
| `get_completions` | `{ file, line, col }` | Get completion candidates at a position |


### Claude Code Integration

Add the MCP server to Claude Code:

```bash
claude mcp add-json --scope user nvim-lsp-bridge '{"type":"stdio","command":"bun","args":["run","/path/to/nvim-lsp-bridge/mcp.ts"],"env":{"NVIM_LISTEN_ADDRESS":"/path/to/nvim/socket"}}'
```

Replace `/path/to/nvim-lsp-bridge/mcp.ts` with the absolute path to `mcp.ts` in your clone of this repo, and `/path/to/nvim/socket` with your Neovim socket path.

Restart Claude Code for the tools to become available.

You can confirm the server was added by running `claude mcp list`.
