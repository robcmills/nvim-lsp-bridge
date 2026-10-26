import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import {
  checkTypescriptRuntime,
  evaluateFreshness,
  findInstanceByCwd,
  findTsserverPaths,
  findWorkspaceTypescript,
  formatInstancesPlain,
  getTempRoots,
  isOutsideWorkspace,
  isRequiredClient,
  lua,
  parsePidFromSocket,
  parseProcessTable,
  resolveInteractive,
  type ClientStatus,
  type NvimInstance,
} from "./lib";

const inst = (cwd: string): NvimInstance => ({ socketPath: `/tmp/sock-${cwd}`, cwd });

describe("isOutsideWorkspace", () => {
  test("allows files inside the Neovim cwd", () => {
    expect(isOutsideWorkspace("/nope/proj/src/a.ts", "/nope/proj")).toBe(false);
  });

  test("rejects files in another project", () => {
    expect(isOutsideWorkspace("/nope/other/src/a.ts", "/nope/proj")).toBe(true);
  });

  test("rejects sibling dirs sharing a name prefix", () => {
    expect(isOutsideWorkspace("/nope/proj-2/a.ts", "/nope/proj")).toBe(true);
  });
});

describe("parsePidFromSocket", () => {
  test("parses standard nvim socket name", () => {
    expect(parsePidFromSocket("/tmp/nvim.rob/abc/nvim.12345.0")).toBe(12345);
  });

  test("parses higher listener indices", () => {
    expect(parsePidFromSocket("/tmp/nvim.rob/abc/nvim.999.7")).toBe(999);
  });

  test("returns null for non-standard names", () => {
    expect(parsePidFromSocket("/tmp/foo.sock")).toBe(null);
    expect(parsePidFromSocket("/tmp/nvim.sock")).toBe(null);
    expect(parsePidFromSocket("/tmp/nvim.abc.0")).toBe(null);
  });
});

describe("sync_buffer.lua swap-lock safety", () => {
  // The bridge connects to a Neovim instance and may load a file that another
  // nvim instance has open. Without these safeguards, the global swap-file lock
  // triggers an E325 modal prompt that wedges the target instance's event loop.
  // A real reproduction needs two nvim processes; these static checks at least
  // catch accidental removal of either safety net.

  test("disables 'swapfile' on bridge-created buffers before the first disk read", () => {
    const script = lua.syncBuffer;
    const swapOffIdx = script.indexOf("'swapfile', false");
    const bufloadIdx = script.indexOf("vim.fn.bufload");
    expect(swapOffIdx).toBeGreaterThan(-1);
    expect(bufloadIdx).toBeGreaterThan(-1);
    expect(swapOffIdx).toBeLessThan(bufloadIdx);
  });

  test("auto-answers 'e' to SwapExists around the :edit! reload", () => {
    const script = lua.syncBuffer;
    expect(script).toContain("SwapExists");
    expect(script).toContain("vim.v.swapchoice = 'e'");
  });
});

describe("diagnostics.lua file filtering", () => {
  test("accepts a list of file filters", () => {
    expect(lua.diagnostics).toContain('type(filter_files) == "string"');
    expect(lua.diagnostics).toContain("ipairs(filter_files)");
    expect(lua.diagnostics).toContain("matches_filter(fname)");
  });
});

