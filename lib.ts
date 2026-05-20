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
export const lua = {
  syncBuffer: await readLua("sync_buffer"),
  diagnostics: await readLua("diagnostics"),
  hover: await readLua("hover"),
  definition: await readLua("definition"),
  references: await readLua("references"),
  completions: await readLua("completions"),
};

export interface NvimInstance {
  socketPath: string;
  cwd: string;
}

export type SocketSelector = () => Promise<string>;

export function findAllNeovimSockets(): string[] {
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

export async function getNvimInfo(socketPath: string, timeoutMs = 2000): Promise<NvimInstance | null> {
  let socket: Socket | null = null;
  try {
    socket = createConnection(socketPath);
    const conn = socket;
    await new Promise<void>((resolve, reject) => {
      conn.once("connect", resolve);
      conn.once("error", reject);
    });
    const nvim = attach({ reader: socket, writer: socket });
    // Guard against nvim instances that accept connections but never respond
    // (seen with nvim processes stuck on modal prompts or deadlocked event loops).
    const cwd = await Promise.race([
      nvim.lua("return vim.fn.getcwd()", []),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("nvim_exec_lua timed out")), timeoutMs)
      ),
    ]);
    socket.destroy();
    return { socketPath, cwd: String(cwd) };
  } catch {
    socket?.destroy();
    return null;
  }
}

export function findInstanceByCwd(
  instances: NvimInstance[],
  cwd: string = process.cwd(),
): NvimInstance | null {
  // 1. Exact match
  for (const inst of instances) {
    if (cwd === inst.cwd) return inst;
  }

  // 2. Longest prefix match (instance CWD is a parent of shell CWD)
  let prefixBest: NvimInstance | null = null;
  for (const inst of instances) {
    if (cwd.startsWith(inst.cwd + "/") && (!prefixBest || inst.cwd.length > prefixBest.cwd.length)) {
      prefixBest = inst;
    }
  }
  return prefixBest;
}

export function createAutoSocketSelector(): SocketSelector {
  return async () => {
    if (process.env.NVIM_LISTEN_ADDRESS) {
      return process.env.NVIM_LISTEN_ADDRESS;
    }

    const sockets = findAllNeovimSockets();

    if (sockets.length === 0) {
      throw new Error(
        "No Neovim instances found. Start Neovim or set NVIM_LISTEN_ADDRESS."
      );
    }

    if (sockets.length === 1) {
      return sockets[0]!;
    }

    // Multiple sockets — try to filter to live ones
    const instances = (await Promise.all(sockets.map(getNvimInfo))).filter(
      (i): i is NvimInstance => i !== null
    );

    if (instances.length === 0) {
      throw new Error(
        "Found Neovim sockets but could not connect to any of them."
      );
    }

    if (instances.length === 1) {
      return instances[0]!.socketPath;
    }

    // Try to match by current working directory
    const match = findInstanceByCwd(instances);
    if (match) {
      return match.socketPath;
    }

    throw new Error(
      `Multiple Neovim instances found (${instances.length}). ` +
      "Set NVIM_LISTEN_ADDRESS or run from a directory matching a Neovim instance."
    );
  };
}

export async function connectToNvim(
  selectSocket: SocketSelector
): Promise<{ nvim: NeovimClient; socket: Socket }> {
  const socketPath = await selectSocket();
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const nvim = attach({ reader: socket, writer: socket });
  return { nvim, socket };
}

export function disconnect(socket: Socket): void {
  socket.destroy();
}

export async function syncBuffer(selectSocket: SocketSelector, file: string) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    return await nvim.lua(lua.syncBuffer, [file]);
  } finally {
    disconnect(socket);
  }
}

export async function getDiagnostics(selectSocket: SocketSelector, file?: string) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    if (file) {
      await nvim.lua(lua.syncBuffer, [file, true]);
    }
    return await nvim.lua(lua.diagnostics, file ? [file] : []);
  } finally {
    disconnect(socket);
  }
}

export async function getHover(selectSocket: SocketSelector, file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    await nvim.lua(lua.syncBuffer, [file, true]);
    return await nvim.lua(lua.hover, [file, line, col]);
  } finally {
    disconnect(socket);
  }
}

export async function getDefinition(selectSocket: SocketSelector, file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    await nvim.lua(lua.syncBuffer, [file, true]);
    return await nvim.lua(lua.definition, [file, line, col]);
  } finally {
    disconnect(socket);
  }
}

export async function getReferences(selectSocket: SocketSelector, file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    await nvim.lua(lua.syncBuffer, [file, true]);
    return await nvim.lua(lua.references, [file, line, col]);
  } finally {
    disconnect(socket);
  }
}

export async function getCompletions(selectSocket: SocketSelector, file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    await nvim.lua(lua.syncBuffer, [file, true]);
    return await nvim.lua(lua.completions, [file, line, col]);
  } finally {
    disconnect(socket);
  }
}
