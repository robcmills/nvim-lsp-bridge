import { describe, expect, test } from "bun:test";
import { findInstanceByCwd, lua, parsePidFromSocket, type NvimInstance } from "./lib";

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