describe("getTempRoots", () => {
  // The Claude Code harness overrides $TMPDIR (e.g. to /tmp/claude-501), but nvim
  // instances launched from a normal terminal/GUI use the real per-user temp dir.
  // getTempRoots must scan both so the bridge can still find those sockets.

  test("includes os.tmpdir()", () => {
    expect(getTempRoots()).toContain(tmpdir());
  });

  test("includes /tmp as a fallback", () => {
    expect(getTempRoots()).toContain("/tmp");
  });

  test("returns no duplicate roots", () => {
    const roots = getTempRoots();
    expect(roots.length).toBe(new Set(roots).size);
  });

  test("on macOS, recovers the real per-user temp dir even when $TMPDIR is overridden", () => {
    if (process.platform !== "darwin") return;
    const original = process.env.TMPDIR;
    try {
      process.env.TMPDIR = "/tmp/claude-test-override";
      expect(getTempRoots().some((r) => r.startsWith("/var/folders/"))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
  });
});

describe("findInstanceByCwd", () => {
  test("returns exact CWD match", () => {
    const a = inst("/Users/me/src/repo");
    const b = inst("/Users/me/src/other");
    expect(findInstanceByCwd([a, b], "/Users/me/src/repo")).toBe(a);
  });

  test("returns the deepest prefix match when no exact match", () => {
    const parent = inst("/Users/me/src");
    const sub = inst("/Users/me/src/repo");
    expect(
      findInstanceByCwd([parent, sub], "/Users/me/src/repo/sub/dir"),
    ).toBe(sub);
  });

  test("returns null when no instance's cwd is an ancestor of the shell cwd", () => {
    const sibling = inst("/Users/me/src/openspace-pnpm/web/icedemon");
    const unrelated = inst("/Users/me/src/other-repo");
    expect(
      findInstanceByCwd([sibling, unrelated], "/Users/me/src/openspace/web/icedemon"),
    ).toBe(null);
  });
});

const client = (name: string, over: Partial<ClientStatus> = {}): ClientStatus => ({
  id: name.length,
  name,
  root_dir: "/repo",
  pull: false,
  reported_at: null,
  error: null,
  ...over,
});

describe("resolveInteractive", () => {
  test("prompts only with a TTY on stdin and no opt-out", () => {
    expect(resolveInteractive(["diagnostics", "a.ts"], {}, true)).toEqual({
      interactive: true,
      args: ["diagnostics", "a.ts"],
    });
  });

  test("never prompts without a TTY on stdin", () => {
    expect(resolveInteractive(["diagnostics"], {}, false).interactive).toBe(false);
  });

  test("--non-interactive opts out anywhere in argv and is stripped from args", () => {
    expect(resolveInteractive(["diagnostics", "--non-interactive", "a.ts"], {}, true)).toEqual({
      interactive: false,
      args: ["diagnostics", "a.ts"],
    });
  });

  test("NVIM_LSP_NON_INTERACTIVE opts out", () => {
    expect(resolveInteractive(["list"], { NVIM_LSP_NON_INTERACTIVE: "1" }, true).interactive).toBe(false);
  });
});

describe("formatInstancesPlain", () => {
  test("lists cwd, PID, wedged state and socket without ANSI codes", () => {
    const out = formatInstancesPlain(
      [{ ...inst("/a"), pid: 12 }, inst("/b")],
      ["wedged", "responsive"],
    );
    expect(out).toBe("  /a (PID 12) [wedged]\n    /tmp/sock-/a\n  /b\n    /tmp/sock-/b");
  });
});

describe("isRequiredClient", () => {
  test("requires tsserver-based clients and pull-diagnostic clients", () => {
    expect(isRequiredClient(client("ts_ls"))).toBe(true);
    expect(isRequiredClient(client("vtsls"))).toBe(true);
    expect(isRequiredClient(client("eslint", { pull: true }))).toBe(true);
  });

  test("does not require push clients that may stay silent on a clean file", () => {
    expect(isRequiredClient(client("tailwindcss"))).toBe(false);
    expect(isRequiredClient(client("eslint"))).toBe(false);
  });
});

describe("evaluateFreshness", () => {
  const file = "/repo/src/a.ts";

  test("waits while ts_ls has not reported since the sync (a timeout is unknown, not clean)", () => {
    const result = evaluateFreshness(file, [client("ts_ls", { reported_at: 50 })], 100, 5000);
    expect(result).toEqual({ state: "waiting", missing: ["ts_ls"] });
  });

  test("an empty report counts: ready once every required client reported and things went quiet", () => {
    const clients = [client("ts_ls", { reported_at: 200 }), client("eslint", { pull: true, reported_at: 300 })];
    expect(evaluateFreshness(file, clients, 100, 900).state).toBe("ready");
  });

  test("waits for a pull client such as eslint", () => {
    const clients = [client("ts_ls", { reported_at: 200 }), client("eslint", { pull: true })];
    expect(evaluateFreshness(file, clients, 100, 900)).toEqual({ state: "waiting", missing: ["eslint"] });
  });

  test("does not wait on push clients that may never report", () => {
    const clients = [client("ts_ls", { reported_at: 200 }), client("tailwindcss")];
    expect(evaluateFreshness(file, clients, 100, 900).state).toBe("ready");
  });

  test("waits out the quiet period after the last report", () => {
    const clients = [client("ts_ls", { reported_at: 200 }), client("tailwindcss", { reported_at: 700 })];
    expect(evaluateFreshness(file, clients, 100, 900)).toEqual({ state: "waiting", missing: [] });
  });

  test("a TypeScript file with no TypeScript server attached is not clean", () => {
    const clients = [client("eslint", { pull: true, reported_at: 200 })];
    const result = evaluateFreshness(file, clients, 100, 900);
    expect(result.state).toBe("waiting");
    expect(result.state === "waiting" && result.missing[0]).toContain("TypeScript server");
  });

  test("without a resync (since 0) any earlier report is current", () => {
    expect(evaluateFreshness(file, [client("ts_ls", { reported_at: 5 })], 0, 10).state).toBe("ready");
  });

  test("other filetypes need at least one report from some client after a resync", () => {
    const md = "/repo/README.md";
    expect(evaluateFreshness(md, [client("marksman")], 100, 900)).toEqual({ state: "waiting", missing: ["marksman"] });
    expect(evaluateFreshness(md, [], 100, 900).state).toBe("waiting");
    expect(evaluateFreshness(md, [client("marksman", { reported_at: 200 })], 100, 900).state).toBe("ready");
  });

  test("a failed pull request is an error, not a clean result", () => {
    const clients = [client("ts_ls", { reported_at: 200 }), client("eslint", { pull: true, reported_at: 200, error: "boom" })];
    expect(evaluateFreshness(file, clients, 100, 900)).toEqual({
      state: "error",
      message: `eslint failed to report diagnostics for ${file}: boom`,
    });
  });
});

const PS = `
  100     1 nvim --embed
  200   100 node /Users/me/.yarn/bin/typescript-language-server --stdio
  201   200 /bin/node /Users/me/.config/yarn/global/node_modules/typescript/lib/tsserver.js --serverMode partialSemantic
  202   200 /bin/node /Users/me/.config/yarn/global/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot
  300     1 nvim --embed
  301   300 node /Users/me/.yarn/bin/typescript-language-server --stdio
  302   301 /bin/node /repo/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot
`;

describe("parseProcessTable / findTsserverPaths", () => {
  test("parses pid, ppid and command", () => {
    const procs = parseProcessTable(PS);
    expect(procs).toHaveLength(7);
    expect(procs[1]).toEqual({ pid: 200, ppid: 100, command: "node /Users/me/.yarn/bin/typescript-language-server --stdio" });
  });

  test("finds tsserver.js paths only under the given Neovim", () => {
    const procs = parseProcessTable(PS);
    expect(findTsserverPaths(procs, 100)).toEqual(["/Users/me/.config/yarn/global/node_modules/typescript/lib/tsserver.js"]);
    expect(findTsserverPaths(procs, 300)).toEqual(["/repo/node_modules/typescript/lib/tsserver.js"]);
    expect(findTsserverPaths(procs, 999)).toEqual([]);
  });
});

describe("findWorkspaceTypescript", () => {
  test("finds node_modules/typescript in the root", () => {
    const exists = (p: string) => p === "/repo/web/node_modules/typescript/package.json";
    expect(findWorkspaceTypescript("/repo/web", exists)).toBe("/repo/web/node_modules/typescript");
  });

  test("finds a copy hoisted to a parent", () => {
    const exists = (p: string) => p === "/repo/node_modules/typescript/package.json";
    expect(findWorkspaceTypescript("/repo/web", exists)).toBe("/repo/node_modules/typescript");
  });

  test("returns null when no ancestor has it", () => {
    expect(findWorkspaceTypescript("/repo/web", () => false)).toBe(null);
  });
});

describe("checkTypescriptRuntime", () => {
  const installed = (p: string) => p === "/repo/node_modules/typescript/package.json";
  const identity = (p: string) => p;

  test("errors with pnpm install advice when the workspace has no typescript", () => {
    const message = checkTypescriptRuntime("ts_ls", "/repo", [], { exists: () => false, realpath: identity });
    expect(message).toContain("no node_modules/typescript");
    expect(message).toContain("Run `pnpm install` in /repo");
  });

  test("errors when tsserver comes from a global install", () => {
    const message = checkTypescriptRuntime(
      "ts_ls",
      "/repo",
      ["/Users/me/.config/yarn/global/node_modules/typescript/lib/tsserver.js"],
      { exists: installed, realpath: identity },
    );
    expect(message).toContain("is not using the workspace's TypeScript (/repo/node_modules/typescript)");
    expect(message).toContain("Run `pnpm install` in /repo");
  });

  test("passes when tsserver runs the workspace's typescript, through pnpm symlinks", () => {
    const realpath = (p: string) => p.replace("/repo/node_modules/typescript", "/repo/node_modules/.pnpm/typescript@6.0.3/node_modules/typescript");
    expect(
      checkTypescriptRuntime("ts_ls", "/repo", ["/repo/node_modules/typescript/lib/tsserver.js"], { exists: installed, realpath }),
    ).toBe(null);
  });

  test("passes if any tsserver under this Neovim is the workspace's", () => {
    expect(
      checkTypescriptRuntime(
        "ts_ls",
        "/repo",
        ["/other/node_modules/typescript/lib/tsserver.js", "/repo/node_modules/typescript/lib/tsserver.js"],
        { exists: installed, realpath: identity },
      ),
    ).toBe(null);
  });

  test("falls back to the node_modules check when no tsserver process is visible", () => {
    expect(checkTypescriptRuntime("ts_ls", "/repo", [], { exists: installed, realpath: identity })).toBe(null);
  });
});

describe("diagnostic report tracking", () => {
  test("track_diagnostics.lua wraps both push and pull diagnostic handlers per client", () => {
    expect(lua.trackDiagnostics).toContain("'textDocument/publishDiagnostics'");
    expect(lua.trackDiagnostics).toContain("'textDocument/diagnostic'");
    expect(lua.trackDiagnostics).toContain("client.handlers[method] = wrapper");
  });

  test("sync_buffer.lua no longer blocks Neovim waiting for diagnostics", () => {
    expect(lua.syncBuffer).not.toContain("DiagnosticChanged");
    expect(lua.syncBuffer).toContain("since = since");
  });
});
