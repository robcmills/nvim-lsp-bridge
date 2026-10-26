import { attach, type NeovimClient } from "neovim";
import { createConnection, type Socket } from "net";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "fs";
import { basename, dirname, extname, join, sep } from "path";
import { tmpdir } from "os";

const luaDir = join(import.meta.dir, "lua");

function readLua(name: string): Promise<string> {
  return Bun.file(join(luaDir, `${name}.lua`)).text();
}

// Cache lua scripts at startup
export const lua = {
  syncBuffer: await readLua("sync_buffer"),
  trackDiagnostics: await readLua("track_diagnostics"),
  diagnosticsStatus: await readLua("diagnostics_status"),
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

export const NON_INTERACTIVE_FLAG = "--non-interactive";

// Prompt only with a terminal on stdin and no opt-out (the flag or
// NVIM_LSP_NON_INTERACTIVE). Agents have no stdin, so a prompt would hang them.
export function resolveInteractive(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  stdinIsTTY: boolean = Boolean(process.stdin.isTTY),
): { interactive: boolean; args: string[] } {
  const args = argv.filter((a) => a !== NON_INTERACTIVE_FLAG);
  const optedOut = args.length !== argv.length || Boolean(env.NVIM_LSP_NON_INTERACTIVE);
  return { interactive: stdinIsTTY && !optedOut, args };
}

// Plain-text instance list for errors read by agents (no ANSI colors).
export function formatInstancesPlain(
  instances: NvimInstance[],
  states: ("responsive" | "wedged")[],
): string {
  return instances
    .map((inst, i) => {
      const pidStr = inst.pid ? ` (PID ${inst.pid})` : "";
      const badge = states[i] === "wedged" ? " [wedged]" : "";
      return `  ${inst.cwd}${pidStr}${badge}\n    ${inst.socketPath}`;
    })
    .join("\n");
}

export async function probeStates(instances: NvimInstance[]): Promise<("responsive" | "wedged")[]> {
  return Promise.all(
    instances.map(async (inst) => {
      if (inst.state === "responsive") return "responsive";
      return (await pingNvim(inst.socketPath)) ? "responsive" : "wedged";
    }),
  );
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
        const states = await probeStates(instances);
        throw new Error(
          `Multiple Neovim instances found (${instances.length}) and none is at or above ` +
          `${process.cwd()}. Rerun from inside one of these directories, or set ` +
          "NVIM_LISTEN_ADDRESS to its socket:\n" +
          formatInstancesPlain(instances, states)
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

// LSP clients that run tsserver. They publish a (possibly empty) diagnostic set
// for every file they check, so "no report yet" always means "unknown".
export const TYPESCRIPT_CLIENTS = ["ts_ls", "tsserver", "vtsls", "typescript-tools"];

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// How long `diagnostics` waits for fresh reports. A cold tsserver on a large
// project can take 30s+ to load before it publishes anything.
export const DIAGNOSTICS_TIMEOUT_MS = Number(process.env.NVIM_LSP_DIAGNOSTICS_TIMEOUT_MS) || 60_000;
// Other commands only wait as a courtesy and never fail on a timeout.
const BEST_EFFORT_TIMEOUT_MS = 10_000;
// Servers may report in several bursts; wait for this long a quiet spell.
const QUIET_MS = 500;
const POLL_MS = 100;

export interface ClientStatus {
  id: number;
  name: string;
  root_dir: string | null;
  pull: boolean;
  reported_at: number | null;
  error: string | null;
}

interface SyncResult {
  bufnr: number;
  synced?: boolean;
  since?: number;
  notified?: boolean;
  error?: string;
}

interface DiagnosticsStatus {
  now: number;
  pid: number;
  buffers: { bufnr: number; clients: ClientStatus[] }[];
}

export function isTypescriptClient(name: string): boolean {
  return TYPESCRIPT_CLIENTS.includes(name);
}

// A client whose report we must see before trusting a file's diagnostics:
// tsserver-based clients, and pull-diagnostic clients (e.g. eslint), whose
// textDocument/diagnostic responses always come back, even when empty.
export function isRequiredClient(client: Pick<ClientStatus, "name" | "pull">): boolean {
  return isTypescriptClient(client.name) || client.pull;
}

export type Freshness =
  | { state: "ready" }
  | { state: "waiting"; missing: string[] }
  | { state: "error"; message: string };

// Decide whether a buffer's diagnostics can be trusted. `since` is when the
// sync started; reports before it are stale. Pass 0 when nothing was resynced:
// any earlier report is then current.
export function evaluateFreshness(
  file: string,
  clients: ClientStatus[],
  since: number,
  now: number,
  quietMs = QUIET_MS,
): Freshness {
  const fresh = (c: ClientStatus) => c.reported_at !== null && c.reported_at >= since;

  const failed = clients.find((c) => isRequiredClient(c) && fresh(c) && c.error);
  if (failed) {
    return { state: "error", message: `${failed.name} failed to report diagnostics for ${file}: ${failed.error}` };
  }

  const required = clients.filter(isRequiredClient);
  const missing = required.filter((c) => !fresh(c)).map((c) => c.name);
  if (
    TYPESCRIPT_EXTENSIONS.has(extname(file)) &&
    !clients.some((c) => isTypescriptClient(c.name))
  ) {
    missing.push("a TypeScript server (none attached)");
  }
  // With no client known to always report, settle for any one report.
  if (required.length === 0 && missing.length === 0 && since > 0 && !clients.some(fresh)) {
    missing.push(...(clients.length ? clients.map((c) => c.name) : ["any language server (none attached)"]));
  }
  if (missing.length > 0) return { state: "waiting", missing };

  const last = Math.max(0, ...clients.filter(fresh).map((c) => c.reported_at!));
  if (since > 0 && last > 0 && now - last < quietMs) return { state: "waiting", missing: [] };
  return { state: "ready" };
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

// Parse `ps -axo pid=,ppid=,command=` output.
export function parseProcessTable(output: string): ProcessInfo[] {
  const procs: ProcessInfo[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return procs;
}

// Paths of tsserver.js run by any descendant of `rootPid` (Neovim's LSP
// servers, and the tsserver processes they spawn).
export function findTsserverPaths(procs: ProcessInfo[], rootPid: number): string[] {
  const descendants = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!descendants.has(p.pid) && descendants.has(p.ppid)) {
        descendants.add(p.pid);
        grew = true;
      }
    }
  }
  const paths = new Set<string>();
  for (const p of procs) {
    if (p.pid === rootPid || !descendants.has(p.pid)) continue;
    const m = p.command.match(/(\S*\/tsserver\.js)(\s|$)/);
    if (m) paths.add(m[1]!);
  }
  return [...paths];
}

// The `typescript` package Node would resolve from `root`: the nearest
// node_modules/typescript in root or an ancestor (pnpm workspaces may hoist).
export function findWorkspaceTypescript(
  root: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  let dir = root;
  while (true) {
    const candidate = join(dir, "node_modules", "typescript");
    if (exists(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// An error message if the TypeScript server for `root` isn't using the
// workspace's own `typescript`, else null. Without the workspace's copy (e.g. a
// worktree that was never installed), typescript-language-server falls back to
// a global tsserver that can't resolve third-party imports, so its errors are
// wrong. `tsserverPaths` are every tsserver.js under this Neovim; when empty,
// only the node_modules check applies.
export function checkTypescriptRuntime(
  clientName: string,
  root: string,
  tsserverPaths: string[],
  deps: { exists?: (path: string) => boolean; realpath?: (path: string) => string } = {},
): string | null {
  const realpath = deps.realpath ?? realpathOr;
  const workspaceTs = findWorkspaceTypescript(root, deps.exists);
  if (!workspaceTs) {
    return (
      `${clientName} for ${root} is not using the workspace's TypeScript: ` +
      `no node_modules/typescript in ${root} or its parents, so its diagnostics are unreliable. ` +
      `Run \`pnpm install\` in ${root}, then restart the server (:LspRestart).`
    );
  }
  if (tsserverPaths.length === 0) return null;
  const workspaceDir = realpath(workspaceTs) + sep;
  if (tsserverPaths.some((p) => realpath(p).startsWith(workspaceDir))) return null;
  return (
    `${clientName} for ${root} is not using the workspace's TypeScript (${workspaceTs}); ` +
    `it runs ${tsserverPaths.join(", ")}. ` +
    `Run \`pnpm install\` in ${root}, then restart the server (:LspRestart).`
  );
}

function listProcesses(): ProcessInfo[] {
  try {
    const proc = Bun.spawnSync({ cmd: ["ps", "-axo", "pid=,ppid=,command="], stdout: "pipe", stderr: "ignore" });
    return proc.exitCode === 0 ? parseProcessTable(proc.stdout.toString()) : [];
  } catch {
    return [];
  }
}

async function syncFile(nvim: NeovimClient, file: string, ensureBuffer: boolean): Promise<SyncResult> {
  await nvim.lua(lua.trackDiagnostics, []);
  return (await nvim.lua(lua.syncBuffer, [file, ensureBuffer, TYPESCRIPT_CLIENTS])) as SyncResult;
}

// Reports at or after this are fresh. Without a resync, any report is current.
function freshSince(sync: SyncResult): number {
  return sync.synced ? sync.since! : 0;
}

// Poll until every synced file has fresh diagnostics from the clients that
// matter. With `strict`, a timeout, a failed report, or a TypeScript server not
// running the workspace's TypeScript throws; otherwise they return silently.
async function waitForDiagnostics(
  nvim: NeovimClient,
  files: { file: string; sync: SyncResult }[],
  { strict, timeoutMs }: { strict: boolean; timeoutMs: number },
): Promise<void> {
  const pending = files.filter(({ sync }) => sync.bufnr > 0);
  if (pending.length === 0) return;

  const checkedRoots = new Set<string>();
  let tsserverPaths: string[] | null = null;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const status = (await nvim.lua(lua.diagnosticsStatus, [
      pending.map((f) => f.sync.bufnr),
      pending.map((f) => freshSince(f.sync)),
    ])) as DiagnosticsStatus;
    const errors: string[] = [];
    const waiting: string[] = [];

    status.buffers.forEach((buf, i) => {
      const { file, sync } = pending[i]!;
      const clients = buf.clients.map((c) => ({
        ...c,
        root_dir: c.root_dir ?? null,
        reported_at: c.reported_at ?? null,
        error: c.error ?? null,
      }));

      if (strict) {
        for (const c of clients) {
          if (!isTypescriptClient(c.name) || !c.root_dir || checkedRoots.has(c.root_dir)) continue;
          checkedRoots.add(c.root_dir);
          tsserverPaths ??= findTsserverPaths(listProcesses(), status.pid);
          const problem = checkTypescriptRuntime(c.name, c.root_dir, tsserverPaths);
          if (problem) errors.push(problem);
        }
      }

      const freshness = evaluateFreshness(file, clients, freshSince(sync), status.now);
      if (freshness.state === "error") errors.push(freshness.message);
      if (freshness.state === "waiting") {
        const from = freshness.missing.length ? freshness.missing.join(", ") : "clients still reporting";
        waiting.push(`${file} (${from})`);
      }
    });

    if (strict && errors.length > 0) throw new Error(errors.join("\n"));
    if (waiting.length === 0) return;
    if (Date.now() >= deadline) {
      if (!strict) return;
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for diagnostics from ` +
        `${waiting.join("; ")}. Results would be unknown, not clean. The server may still be ` +
        "loading the project: retry, or raise NVIM_LSP_DIAGNOSTICS_TIMEOUT_MS.",
      );
    }
    await Bun.sleep(POLL_MS);
  }
}

// Sync a file for a position query (hover etc.), waiting briefly for the LSP
// to catch up but never failing on that wait.
async function syncForQuery(nvim: NeovimClient, file: string): Promise<void> {
  const sync = await syncFile(nvim, file, true);
  await waitForDiagnostics(nvim, [{ file, sync }], { strict: false, timeoutMs: BEST_EFFORT_TIMEOUT_MS });
}

export async function syncBuffer(selectSocket: SocketSelector, file: string) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    const sync = await syncFile(nvim, file, false);
    await waitForDiagnostics(nvim, [{ file, sync }], { strict: false, timeoutMs: BEST_EFFORT_TIMEOUT_MS });
    return sync;
  } finally {
    disconnect(socket);
  }
}

// Diagnostics for `files` (or everything Neovim holds when none are given).
// Throws rather than return a result that only looks clean: when a required
// client never reports within the timeout, or the TypeScript server isn't
// running the workspace's own TypeScript.
export async function getDiagnostics(
  selectSocket: SocketSelector,
  files: string | string[] = [],
  timeoutMs = DIAGNOSTICS_TIMEOUT_MS,
) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    const requestedFiles = typeof files === "string" ? [files] : files;
    const synced: { file: string; sync: SyncResult }[] = [];
    for (const file of requestedFiles) {
      const sync = await syncFile(nvim, file, true);
      if (sync.error) throw new Error(sync.error);
      synced.push({ file, sync });
    }
    await waitForDiagnostics(nvim, synced, { strict: true, timeoutMs });
    return await nvim.lua(lua.diagnostics, requestedFiles.length ? [requestedFiles] : []);
  } finally {
    disconnect(socket);
  }
}

export async function getHover(selectSocket: SocketSelector, file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    await syncForQuery(nvim, file);
    return await nvim.lua(lua.hover, [file, line, col]);
  } finally {
    disconnect(socket);
  }
}

export async function getDefinition(selectSocket: SocketSelector, file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    await syncForQuery(nvim, file);
    return await nvim.lua(lua.definition, [file, line, col]);
  } finally {
    disconnect(socket);
  }
}

export async function getReferences(selectSocket: SocketSelector, file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    await syncForQuery(nvim, file);
    return await nvim.lua(lua.references, [file, line, col]);
  } finally {
    disconnect(socket);
  }
}

export async function getCompletions(selectSocket: SocketSelector, file: string, line: number, col: number) {
  const { nvim, socket } = await connectToNvim(selectSocket);
  try {
    await syncForQuery(nvim, file);
    return await nvim.lua(lua.completions, [file, line, col]);
  } finally {
    disconnect(socket);
  }
}
