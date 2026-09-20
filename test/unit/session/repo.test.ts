import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepoRoot, repoIdentity, repoOwningFile, repoKey, defaultSessionsDir } from "@/session/repo";
import { projectHash } from "@/core/baseline";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

describe("resolveRepoRoot", () => {
  it("walks up to the nearest .git ancestor", () => {
    const a = tmp("vd-repo-");
    mkdirSync(join(a, ".git"));
    mkdirSync(join(a, "b", "c"), { recursive: true });
    expect(resolveRepoRoot(join(a, "b", "c"))).toBe(a);
  });

  it("prefers the nearest .git when nested", () => {
    const a = tmp("vd-nested-");
    mkdirSync(join(a, ".git"));
    mkdirSync(join(a, "sub", ".git"), { recursive: true });
    mkdirSync(join(a, "sub", "deep"), { recursive: true });
    expect(resolveRepoRoot(join(a, "sub", "deep"))).toBe(join(a, "sub"));
  });

  it("falls back to the input dir when no .git exists", () => {
    const d = tmp("vd-norepo-");
    expect(resolveRepoRoot(d)).toBe(d);
  });
});

describe("repoOwningFile", () => {
  it("answers the repo the FILE lives in, not the one the agent started in", () => {
    const a = tmp("vd-own-");
    mkdirSync(join(a, ".git"));
    mkdirSync(join(a, "src"), { recursive: true });
    const owner = repoOwningFile(join(a, "src", "x.ts"));
    expect(owner).toEqual({ rootDir: a, projectHash: projectHash(a) });
  });

  it("prefers a NESTED repo over the workspace above it", () => {
    const ws = tmp("vd-own-ws-");
    mkdirSync(join(ws, ".git"));
    mkdirSync(join(ws, "sub", ".git"), { recursive: true });
    mkdirSync(join(ws, "sub", "src"), { recursive: true });
    expect(repoOwningFile(join(ws, "sub", "src", "x.ts"))?.rootDir).toBe(join(ws, "sub"));
  });

  it("answers null for a file that belongs to no repo (it stays with the workspace)", () => {
    const d = tmp("vd-own-none-");
    expect(repoOwningFile(join(d, "notes.ts"))).toBeNull();
  });

  it("resolves a real git worktree, whose .git is a FILE", () => {
    const main = tmp("vd-own-wt-");
    execFileSync("git", ["init", "-q"], { cwd: main });
    execFileSync("git", ["config", "user.email", "t@e.st"], { cwd: main });
    execFileSync("git", ["config", "user.name", "t"], { cwd: main });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "root"], { cwd: main });
    const wt = join(tmp("vd-own-wt-out-"), "linked");
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: main });
    mkdirSync(join(wt, "src"), { recursive: true });
    expect(repoOwningFile(join(wt, "src", "x.ts"))?.rootDir).toBe(realpathSync(wt));
  });
});

describe("repoIdentity", () => {
  it("hash matches core projectHash of the resolved root", () => {
    const d = tmp("vd-id-");
    const id = repoIdentity(d);
    expect(id.rootDir).toBe(d);
    expect(id.projectHash).toBe(projectHash(d));
  });
});

describe("repoKey", () => {
  it("is the root commit for a git repo, so it survives a move on disk", () => {
    const a = tmp("vd-key-");
    execFileSync("git", ["init", "-q"], { cwd: a, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c", "user.email=test@example.com",
        "-c", "user.name=Test",
        "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null",
        "commit", "-q", "--allow-empty", "-m", "init",
      ],
      { cwd: a, stdio: "ignore" },
    );
    const before = repoKey(a);
    expect(before).toMatch(/^git:[0-9a-f]{40,64}$/);
    const moved = join(a, "..", `vd-key-moved-${Date.now()}`);
    renameSync(a, moved);
    expect(repoKey(moved)).toBe(before);
    expect(repoIdentity(moved).projectHash).not.toBe(repoIdentity(a).projectHash);
    rmSync(moved, { recursive: true, force: true });
  });

  it("falls back to the canonical path when git cannot answer", () => {
    const d = tmp("vd-nogit-");
    expect(repoKey(d)).toBe(`path:${d}`);
  });
});

describe("defaultSessionsDir", () => {
  it("lives under ~/.vibedrift/sessions", () => {
    expect(defaultSessionsDir().endsWith(join(".vibedrift", "sessions"))).toBe(true);
  });
});
