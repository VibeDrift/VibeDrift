import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileDriftFromBaseline, run } from "../../../../src/mcp/tools/check-file-drift.js";
import { buildBaseline, writeBaseline, type RepoDriftBaseline } from "../../../../src/core/baseline.js";
import { __clearBaselineCache } from "../../../../src/mcp/baseline-provider.js";

function baseline(): RepoDriftBaseline {
  return {
    key: "k",
    rootDir: "/repo",
    ctxFiles: [{ path: "c.ts", hash: "h" }, { path: "a.ts", hash: "h" }],
    perCategoryVote: {
      async_patterns: {
        driftCategory: "async_patterns",
        dominantPattern: "async_await",
        dominantCount: 8,
        totalRelevantFiles: 10,
        consistencyScore: 80,
        dominantFiles: ["a.ts", "b.ts"],
        deviators: [{ path: "c.ts", detectedPattern: "then_chains" }],
      },
    },
    intentHints: [],
    minhashIndex: [],
    builtAt: 0,
  };
}

describe("fileDriftFromBaseline (pure)", () => {
  it("flags a file that drifts, with its pattern, the dominant, and a fix hint citing an exemplar", () => {
    const r = fileDriftFromBaseline(baseline(), "c.ts");
    expect(r.fits).toBe(false);
    expect(r.deviations).toHaveLength(1);
    const d = r.deviations[0];
    expect(d.dimension).toBe("async_patterns");
    expect(d.deviates).toBe(true);
    expect(d.yourPattern).toBe("then_chains");
    expect(d.dominantPattern).toBe("async_await");
    expect(d.consistency).toBe("8 of 10 files (80%)");
    expect(d.fixHint).toMatch(/async_await/);
    expect(d.fixHint).toMatch(/a\.ts/); // exemplar cited
  });

  it("reports fits=true for a file that follows every dominant pattern", () => {
    const r = fileDriftFromBaseline(baseline(), "a.ts");
    expect(r.fits).toBe(true);
    expect(r.deviations).toEqual([]);
  });
});

describe("check_file_drift (integration on the messy-project fixture)", () => {
  const repo = resolve("test/fixtures/messy-project");
  let built: RepoDriftBaseline;
  beforeAll(async () => {
    built = await buildBaseline(repo);
    await writeBaseline(built);
  });
  beforeEach(() => __clearBaselineCache());

  it("reports a real deviator file as drifting in the expected dimension", async () => {
    // pick a real deviator straight out of the freshly-built baseline
    const vote = Object.values(built.perCategoryVote).find((v) => v.deviators.length > 0);
    expect(vote, "fixture should produce at least one deviating file").toBeTruthy();
    const devPath = vote!.deviators[0].path;

    const out = await run({ rootDir: repo, filePath: join(repo, devPath) });
    expect(["ok", "stale"]).toContain(out.status);
    expect(out.file).toBe(devPath);
    expect(out.fits).toBe(false);
    expect(out.deviations.some((d) => d.dimension === vote!.driftCategory)).toBe(true);
    expect(out.deviations.length).toBeLessThanOrEqual(3); // capped
  });

  it("returns no_baseline for an unscanned dir", async () => {
    const empty = mkdtempSync(join(tmpdir(), "vd-empty-cfd-"));
    try {
      const out = await run({ rootDir: empty, filePath: join(empty, "x.ts") });
      expect(out.status).toBe("no_baseline");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
