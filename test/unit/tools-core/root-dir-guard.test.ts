import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPlausibleProjectRoot, ImplausibleRootDirError } from "@/tools-core/root-dir-guard";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

describe("assertPlausibleProjectRoot", () => {
  it("rejects a bare temp dir with no project marker anywhere up the chain", () => {
    const dir = tmp("vd-guard-bare-");
    expect(() => assertPlausibleProjectRoot(dir)).toThrow(ImplausibleRootDirError);
  });

  it("rejects a path that doesn't exist", () => {
    const dir = join(tmpdir(), "vd-guard-does-not-exist-" + Date.now());
    expect(() => assertPlausibleProjectRoot(dir)).toThrow(ImplausibleRootDirError);
  });

  it("rejects a path that is a file, not a directory", () => {
    const dir = tmp("vd-guard-file-parent-");
    const file = join(dir, "notadir.txt");
    writeFileSync(file, "hi");
    expect(() => assertPlausibleProjectRoot(file)).toThrow(ImplausibleRootDirError);
  });

  it("accepts a temp dir containing package.json", () => {
    const dir = tmp("vd-guard-pkg-");
    writeFileSync(join(dir, "package.json"), "{}");
    expect(() => assertPlausibleProjectRoot(dir)).not.toThrow();
  });

  it("accepts a temp dir containing .git", () => {
    const dir = tmp("vd-guard-git-");
    mkdirSync(join(dir, ".git"));
    expect(() => assertPlausibleProjectRoot(dir)).not.toThrow();
  });

  it("accepts a temp dir containing pyproject.toml", () => {
    const dir = tmp("vd-guard-py-");
    writeFileSync(join(dir, "pyproject.toml"), "[project]\n");
    expect(() => assertPlausibleProjectRoot(dir)).not.toThrow();
  });

  it("accepts a temp dir containing go.mod", () => {
    const dir = tmp("vd-guard-go-");
    writeFileSync(join(dir, "go.mod"), "module example.com/x\n");
    expect(() => assertPlausibleProjectRoot(dir)).not.toThrow();
  });

  it("accepts a temp dir containing Cargo.toml", () => {
    const dir = tmp("vd-guard-cargo-");
    writeFileSync(join(dir, "Cargo.toml"), "[package]\n");
    expect(() => assertPlausibleProjectRoot(dir)).not.toThrow();
  });

  it("accepts a temp dir containing a .vibedrift dir", () => {
    const dir = tmp("vd-guard-vd-");
    mkdirSync(join(dir, ".vibedrift"));
    expect(() => assertPlausibleProjectRoot(dir)).not.toThrow();
  });

  it("accepts a marker-less monorepo subdir whose ancestor has .git", () => {
    const root = tmp("vd-guard-mono-");
    mkdirSync(join(root, ".git"));
    const sub = join(root, "packages", "foo");
    mkdirSync(sub, { recursive: true });
    expect(() => assertPlausibleProjectRoot(sub)).not.toThrow();
  });
});
