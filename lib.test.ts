import { describe, expect, test } from "bun:test";
import { findInstanceByCwd, parsePidFromSocket, type NvimInstance } from "./lib";

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
