import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBaseline,
  assembleBaseline,
  writeBaseline,
  loadBaseline,
  loadBaselineUnchecked,
  computeBaselineKey,
  votesFromFindings,
  securitySubVotesFromFindings,
} from "../../../src/core/baseline.js";
import { buildAnalysisContext } from "../../../src/core/discovery.js";
import { runDriftDetection } from "../../../src/drift/index.js";
import type { DriftFinding } from "../../../src/drift/types.js";

function fakeFinding(overrides: Partial<DriftFinding>): DriftFinding {
  return {
    detector: "test",
    driftCategory: "async_patterns",
    severity: "warning",
    confidence: 0.9,
    finding: "x",
    dominantPattern: "async_await",
    dominantCount: 8,
    totalRelevantFiles: 10,
    consistencyScore: 80,
    deviatingFiles: [{ path: "c.ts", detectedPattern: "then_chains", evidence: [] }],
    dominantFiles: ["a.ts", "b.ts"],
    recommendation: "use async/await",
    ...overrides,
  };
}

describe("votesFromFindings", () => {
  it("maps each driftCategory to a vote carrying the dominant tally + deviator paths", () => {
    const votes = votesFromFindings([
      fakeFinding({ driftCategory: "async_patterns" }),
      fakeFinding({
        driftCategory: "naming_conventions",
        dominantPattern: "camelCase",
        dominantCount: 12,
        totalRelevantFiles: 14,
        consistencyScore: 86,
        dominantFiles: ["x.ts"],
        deviatingFiles: [{ path: "snake.ts", detectedPattern: "snake_case", evidence: [] }],
      }),
    ]);
    expect(Object.keys(votes).sort()).toEqual(["async_patterns", "naming_conventions"]);
    const a = votes.async_patterns!;
    expect(a.dominantPattern).toBe("async_await");
    expect(a.dominantCount).toBe(8);
    expect(a.totalRelevantFiles).toBe(10);
    expect(a.consistencyScore).toBe(80);
    expect(a.dominantFiles).toEqual(["a.ts", "b.ts"]);
    expect(a.deviators).toEqual([{ path: "c.ts", detectedPattern: "then_chains" }]);
    expect(votes.naming_conventions!.dominantPattern).toBe("camelCase");
    expect(votes.naming_conventions!.deviators).toEqual([{ path: "snake.ts", detectedPattern: "snake_case" }]);
  });

  it("when a category has multiple findings, keeps the one covering the most files", () => {
    const votes = votesFromFindings([
      fakeFinding({ driftCategory: "architectural_consistency", dominantPattern: "repository", totalRelevantFiles: 3 }),
      fakeFinding({ driftCategory: "architectural_consistency", dominantPattern: "raw_sql", totalRelevantFiles: 9 }),
    ]);
    expect(votes.architectural_consistency!.dominantPattern).toBe("raw_sql"); // 9 > 3
    expect(votes.architectural_consistency!.totalRelevantFiles).toBe(9);
  });

  it("handles a missing optional dominantFiles as an empty array", () => {
    const votes = votesFromFindings([fakeFinding({ dominantFiles: undefined })]);
    expect(votes.async_patterns!.dominantFiles).toEqual([]);
  });

  it("keeps auth/validation/rate-limit as SEPARATE security sub-votes (no collision)", () => {
    const subVotes = securitySubVotesFromFindings([
      fakeFinding({ driftCategory: "security_posture", subCategory: "Auth middleware", dominantPattern: "Auth middleware applied", totalRelevantFiles: 5, consistencyScore: 80 }),
      fakeFinding({ driftCategory: "security_posture", subCategory: "Rate limiting", dominantPattern: "Rate limiting applied", totalRelevantFiles: 12, consistencyScore: 60 }),
    ]);
    // Both survive under their own key — the widest-denominator finding does NOT
    // evict the other (which is the perCategoryVote collision this fixes).
    expect(subVotes["Auth middleware"]!.dominantPattern).toBe("Auth middleware applied");
    expect(subVotes["Rate limiting"]!.dominantPattern).toBe("Rate limiting applied");
    expect(subVotes["Auth middleware"]!.totalRelevantFiles).toBe(5);
  });
});

