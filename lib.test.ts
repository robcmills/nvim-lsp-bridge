import { describe, expect, test } from "bun:test";
import { commonPathSuffixSegments, findInstanceByCwd, type NvimInstance } from "./lib";

const inst = (cwd: string): NvimInstance => ({ socketPath: `/tmp/sock-${cwd}`, cwd });

describe("commonPathSuffixSegments", () => {
  test("counts trailing path segments that match", () => {
    expect(
      commonPathSuffixSegments("/a/b/c/d/e", "/x/y/c/d/e"),
    ).toBe(3);
  });

  test("returns 0 when no suffix overlaps", () => {
    expect(commonPathSuffixSegments("/a/b/c", "/x/y/z")).toBe(0);
  });

  test("matches the user's worktree case", () => {
    const shell = "/Users/me/src/openspace/web/icedemon";
    const wtIcedemon = "/Users/me/src/openspace-pnpm/web/icedemon";
    const wtTop = "/Users/me/src/openspace-pnpm";
    expect(commonPathSuffixSegments(shell, wtIcedemon)).toBe(2);
    expect(commonPathSuffixSegments(shell, wtTop)).toBe(0);
  });
});

describe("findInstanceByCwd", () => {
  const noGit = () => null;

  test("returns exact CWD match", () => {
    const a = inst("/Users/me/src/repo");
    const b = inst("/Users/me/src/other");
    expect(findInstanceByCwd([a, b], "/Users/me/src/repo", noGit)).toBe(a);
  });

  test("returns the deepest prefix match when no exact match", () => {
    const parent = inst("/Users/me/src");
    const sub = inst("/Users/me/src/repo");
    expect(
      findInstanceByCwd([parent, sub], "/Users/me/src/repo/sub/dir", noGit),
    ).toBe(sub);
  });

  test("falls back to worktree match when no path match", () => {
    const shell = "/Users/me/src/openspace/web/icedemon";
    const sibling = inst("/Users/me/src/openspace-pnpm/web/icedemon");
    const unrelated = inst("/Users/me/src/other-repo");
    const gitDir: Record<string, string> = {
      [shell]: "/Users/me/src/openspace/.git",
      [sibling.cwd]: "/Users/me/src/openspace/.git",
      [unrelated.cwd]: "/Users/me/src/other-repo/.git",
    };
    expect(
      findInstanceByCwd([sibling, unrelated], shell, (d) => gitDir[d] ?? null),
    ).toBe(sibling);
  });

  test("disambiguates multiple worktrees by longest common suffix", () => {
    const shell = "/Users/me/src/openspace/web/icedemon";
    const deep = inst("/Users/me/src/openspace-pnpm/web/icedemon");
    const shallow = inst("/Users/me/src/openspace-pnpm");
    const gitDir: Record<string, string> = {
      [shell]: "/Users/me/src/openspace/.git",
      [deep.cwd]: "/Users/me/src/openspace/.git",
      [shallow.cwd]: "/Users/me/src/openspace/.git",
    };
    expect(
      findInstanceByCwd([shallow, deep], shell, (d) => gitDir[d] ?? null),
    ).toBe(deep);
  });

  test("breaks worktree-suffix ties by cwd alphabetical order", () => {
    const shell = "/Users/me/src/openspace/web/icedemon";
    const wtB = inst("/Users/me/src/openspace-b/web/icedemon");
    const wtA = inst("/Users/me/src/openspace-a/web/icedemon");
    const gitDir: Record<string, string> = {
      [shell]: "/Users/me/src/openspace/.git",
      [wtA.cwd]: "/Users/me/src/openspace/.git",
      [wtB.cwd]: "/Users/me/src/openspace/.git",
    };
    expect(findInstanceByCwd([wtB, wtA], shell, (d) => gitDir[d] ?? null)).toBe(wtA);
  });

  test("returns null when shell cwd is not in a git repo", () => {
    const shell = "/tmp/some/random/dir";
    const wt = inst("/Users/me/src/openspace-pnpm/web/icedemon");
    expect(findInstanceByCwd([wt], shell, noGit)).toBe(null);
  });

  test("returns null when no instance shares the repo", () => {
    const shell = "/Users/me/src/openspace/web/icedemon";
    const wt = inst("/Users/me/src/other-repo");
    const gitDir: Record<string, string> = {
      [shell]: "/Users/me/src/openspace/.git",
      [wt.cwd]: "/Users/me/src/other-repo/.git",
    };
    expect(findInstanceByCwd([wt], shell, (d) => gitDir[d] ?? null)).toBe(null);
  });
});
