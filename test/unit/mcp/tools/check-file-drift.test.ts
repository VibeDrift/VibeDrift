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

// ── Issue #34 blocker 3: security deviations must be read from securitySubVotes ──
//
// perCategoryVote.security_posture keeps only the widest-denominator security
// finding (rate limiting usually wins, since it votes over ALL routes), so a
// file recorded as a deviator only in securitySubVotes["Auth middleware"] (the
// repo's one unauthed mutating route) read as fitting the repo's patterns.
describe("fileDriftFromBaseline — security sub-vote deviators", () => {
  function subVote(pattern: string, dom: number, total: number, deviators: Array<{ path: string; detectedPattern: string }>) {
    return {
      driftCategory: "security_posture" as const,
      dominantPattern: pattern,
      dominantCount: dom,
      totalRelevantFiles: total,
      consistencyScore: Math.round((dom / total) * 100),
      dominantFiles: ["routes/a.ts"],
      deviators,
    };
  }

  function securityBaseline(): RepoDriftBaseline {
    return {
      key: "k",
      rootDir: "/repo",
      ctxFiles: [{ path: "routes/danger.ts", hash: "h" }, { path: "routes/ok.ts", hash: "h" }],
      perCategoryVote: {
        // The collided slot: rate limiting won the widest-denominator
        // tie-break, so the auth deviator is invisible here.
        security_posture: subVote("Rate limiting applied", 9, 12, [
          { path: "routes/slow.ts", detectedPattern: "POST /slow — no Rate limiting" },
        ]),
      },
      securitySubVotes: {
        "Auth middleware": subVote("Auth middleware applied", 4, 5, [
          { path: "routes/danger.ts", detectedPattern: "POST /danger — no Auth middleware" },
        ]),
        "Rate limiting": subVote("Rate limiting applied", 9, 12, [
          { path: "routes/slow.ts", detectedPattern: "POST /slow — no Rate limiting" },
        ]),
      },
      intentHints: [],
      minhashIndex: [],
      builtAt: 0,
    };
  }

  it("reports fits:false citing Auth middleware for the unauthed route even when rate limiting holds the collided slot", () => {
    const r = fileDriftFromBaseline(securityBaseline(), "routes/danger.ts");
    expect(r.fits).toBe(false);
    expect(r.deviations).toHaveLength(1);
    const d = r.deviations[0];
    expect(d.dimension).toBe("security_posture");
    expect(d.dominantPattern).toBe("Auth middleware applied");
    expect(d.yourPattern).toBe("POST /danger — no Auth middleware");
    expect(d.fixHint).toContain("Auth middleware"); // cites WHICH sub-convention
    // Security sub-votes are route-denominated, so the count says routes.
    expect(d.consistency).toBe("4 of 5 routes (80%)");
  });

  it("a file deviating in no sub-vote still fits", () => {
    const r = fileDriftFromBaseline(securityBaseline(), "routes/ok.ts");
    expect(r.fits).toBe(true);
    expect(r.deviations).toEqual([]);
  });

  it("a rate-limit deviator is still flagged (via its sub-vote, no coverage lost from the collided slot)", () => {
    const r = fileDriftFromBaseline(securityBaseline(), "routes/slow.ts");
    expect(r.fits).toBe(false);
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0].dominantPattern).toBe("Rate limiting applied");
  });

  it("falls back to the collided perCategoryVote slot when securitySubVotes is absent (pre-upgrade baseline shape)", () => {
    const b = securityBaseline();
    b.securitySubVotes = undefined;
    const r = fileDriftFromBaseline(b, "routes/slow.ts");
    expect(r.fits).toBe(false);
    expect(r.deviations[0].dominantPattern).toBe("Rate limiting applied");
  });

  it("does not resurrect the collided slot when securitySubVotes is present but empty (every vote below the scoring floor)", () => {
    const b = securityBaseline();
    // The sub-vote builder floors thin votes out, so an empty (but present)
    // record means no security convention is authoritative; the same scan
    // reports the category N/A, and this surface must agree with it rather
    // than cite the below-floor vote still sitting in the collided slot.
    b.securitySubVotes = {};
    const r = fileDriftFromBaseline(b, "routes/slow.ts");
    expect(r.deviations.find((d) => d.dimension === "security_posture")).toBeUndefined();
    expect(r.fits).toBe(true);
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
