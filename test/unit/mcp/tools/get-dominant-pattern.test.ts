import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dominantPatternFor, run, DIMENSIONS } from "../../../../src/mcp/tools/get-dominant-pattern.js";
import { buildBaseline, writeBaseline, type RepoDriftBaseline } from "../../../../src/core/baseline.js";
import { __clearBaselineCache } from "../../../../src/mcp/baseline-provider.js";

function baselineWith(vote: Partial<RepoDriftBaseline["perCategoryVote"]>, fileCount = 5): RepoDriftBaseline {
  return {
    key: "k",
    rootDir: "/x",
    ctxFiles: Array.from({ length: fileCount }, (_, i) => ({ path: `f${i}.ts`, hash: "h" })),
    perCategoryVote: vote,
    intentHints: [],
    minhashIndex: [],
    builtAt: 0,
  };
}

describe("dominantPatternFor (pure projection)", () => {
  it("renders a vote into pattern + a human consistency string + ≤3 examples", () => {
    const b = baselineWith({
      async_patterns: {
        driftCategory: "async_patterns",
        dominantPattern: "async_await",
        dominantCount: 9,
        totalRelevantFiles: 11,
        consistencyScore: 82,
        dominantFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
        deviators: [{ path: "e.ts", detectedPattern: "then_chains" }],
      },
    });
    const r = dominantPatternFor(b, "async");
    expect(r.dimension).toBe("async");
    expect(r.dominantPattern).toBe("async_await");
    expect(r.consistency).toBe("9 of 11 files (82%)");
    expect(r.examples).toEqual(["a.ts", "b.ts", "c.ts"]); // capped at 3
  });

  it("reports a category with no fired vote as fully consistent (no deviations)", () => {
    const r = dominantPatternFor(baselineWith({}, 7), "auth");
    expect(r.dimension).toBe("auth");
    expect(r.dominantPattern).toBe("consistent");
    expect(r.consistency).toMatch(/no deviations/i);
    expect(r.examples).toEqual([]);
  });

  it("maps every agent dimension to a real DriftCategory (no invented categories)", () => {
    // each dimension resolves without throwing on an empty baseline
    for (const dim of DIMENSIONS) {
      expect(() => dominantPatternFor(baselineWith({}), dim)).not.toThrow();
    }
  });
});

describe("get_dominant_pattern (integration via baseline provider)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "vd-dompat-"));
    writeFileSync(join(repo, "a.ts"), "export async function a(){ return await fetch('/x'); }\n");
    writeFileSync(join(repo, "b.ts"), "export async function b(){ return await fetch('/y'); }\n");
    writeFileSync(join(repo, "c.ts"), "export function c(){ return fetch('/z').then(r => r.json()); }\n");
    await writeBaseline(await buildBaseline(repo));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  beforeEach(() => __clearBaselineCache());

  it("returns a well-formed result for a scanned repo", async () => {
    const out = await run({ rootDir: repo, dimension: "async" });
    expect(["ok", "stale"]).toContain(out.status);
    expect(out.dimension).toBe("async");
    expect(typeof out.dominantPattern).toBe("string");
    expect(typeof out.consistency).toBe("string");
    expect(Array.isArray(out.examples)).toBe(true);
    expect(out.examples.length).toBeLessThanOrEqual(3);
  });

  it("returns no_baseline for an unscanned dir", async () => {
    const empty = mkdtempSync(join(tmpdir(), "vd-empty-dp-"));
    try {
      const out = await run({ rootDir: empty, dimension: "naming" });
      expect(out.status).toBe("no_baseline");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
