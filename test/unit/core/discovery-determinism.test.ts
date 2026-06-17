import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { discoverFiles } from "../../../src/core/discovery.js";

/**
 * Determinism: discoverFiles must return files in a stable, locale- and
 * filesystem-order-independent order. Raw readdir order varies across
 * platforms and even across clones of the same repo, which propagates into
 * Map insertion order and stable-sort tie-breaks in dominance votes and
 * report sorting — so the same commit could score/rank differently across
 * machines. We pin a deterministic code-unit sort of relativePath.
 */
describe("discovery determinism", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vd-discovery-"));
    // Create files whose names, in creation order, are NOT sorted.
    await mkdir(join(dir, "zeta"), { recursive: true });
    await mkdir(join(dir, "alpha"), { recursive: true });
    await writeFile(join(dir, "zeta", "b.ts"), "export const b = 1;\n");
    await writeFile(join(dir, "zeta", "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "alpha", "m.ts"), "export const m = 1;\n");
    await writeFile(join(dir, "c.ts"), "export const c = 1;\n");
    await writeFile(join(dir, "a.ts"), "export const a0 = 1;\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns files sorted by relativePath in code-unit order", async () => {
    const { files } = await discoverFiles(dir);
    const paths = files.map((f) => f.relativePath);
    const expected = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(paths).toEqual(expected);
  });

  it("produces identical ordering across repeated scans", async () => {
    const a = (await discoverFiles(dir)).files.map((f) => f.relativePath);
    const b = (await discoverFiles(dir)).files.map((f) => f.relativePath);
    expect(a).toEqual(b);
    // And the order is the deterministic sorted order, not just stable.
    expect(a).toEqual([...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  });
});
