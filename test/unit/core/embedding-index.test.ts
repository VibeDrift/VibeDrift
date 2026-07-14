import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cosineSimilarity,
  findSimilarByEmbedding,
  isIndexStale,
  contentHash,
  writeEmbeddingIndex,
  loadEmbeddingIndex,
  type EmbeddingIndex,
} from "../../../src/core/embedding-index.js";

function idx(rootDir: string): EmbeddingIndex {
  return {
    version: 2,
    rootDir,
    baselineKey: "bk-1",
    dim: 3,
    builtAt: 0,
    entries: [
      { id: "a.ts::formatMoney", relativePath: "a.ts", name: "formatMoney", line: 1, contentHash: "h1", body: "function formatMoney(n){ return '$'+n; }", vector: [1, 0, 0] },
      { id: "b.ts::addNumbers", relativePath: "b.ts", name: "addNumbers", line: 1, contentHash: "h2", body: "function addNumbers(a,b){ return a+b; }", vector: [0, 1, 0] },
      { id: "c.ts::nearTwin", relativePath: "c.ts", name: "nearTwin", line: 1, contentHash: "h3", body: "function nearTwin(n){ return `$${n}`; }", vector: [0.9, 0.1, 0] },
    ],
  };
}

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal, and length-guarded", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0); // mismatched length
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0); // zero vector
  });
});

describe("findSimilarByEmbedding", () => {
  it("returns matches above threshold, sorted desc, capped, self-excluded", () => {
    const m = findSimilarByEmbedding([1, 0, 0], idx("/r"), { threshold: 0.8, cap: 10 });
    // formatMoney (cos 1.0) and nearTwin (cos ~0.994) clear 0.8; addNumbers (0) doesn't
    expect(m.map((x) => x.name)).toEqual(["formatMoney", "nearTwin"]);
    expect(m[0].similarity).toBeGreaterThanOrEqual(m[1].similarity);
  });

  it("excludeFile drops the file being edited", () => {
    const m = findSimilarByEmbedding([1, 0, 0], idx("/r"), { threshold: 0.8, cap: 10, excludeFile: "a.ts" });
    expect(m.find((x) => x.relativePath === "a.ts")).toBeUndefined();
    expect(m.some((x) => x.name === "nearTwin")).toBe(true);
  });

  it("respects the cap", () => {
    const m = findSimilarByEmbedding([1, 0, 0], idx("/r"), { threshold: 0, cap: 1 });
    expect(m).toHaveLength(1);
  });

  it("carries the stored body on each match (so borderline matches can be LLM-validated)", () => {
    const m = findSimilarByEmbedding([1, 0, 0], idx("/r"), { threshold: 0.8, cap: 10 });
    expect(m[0].body).toContain("formatMoney");
  });
});

describe("isIndexStale", () => {
  it("is stale when absent, key-mismatched, or empty", () => {
    expect(isIndexStale(null, "bk-1")).toBe(true);
    expect(isIndexStale(idx("/r"), "bk-2")).toBe(true);
    expect(isIndexStale({ ...idx("/r"), entries: [] }, "bk-1")).toBe(true);
    expect(isIndexStale(idx("/r"), "bk-1")).toBe(false);
  });
});

describe("write/load round-trip", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  beforeAll(() => {
    // Redirect homedir() to a temp dir so the test never touches the real ~/.vibedrift
    home = mkdtempSync(join(tmpdir(), "vd-eidx-"));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterAll(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  });

  it("persists and reloads an index by rootDir", async () => {
    const index = idx("/some/repo");
    await writeEmbeddingIndex(index);
    const loaded = await loadEmbeddingIndex("/some/repo");
    expect(loaded?.entries).toHaveLength(3);
    expect(loaded?.baselineKey).toBe("bk-1");
    expect(await loadEmbeddingIndex("/other/repo")).toBeNull();
  });

  it("contentHash is stable and 16 hex chars", () => {
    const h = contentHash("function f(){ return 1; }");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash("function f(){ return 1; }")).toBe(h);
  });
});
