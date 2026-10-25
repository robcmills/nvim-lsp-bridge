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
| `completions` | `<file> <line> <col>` | Get completion candidates at a position |
| `definition` | `<file> <line> <col>` | Get definition location for a symbol |
| `diagnostics` | `[file ...]` | Get LSP diagnostics (optionally filtered to one or more files) |
| `hover` | `<file> <line> <col>` | Get hover/type information at a position |
| `list` | | List all running Neovim instances and their sockets |
| `references` | `<file> <line> <col>` | Find all references to a symbol |
| `sync` | `<file>` | Notify LSP of external file changes |

### Examples

```bash
# List running Neovim instances
bun run index.ts list

# Get all diagnostics
bun run index.ts diagnostics

# Get diagnostics for a specific file
bun run index.ts diagnostics src/main.ts

# Get diagnostics for multiple files in one synchronized query
bun run index.ts diagnostics src/main.ts src/store.ts docs/ARCHITECTURE.md

# Get hover info at line 10, column 5
bun run index.ts hover src/main.ts 10 5

# Go to definition
bun run index.ts definition src/main.ts 10 5

# Find references
bun run index.ts references src/main.ts 10 5

# Get completions
bun run index.ts completions src/main.ts 10 5

# Sync a file after external changes
bun run index.ts sync src/main.ts
```

## Diagnostics Errors

`diagnostics <file ...>` never reports a clean `[]` it can't vouch for. It exits non-zero with an `Error:` on stderr instead when:

- **A server never reports.** After syncing each file, the CLI waits for a fresh report from every client that always sends one, even for a clean file: TypeScript servers (`ts_ls`, `vtsls`, `typescript-tools`) and pull-diagnostic servers such as `eslint`. Push-only servers that may stay silent on a clean file aren't waited for. A `.ts`/`.js` file with no TypeScript server attached also counts as no report. The wait is 60s by default (a cold tsserver on a large project can take 30s+); set `NVIM_LSP_DIAGNOSTICS_TIMEOUT_MS` to change it. Retrying after a timeout is safe: a client that still hasn't reported for a buffer triggers a fresh resync.
- **TypeScript isn't the workspace's own.** If the TypeScript server's root has no `node_modules/typescript` (in the root or a parent), or its `tsserver.js` isn't that copy, typescript-language-server has fallen back to a global TypeScript that can't resolve the project's imports. Run `pnpm install` in the root, then `:LspRestart`.

The wait runs in the CLI, polling Neovim, so the editor stays responsive. Other commands (`sync`, `hover`, ...) wait up to 10s for the same reports but never fail on a timeout.

## Neovim Instance Selection

The tool automatically discovers running Neovim instances by scanning socket files in `$TMPDIR`. When multiple instances are found, it tries to auto-select one in this order:

1. **Exact CWD match** — an instance whose working directory equals your shell's CWD.
2. **Parent CWD match** — the deepest instance whose working directory is a parent of your shell's CWD.

If no instance's CWD is an ancestor of your shell's CWD, you're prompted to choose one.

To skip the prompt, set the `NVIM_LISTEN_ADDRESS` environment variable:

```bash
export NVIM_LISTEN_ADDRESS=/path/to/nvim/socket
```

You can manually specify the socket path when starting Neovim:
```bash
nvim --listen /tmp/nvim.sock
```

## Claude Code Hook

You can configure a [Claude Code hook](https://docs.anthropic.com/en/docs/claude-code/hooks) to automatically sync files with Neovim's LSP whenever Claude edits or writes a file. This prevents stale diagnostics when an AI agent makes changes outside of Neovim.

Add the following to your project's `.claude/settings.json` (or `~/.claude/settings.json` for all projects):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs -I {} bun run /path/to/nvim-lsp-bridge/index.ts sync {}"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/nvim-lsp-bridge` with the actual path to this project.

The hook runs after every `Edit` or `Write` tool call. It reads the file path from the hook's JSON stdin and calls `nvim-lsp sync` to reload the buffer in Neovim, triggering a full LSP resync (including on-save linters like ESLint).
