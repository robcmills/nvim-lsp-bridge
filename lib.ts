import { attach, type NeovimClient } from "neovim";
import { createConnection, type Socket } from "net";
import { readdirSync, readlinkSync } from "fs";
import { basename, join } from "path";
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

export type NvimInstanceState = "responsive" | "wedged" | "unknown";

export interface NvimInstance {
  socketPath: string;
  cwd: string;
  pid?: number;
  state?: NvimInstanceState;
}

export type SocketSelector = () => Promise<string>;

export function parsePidFromSocket(socketPath: string): number | null {
  const m = basename(socketPath).match(/^nvim\.(\d+)\.\d+$/);
  if (!m) return null;
  const pid = parseInt(m[1]!, 10);
  return Number.isFinite(pid) ? pid : null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getCwdFromPid(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawnSync({
        cmd: ["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"],
        stdout: "pipe",
        stderr: "ignore",
      });
      if (proc.exitCode !== 0) return null;
      for (const line of proc.stdout.toString().split("\n")) {
        if (line.startsWith("n")) return line.slice(1);
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

// Derive cwd from kernel state via the PID embedded in the socket name. Works
// even when the nvim event loop is wedged on a modal prompt. Returns null when
// the socket name isn't the standard `nvim.<PID>.0` format, the PID is gone
// (stale socket), or the cwd lookup fails — callers should fall back to RPC.
export function getNvimInfoFromPid(socketPath: string): NvimInstance | null {
  const pid = parsePidFromSocket(socketPath);
  if (pid === null) return null;
  if (!isProcessAlive(pid)) return null;
  const cwd = getCwdFromPid(pid);
  if (cwd === null) return null;
  return { socketPath, cwd, pid, state: "unknown" };
}

// Neovim writes its RPC socket under `$TMPDIR/nvim.<user>/`. We can't just trust
// our own `os.tmpdir()`: the Claude Code harness overrides `TMPDIR` (e.g. to
// `/tmp/claude-501`), but nvim instances launched from a normal terminal/GUI use
// the real per-user temp dir. So we scan every plausible temp root and dedupe.
export function getTempRoots(): string[] {
  const roots = new Set<string>();
  roots.add(tmpdir());
  if (process.env.TMPDIR) roots.add(process.env.TMPDIR);

  // The canonical macOS per-user temp dir, unaffected by a `$TMPDIR` override.
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawnSync({
        cmd: ["getconf", "DARWIN_USER_TEMP_DIR"],
        stdout: "pipe",
        stderr: "ignore",
      });
      if (proc.exitCode === 0) {
        const dir = proc.stdout.toString().trim();
        if (dir) roots.add(dir);
      }
    } catch {}
  }

  // Linux default and a common fallback.
  roots.add("/tmp");

  return [...roots];
}

export function findAllNeovimSockets(): string[] {
  const user = process.env.USER || "unknown";
  const sockets = new Set<string>();

  for (const root of getTempRoots()) {
    const nvimDir = join(root, `nvim.${user}`);
    try {
      const subdirs = readdirSync(nvimDir);
      for (const sub of subdirs) {
        const subPath = join(nvimDir, sub);
        try {
          const files = readdirSync(subPath);
          for (const f of files) {
            if (f.startsWith("nvim.") && f.endsWith(".0")) {
              sockets.add(join(subPath, f));
            }
          }
        } catch {}
      }
    } catch {}
  }

  return [...sockets];
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
    return { socketPath, cwd: String(cwd), state: "responsive" };
  } catch {
    socket?.destroy();
    return null;
  }
}

// Lightweight liveness probe. Resolves true if nvim's event loop round-trips
// a trivial Lua call within `timeoutMs`, false otherwise. Use this to confirm
// an instance is usable before committing to it for an actual query.
export async function pingNvim(socketPath: string, timeoutMs = 500): Promise<boolean> {
  let socket: Socket | null = null;
  try {
    socket = createConnection(socketPath);
    const conn = socket;
    await new Promise<void>((resolve, reject) => {
      conn.once("connect", resolve);
      conn.once("error", reject);
    });
    const nvim = attach({ reader: socket, writer: socket });
    await Promise.race([
      nvim.lua("return 1", []),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("ping timed out")), timeoutMs)
      ),
    ]);
    socket.destroy();
    return true;
  } catch {
    socket?.destroy();
    return false;
  }
}

// Resolve every discoverable nvim socket to an NvimInstance. Tries PID-derived
// discovery first (instant, works on wedged instances); falls back to an RPC
// call for sockets whose names don't match the standard `nvim.<PID>.0` format.
export async function discoverInstances(): Promise<NvimInstance[]> {
  const sockets = findAllNeovimSockets();
  const results: NvimInstance[] = [];

  await Promise.all(
    sockets.map(async (s) => {
      const fromPid = getNvimInfoFromPid(s);
      if (fromPid !== null) {
        results.push(fromPid);
        return;
      }
      const fromRpc = await getNvimInfo(s);
      if (fromRpc !== null) {
        results.push(fromRpc);
      }
    }),
  );

  return results;
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

function describeUnresponsive(inst: NvimInstance): string {
  const pidStr = inst.pid ? ` (PID ${inst.pid})` : "";
  return (
    `Matched Neovim at ${inst.cwd}${pidStr} but it is unresponsive — ` +
    "check for a modal prompt (E325 swap-file, hit-enter, etc.)."
  );
}

export function createAutoSocketSelector(): SocketSelector {
  return async () => {
    if (process.env.NVIM_LISTEN_ADDRESS) {
      return process.env.NVIM_LISTEN_ADDRESS;
    }

    if (findAllNeovimSockets().length === 0) {
      throw new Error(
        "No Neovim instances found. Start Neovim or set NVIM_LISTEN_ADDRESS."
      );
    }

    const instances = await discoverInstances();

    if (instances.length === 0) {
      throw new Error(
        "Found Neovim sockets but their processes are gone (stale sockets)."
      );
    }

    let chosen: NvimInstance;
    if (instances.length === 1) {
      chosen = instances[0]!;
    } else {
      const match = findInstanceByCwd(instances);
      if (!match) {
        throw new Error(
          `Multiple Neovim instances found (${instances.length}). ` +
          "Set NVIM_LISTEN_ADDRESS or run from a directory matching a Neovim instance."
        );
      }
      chosen = match;
    }

    if (chosen.state !== "responsive" && !(await pingNvim(chosen.socketPath))) {
      throw new Error(describeUnresponsive(chosen));
    }

    return chosen.socketPath;
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
