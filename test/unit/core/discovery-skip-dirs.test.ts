import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "os";
import { join } from "path";
import { discoverFiles } from "../../../src/core/discovery.js";

/**
 * Issue #116: SKIP_DIRS matched a directory by NAME at any depth, so a folder
 * of git-tracked hand-written source that happens to be called build/ (the
 * date-fns case: pkgs/core/scripts/build/) was never scanned, and everything
 * it imported looked dead. A build-named directory should be skipped only
 * when it is actually output: gitignored or untracked. Tracked source scans.
 */
describe("discovery: a build-named directory of tracked source must scan (#116)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vd-skipdirs-"));
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const put = async (rel: string, content = "export const x = 1;\n") => {
    await mkdir(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...rel.split("/")), content);
  };
  const gitAdd = () => execFileSync("git", ["add", "-A"], { cwd: dir });

  it("scans tracked source inside a build-named directory", async () => {
    await put("scripts/build/indices.ts");
    await put("src/app.ts");
    await gitAdd();

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain("src/app.ts");
    expect(names).toContain("scripts/build/indices.ts");
  });

  it("still skips an untracked build-named directory (real output)", async () => {
    await put("src/app.ts");
    await gitAdd();
    // written after git add, so it is untracked output
    await put("build/bundle-out.ts");

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain("src/app.ts");
    expect(names).not.toContain("build/bundle-out.ts");
  });

  it("still skips a gitignored build-named directory", async () => {
    await put(".gitignore", "dist/\n");
    await put("src/app.ts");
    await gitAdd();
    await put("dist/generated.ts");

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain("src/app.ts");
    expect(names).not.toContain("dist/generated.ts");
  });

  it("pins the chosen semantics: a force-added file under an ignored build/ still skips", async () => {
    // git would show a tracked file under an ignored path; we honor the
    // declared exclusion instead (ig wins over tracked). Pinned so a future
    // change flips it deliberately, not silently.
    await put(".gitignore", "build/\n");
    await put("src/app.ts");
    await put("build/forced.ts");
    execFileSync("git", ["add", "-A", "-f"], { cwd: dir });

    const { files } = await discoverFiles(dir);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain("src/app.ts");
    expect(names).not.toContain("build/forced.ts");
  });

  it("keeps the name-based skip outside git repos", async () => {
    const plain = await mkdtemp(join(tmpdir(), "vd-skipdirs-nogit-"));
    try {
      await mkdir(join(plain, "build"), { recursive: true });
      await writeFile(join(plain, "build", "x.ts"), "export const x = 1;\n");
      await writeFile(join(plain, "app.ts"), "export const a = 1;\n");
      const { files } = await discoverFiles(plain);
      const names = files.map((f) => f.relativePath);
      expect(names).toContain("app.ts");
      expect(names).not.toContain("build/x.ts");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