describe("computeBaselineKey", () => {
  const files = [
    { path: "b.ts", hash: "bbb" },
    { path: "a.ts", hash: "aaa" },
  ];

  it("is order-independent (sorted by path before hashing)", () => {
    const k1 = computeBaselineKey(files);
    const k2 = computeBaselineKey([...files].reverse());
    expect(k1).toBe(k2);
  });

  it("changes when any file's content hash changes", () => {
    const k1 = computeBaselineKey(files);
    const k2 = computeBaselineKey([{ path: "a.ts", hash: "aaa" }, { path: "b.ts", hash: "ZZZ" }]);
    expect(k1).not.toBe(k2);
  });
});

describe("buildBaseline + persistence round-trip", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "vd-baseline-"));
    writeFileSync(join(repo, "a.ts"), "export async function a(){ return await fetch('/x'); }\n");
    writeFileSync(join(repo, "b.ts"), "export async function b(){ return await fetch('/y'); }\n");
    writeFileSync(join(repo, "c.ts"), "export function c(){ return fetch('/z').then(r => r.json()); }\n");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("builds a structurally-valid baseline whose key matches its files", async () => {
    const b = await buildBaseline(repo);
    expect(b.rootDir).toBe(repo);
    expect(b.key).toBe(computeBaselineKey(b.ctxFiles));
    expect(b.ctxFiles.length).toBe(3);
    expect(typeof b.builtAt).toBe("number");
    expect(Array.isArray(b.intentHints)).toBe(true);
    expect(typeof b.perCategoryVote).toBe("object");
    // three top-level functions extracted, each with a 128-wide MinHash signature
    expect(b.minhashIndex.length).toBeGreaterThanOrEqual(3);
    expect(b.minhashIndex[0].signature).toBeInstanceOf(Uint32Array);
    expect(b.minhashIndex[0].signature.length).toBe(128);
    expect(b.minhashIndex[0].tokens.length).toBeGreaterThan(0);
  });

  it("persists and reloads an identical baseline (signatures survive as Uint32Array)", async () => {
    const built = await buildBaseline(repo);
    await writeBaseline(built);
    const loaded = await loadBaseline(repo, built.key);
    expect(loaded).not.toBeNull();
    expect(loaded!.key).toBe(built.key);
    expect(loaded!.minhashIndex.length).toBe(built.minhashIndex.length);
    expect(loaded!.minhashIndex[0].signature).toBeInstanceOf(Uint32Array);
    expect(loaded!.minhashIndex[0].signature.length).toBe(128);
    expect(Array.from(loaded!.minhashIndex[0].signature)).toEqual(Array.from(built.minhashIndex[0].signature));
  });

  it("loadBaseline returns null on a key mismatch (content changed)", async () => {
    const built = await buildBaseline(repo);
    await writeBaseline(built);
    expect(await loadBaseline(repo, "deadbeef".repeat(8))).toBeNull();
  });

  it("loadBaselineUnchecked returns the stored baseline regardless of key (for staleness checks)", async () => {
    const built = await buildBaseline(repo);
    await writeBaseline(built);
    const loaded = await loadBaselineUnchecked(repo);
    expect(loaded).not.toBeNull();
    expect(loaded!.key).toBe(built.key);
    expect(loaded!.rootDir).toBe(repo);
  });

  it("assembleBaseline (the scan side-effect path) agrees with standalone buildBaseline", async () => {
    const { ctx } = await buildAnalysisContext(repo);
    const { driftFindings } = runDriftDetection(ctx);
    const assembled = assembleBaseline(repo, ctx, driftFindings);
    const standalone = await buildBaseline(repo);
    expect(assembled.key).toBe(standalone.key);
    expect(assembled.minhashIndex.length).toBe(standalone.minhashIndex.length);
    expect(Object.keys(assembled.perCategoryVote).sort()).toEqual(
      Object.keys(standalone.perCategoryVote).sort(),
    );
  });
});
