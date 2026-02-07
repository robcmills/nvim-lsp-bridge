import { attach, type NeovimClient } from "neovim";
import { createConnection, type Socket } from "net";
import { readdirSync } from "fs";
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

interface NvimInstance {
  socketPath: string;
  cwd: string;
}

function findAllNeovimSockets(): string[] {
  // On macOS, Neovim sockets are in $TMPDIR/nvim.$USER/*/nvim.*.0
  const user = process.env.USER || "unknown";
  const nvimDir = join(tmpdir(), `nvim.${user}`);
  const sockets: string[] = [];

  try {
    const subdirs = readdirSync(nvimDir);
    for (const sub of subdirs) {
      const subPath = join(nvimDir, sub);
      try {
        const files = readdirSync(subPath);
        for (const f of files) {
          if (f.startsWith("nvim.") && f.endsWith(".0")) {
            sockets.push(join(subPath, f));
          }
        }
      } catch {}
    }
  } catch {}

  return sockets;
}

async function getNvimInfo(socketPath: string): Promise<NvimInstance | null> {
  try {
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const nvim = attach({ reader: socket, writer: socket });
    const cwd = await nvim.lua("return vim.fn.getcwd()", []);
    socket.destroy();
    return { socketPath, cwd: String(cwd) };
  } catch {
    return null;
  }
}

function promptChoice(question: string): Promise<string> {
  process.stderr.write(question);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim());
    });
  });
}

async function selectNeovimSocket(): Promise<string> {
  if (process.env.NVIM_LISTEN_ADDRESS) {
    return process.env.NVIM_LISTEN_ADDRESS;
  }

  const sockets = findAllNeovimSockets();

  if (sockets.length === 0) {
    console.error(
      "No Neovim instances found.\n\n" +
      "Start Neovim or set NVIM_LISTEN_ADDRESS to a socket path.\n" +
      "Example: export NVIM_LISTEN_ADDRESS=/tmp/nvim.sock"
    );
    process.exit(1);
  }

  if (sockets.length === 1) {
    return sockets[0]!;
  }

  // Multiple sockets found - connect to each to get identifying info
  const instances = (await Promise.all(sockets.map(getNvimInfo))).filter(
    (i): i is NvimInstance => i !== null
  );

  if (instances.length === 0) {
    console.error(
      "Found Neovim sockets but could not connect to any of them.\n" +
      "The Neovim instances may have exited. Try restarting Neovim."
    );
    process.exit(1);
  }

  if (instances.length === 1) {
    return instances[0]!.socketPath;
  }

  const cyan = "\x1b[1;36m";
  const gray = "\x1b[38;5;248m";
  const green = "\x1b[32m";
  const yellow = "\x1b[33m";
  const magenta = "\x1b[35m";
  const orange = "\x1b[38;5;214m";
  const reset = "\x1b[0m";

  process.stderr.write(`${orange}Multiple Neovim instances found:${reset}\n\n`);
  for (let i = 0; i < instances.length; i++) {
    process.stderr.write(`  ${cyan}${i + 1}) ${instances[i]!.cwd}${reset}\n     ${gray}${instances[i]!.socketPath}${reset}\n`);
  }
  process.stderr.write(
    `\n${gray}Tip: Set ${cyan}NVIM_LISTEN_ADDRESS${gray} to skip this prompt.${reset}\n` +
    `${gray}Example:${reset} ${green}export${reset} ${cyan}NVIM_LISTEN_ADDRESS${reset}${yellow}=${reset}${magenta}/path/to/nvim/socket${reset}\n\n`
  );

  const answer = await promptChoice(`Select instance (1-${instances.length}): `);
  const idx = parseInt(answer) - 1;

  if (isNaN(idx) || idx < 0 || idx >= instances.length) {
    console.error("Invalid selection.");
    process.exit(1);
  }

  return instances[idx]!.socketPath;
}

async function connectToNvim(): Promise<{ nvim: NeovimClient; socket: Socket }> {
  const socketPath = await selectNeovimSocket();
  const socket = createConnection(socketPath);
  const nvim = attach({ reader: socket, writer: socket });
  return { nvim, socket };
}

function disconnect(socket: Socket): void {
  socket.destroy();
}

async function getDiagnostics(file?: string) {
  const { nvim, socket } = await connectToNvim();
  const luaArgs = file ? [file] : [];
  const diagnostics = await nvim.lua(lua.diagnostics, luaArgs);
  disconnect(socket);
  return diagnostics;
}

async function getHover(file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim();
  const result = await nvim.lua(lua.hover, [file, line, col]);
  disconnect(socket);
  return result;
}

async function getDefinition(file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim();
  const result = await nvim.lua(lua.definition, [file, line, col]);
  disconnect(socket);
  return result;
}

async function getReferences(file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim();
  const result = await nvim.lua(lua.references, [file, line, col]);
  disconnect(socket);
  return result;
}

async function getCompletions(file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim();
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
