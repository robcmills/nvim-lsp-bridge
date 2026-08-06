import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { findInstanceByCwd, getTempRoots, lua, parsePidFromSocket, type NvimInstance } from "./lib";

const inst = (cwd: string): NvimInstance => ({ socketPath: `/tmp/sock-${cwd}`, cwd });

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
