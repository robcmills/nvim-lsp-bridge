import { attach, type NeovimClient } from "neovim";
import { createConnection, type Socket } from "net";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function findNeovimSocket(): string {
  if (process.env.NVIM_LISTEN_ADDRESS) {
    return process.env.NVIM_LISTEN_ADDRESS;
  }

  // On macOS, Neovim sockets are in $TMPDIR/nvim.$USER/*/nvim.*.0
  const user = process.env.USER || "unknown";
  const nvimDir = join(tmpdir(), `nvim.${user}`);

  try {
    const subdirs = readdirSync(nvimDir);
    let newest = { path: "", mtime: 0 };
    for (const sub of subdirs) {
      const subPath = join(nvimDir, sub);
      const files = readdirSync(subPath);
      for (const f of files) {
        if (f.startsWith("nvim.") && f.endsWith(".0")) {
          const fullPath = join(subPath, f);
          const st = statSync(fullPath);
          if (st.mtimeMs > newest.mtime) {
            newest = { path: fullPath, mtime: st.mtimeMs };
          }
        }
      }
    }
    if (newest.path) return newest.path;
  } catch {}

  throw new Error(
    "No Neovim socket found. Start Neovim with: nvim --listen /tmp/nvim.sock\n" +
    "Or set NVIM_LISTEN_ADDRESS environment variable."
  );
}

function connectToNvim(): { nvim: NeovimClient; socket: Socket } {
  const socketPath = findNeovimSocket();
  const socket = createConnection(socketPath);
  const nvim = attach({ reader: socket, writer: socket });
  return { nvim, socket };
}

function disconnect(socket: Socket): void {
  socket.destroy();
}

async function getDiagnostics(file?: string) {
  const { nvim, socket } = connectToNvim();

  const luaArgs = file ? [file] : [];
  const diagnostics = await nvim.lua(`
    local filter_file = select(1, ...)
    local diags = vim.diagnostic.get()
    local results = {}
    for _, d in ipairs(diags) do
      local fname = vim.api.nvim_buf_get_name(d.bufnr or 0)
      if filter_file == nil or fname:find(filter_file, 1, true) then
        table.insert(results, {
          file = fname,
          line = d.lnum + 1,
          col = d.col + 1,
          severity = d.severity,
          message = d.message,
          source = d.source or "unknown"
        })
      end
    end
    return results
  `, luaArgs);

  disconnect(socket);
  return diagnostics;
}

async function getHover(file: string, line: number, col: number) {
  const { nvim, socket } = connectToNvim();

  const result = await nvim.lua(`
    local file, line, col = ...

    -- Find or open the buffer
    local bufnr = vim.fn.bufnr(file)
    if bufnr == -1 then
      vim.cmd('badd ' .. file)
      bufnr = vim.fn.bufnr(file)
    end

    -- Get LSP clients for this buffer
    local clients = vim.lsp.get_clients({ bufnr = bufnr })
    if #clients == 0 then
      return { error = "No LSP client attached to " .. file }
    end

    -- Synchronous hover request
    local params = {
      textDocument = vim.lsp.util.make_text_document_params(bufnr),
      position = { line = line - 1, character = col - 1 }
    }

    local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/hover', params, 3000)
    if not responses then
      return { error = "No hover response" }
    end

    for _, resp in pairs(responses) do
      if resp.result and resp.result.contents then
        local contents = resp.result.contents
        if type(contents) == "table" then
          return { result = contents.value or vim.inspect(contents) }
        end
        return { result = tostring(contents) }
      end
    end

    return { error = "No hover info found" }
  `, [file, line, col]);

  disconnect(socket);
  return result;
}

