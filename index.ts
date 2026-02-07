import { attach, type NeovimClient } from "neovim";
import { createConnection, type Socket } from "net";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const luaDir = join(import.meta.dir, "lua");

function readLua(name: string): Promise<string> {
  return Bun.file(join(luaDir, `${name}.lua`)).text();
}

// Cache lua scripts at startup
const lua = {
  diagnostics: await readLua("diagnostics"),
  hover: await readLua("hover"),
  definition: await readLua("definition"),
  references: await readLua("references"),
  completions: await readLua("completions"),
};

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
  const diagnostics = await nvim.lua(lua.diagnostics, luaArgs);
  disconnect(socket);
  return diagnostics;
}

async function getHover(file: string, line: number, col: number) {
  const { nvim, socket } = connectToNvim();
  const result = await nvim.lua(lua.hover, [file, line, col]);
  disconnect(socket);
  return result;
}

async function getDefinition(file: string, line: number, col: number) {
  const { nvim, socket } = connectToNvim();
  const result = await nvim.lua(lua.definition, [file, line, col]);
  disconnect(socket);
  return result;
}

async function getReferences(file: string, line: number, col: number) {
  const { nvim, socket } = connectToNvim();
  const result = await nvim.lua(lua.references, [file, line, col]);
  disconnect(socket);
  return result;
}

async function getCompletions(file: string, line: number, col: number) {
  const { nvim, socket } = connectToNvim();
  const result = await nvim.lua(lua.completions, [file, line, col]);
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
      case "definition":
      case "references":
      case "completions": {
        const file = args[0];
        const line = args[1];
        const col = args[2];
        if (!file || !line || !col) {
          console.error(`Usage: nvim-lsp ${command} <file> <line> <col>`);
          process.exit(1);
        }
        const fns = { hover: getHover, definition: getDefinition, references: getReferences, completions: getCompletions };
        result = await fns[command](file, parseInt(line), parseInt(col));
        break;
      }
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
