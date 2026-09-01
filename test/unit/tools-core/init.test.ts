import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { run, detectExcludeCandidates } from "../../../src/tools-core/tools/init.js";

let dir: string;

async function seedRepo(root: string): Promise<void> {
  // A project marker so `assertPlausibleProjectRoot` (root-dir-guard.ts)
  // accepts this as a real repo root — a bare mkdtemp dir has none.
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test", "fixtures"), { recursive: true });
  await writeFile(join(root, "src", "index.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "util.ts"), "export const b = 2;\n");
  await writeFile(join(root, "test", "fixtures", "sample.ts"), "export const c = 3;\n");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vd-init-"));
  await seedRepo(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tools-core init", () => {
  it("detects fixture paths without writing them", async () => {
    const detected = await detectExcludeCandidates(dir);
    expect(detected.count).toBe(1);
    expect(detected.globs).toContain("**/fixtures/**");
  });

  it("writes config.json but no exclusions unless opted in", async () => {
    const res = await run({ rootDir: dir, failOnScore: 80, format: "terminal" });
    expect(res.wrote).toBe(true);
    const cfg = JSON.parse(await readFile(join(dir, ".vibedrift", "config.json"), "utf-8"));
    expect(cfg).toMatchObject({ version: 1, failOnScore: 80, format: "terminal" });
    expect(res.excludesAdded).toEqual([]);
    // .vibedriftignore must not exist when no exclusions were requested.
    await expect(readFile(join(dir, ".vibedriftignore"), "utf-8")).rejects.toBeTruthy();
    // The candidates are still reported so a caller can confirm.
    expect(res.detected.globs).toContain("**/fixtures/**");
  });

  it("detectOnly previews candidates and writes nothing", async () => {
    const res = await run({ rootDir: dir, detectOnly: true });
    expect(res.wrote).toBe(false);
    expect(res.detected.globs).toContain("**/fixtures/**");
    // Neither file should exist after a preview.
    await expect(readFile(join(dir, ".vibedrift", "config.json"), "utf-8")).rejects.toBeTruthy();
    await expect(readFile(join(dir, ".vibedriftignore"), "utf-8")).rejects.toBeTruthy();
  });

  it("writes detected exclusions when applyDetectedExcludes is true", async () => {
    const res = await run({ rootDir: dir, applyDetectedExcludes: true });
    expect(res.excludesAdded).toContain("**/fixtures/**");
    const ignore = await readFile(join(dir, ".vibedriftignore"), "utf-8");
    expect(ignore).toContain("**/fixtures/**");
  });

  it("writes explicit excludes passed by the caller", async () => {
    const res = await run({ rootDir: dir, exclude: ["dist/**"] });
    expect(res.excludesAdded).toEqual(["dist/**"]);
    const ignore = await readFile(join(dir, ".vibedriftignore"), "utf-8");
    expect(ignore).toContain("dist/**");
  });

  it("merges config across calls without clobbering prior fields", async () => {
    await run({ rootDir: dir, failOnScore: 70 });
    await run({ rootDir: dir, format: "json" });
    const cfg = JSON.parse(await readFile(join(dir, ".vibedrift", "config.json"), "utf-8"));
    expect(cfg).toMatchObject({ failOnScore: 70, format: "json" });
  });
});