async function getDefinition(file: string, line: number, col: number) {
  const { nvim, socket } = connectToNvim();

  const result = await nvim.lua(`
    local file, line, col = ...

    local bufnr = vim.fn.bufnr(file)
    if bufnr == -1 then
      vim.cmd('badd ' .. file)
      bufnr = vim.fn.bufnr(file)
    end

    local params = {
      textDocument = vim.lsp.util.make_text_document_params(bufnr),
      position = { line = line - 1, character = col - 1 }
    }

    local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/definition', params, 3000)
    if not responses then
      return { error = "No definition response" }
    end

    local results = {}
    for _, resp in pairs(responses) do
      if resp.result then
        local defs = type(resp.result[1]) == "table" and resp.result or { resp.result }
        for _, def in ipairs(defs) do
          local uri = def.uri or def.targetUri
          local range = def.range or def.targetSelectionRange
          if uri and range then
            table.insert(results, {
              file = vim.uri_to_fname(uri),
              line = range.start.line + 1,
              col = range.start.character + 1
            })
          end
        end
      end
    end

    return results
  `, [file, line, col]);

  disconnect(socket);
  return result;
}

async function getReferences(file: string, line: number, col: number) {
  const { nvim, socket } = connectToNvim();

  const result = await nvim.lua(`
    local file, line, col = ...

    local bufnr = vim.fn.bufnr(file)
    if bufnr == -1 then
      vim.cmd('badd ' .. file)
      bufnr = vim.fn.bufnr(file)
    end

    local params = {
      textDocument = vim.lsp.util.make_text_document_params(bufnr),
      position = { line = line - 1, character = col - 1 },
      context = { includeDeclaration = true }
    }

    local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/references', params, 5000)
    if not responses then
      return { error = "No references response" }
    end

    local results = {}
    for _, resp in pairs(responses) do
      if resp.result then
        for _, ref in ipairs(resp.result) do
          table.insert(results, {
            file = vim.uri_to_fname(ref.uri),
            line = ref.range.start.line + 1,
            col = ref.range.start.character + 1
          })
        end
      end
    end

    return results
  `, [file, line, col]);

  disconnect(socket);
  return result;
}

async function getCompletions(file: string, line: number, col: number) {
  const { nvim, socket } = connectToNvim();

  const result = await nvim.lua(`
    local file, line, col = ...

    local bufnr = vim.fn.bufnr(file)
    if bufnr == -1 then
      vim.cmd('badd ' .. file)
      bufnr = vim.fn.bufnr(file)
    end

    local params = {
      textDocument = vim.lsp.util.make_text_document_params(bufnr),
      position = { line = line - 1, character = col - 1 }
    }

    local responses = vim.lsp.buf_request_sync(bufnr, 'textDocument/completion', params, 3000)
    if not responses then
      return { error = "No completion response" }
    end

    local results = {}
    for _, resp in pairs(responses) do
      if resp.result then
        local items = resp.result.items or resp.result
        for i, item in ipairs(items) do
          if i > 20 then break end  -- limit results
          table.insert(results, {
            label = item.label,
            kind = item.kind,
            detail = item.detail
          })
        end
      end
    end

    return results
  `, [file, line, col]);

  disconnect(socket);
  return result;
}

// --- CLI Interface ---
const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  try {
    let result: unknown;

    switch (command) {
      case "diagnostics":
        result = await getDiagnostics(args[0]);
        break;
      case "hover":
        result = await getHover(args[0], parseInt(args[1]), parseInt(args[2]));
        break;
      case "definition":
        result = await getDefinition(args[0], parseInt(args[1]), parseInt(args[2]));
        break;
      case "references":
        result = await getReferences(args[0], parseInt(args[1]), parseInt(args[2]));
        break;
      case "completions":
        result = await getCompletions(args[0], parseInt(args[1]), parseInt(args[2]));
        break;
      default:
        console.error(`Usage: nvim-lsp <command> [args...]

Commands:
  diagnostics [file]              Get LSP diagnostics
  hover <file> <line> <col>       Get hover/type info
  definition <file> <line> <col>  Go to definition
  references <file> <line> <col>  Find references
  completions <file> <line> <col> Get completions`);
        process.exit(1);
    }

    const output = JSON.stringify(result, null, 2);
    await new Promise<void>((resolve) => {
      process.stdout.write(output + "\n", () => resolve());
    });
    process.exit(0);
  } catch (err) {
    const { writeFileSync } = await import("fs");
    writeFileSync("/tmp/nvim-bridge-error.log", String(err) + "\n" + (err instanceof Error ? err.stack : ""));
    await new Promise<void>((resolve) => {
      process.stderr.write("Error: " + String(err) + "\n", () => resolve());
    });
    process.exit(1);
  }
}

main();
