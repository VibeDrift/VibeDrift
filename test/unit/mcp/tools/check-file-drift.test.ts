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

describe("fileDriftFromBaseline (security sub-votes)", () => {
  // A baseline whose collapsed security_posture slot is the RATE-LIMIT vote
  // (widest denominator) that does NOT list orders.ts, while the granular
  // "Auth middleware" sub-vote DOES flag orders.ts as an auth deviator.
  function securityBaseline(): RepoDriftBaseline {
    return {
      key: "k",
      rootDir: "/repo",
      ctxFiles: [{ path: "orders.ts", hash: "h" }],
      perCategoryVote: {
        security_posture: {
          driftCategory: "security_posture",
          dominantPattern: "rate_limit_present",
          dominantCount: 9,
          totalRelevantFiles: 10,
          consistencyScore: 90,
          dominantFiles: ["users.ts"],
          deviators: [{ path: "other.ts", detectedPattern: "no_rate_limit" }],
        },
      },
      securitySubVotes: {
        "Auth middleware": {
          driftCategory: "security_posture",
          dominantPattern: "requireAuth",
          dominantCount: 5,
          totalRelevantFiles: 6,
          consistencyScore: 83,
          dominantFiles: ["users.ts"],
          deviators: [{ path: "orders.ts", detectedPattern: "no_auth" }],
        },
      },
      intentHints: [],
      minhashIndex: [],
      builtAt: 0,
    };
  }

  it("flags an unauthed route as fits:false via securitySubVotes even when the collapsed rate-limit slot does not list it", () => {
    const r = fileDriftFromBaseline(securityBaseline(), "orders.ts");
    expect(r.fits).toBe(false);
    expect(r.deviations).toHaveLength(1);
    const d = r.deviations[0];
    expect(d.dimension).toBe("security_posture");
    expect(d.yourPattern).toBe("no_auth");
    expect(d.dominantPattern).toBe("requireAuth");
    // security dimension consistency counts routes, not files
    expect(d.consistency).toMatch(/routes/);
    expect(d.consistency).not.toMatch(/files/);
    expect(d.fixHint).toMatch(/requireAuth/);
  });

  it("does not double-count a file that is a deviator in BOTH the collapsed slot and its sub-vote", () => {
    const b = securityBaseline();
    // orders.ts is now a rate-limit deviator in the collapsed slot AND in the
    // "Rate limiting" sub-vote for the same underlying sub-convention.
    b.perCategoryVote.security_posture!.deviators = [
      { path: "orders.ts", detectedPattern: "no_rate_limit" },
    ];
    b.securitySubVotes = {
      "Rate limiting": {
        driftCategory: "security_posture",
        dominantPattern: "rate_limit_present",
        dominantCount: 9,
        totalRelevantFiles: 10,
        consistencyScore: 90,
        dominantFiles: ["users.ts"],
        deviators: [{ path: "orders.ts", detectedPattern: "no_rate_limit" }],
      },
    };
    const r = fileDriftFromBaseline(b, "orders.ts");
    const sec = r.deviations.filter((d) => d.dimension === "security_posture");
    expect(sec).toHaveLength(1);
    // proves it came from the sub-vote path (routes), not the collapsed slot (files)
    expect(sec[0].consistency).toMatch(/routes/);
  });

  it("renders a below-floor sub-vote as advisory but still counts it as a non-fit", () => {
    const b = securityBaseline();
    b.perCategoryVote = {}; // isolate the sub-vote path
    b.securitySubVotes = {
      "Auth middleware": {
        driftCategory: "security_posture",
        dominantPattern: "requireAuth",
        dominantCount: 2,
        totalRelevantFiles: 3,
        consistencyScore: 67,
        dominantFiles: ["users.ts"],
        deviators: [{ path: "orders.ts", detectedPattern: "no_auth" }],
        belowPeerFloor: true,
      },
    };
    const r = fileDriftFromBaseline(b, "orders.ts");
    expect(r.fits).toBe(false); // hedge, never bless
    expect(r.deviations).toHaveLength(1);
    const d = r.deviations[0];
    expect(d.consistency).toMatch(/advisory/i);
    expect(d.fixHint).toMatch(/advisory/i);
  });

  it("falls back to the collapsed security_posture slot when securitySubVotes is absent (older baseline)", () => {
    const b = securityBaseline();
    delete b.securitySubVotes;
    b.perCategoryVote.security_posture!.deviators = [
      { path: "orders.ts", detectedPattern: "no_rate_limit" },
    ];
    const r = fileDriftFromBaseline(b, "orders.ts");
    expect(r.fits).toBe(false);
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0].dimension).toBe("security_posture");
    // legacy path keeps the file-unit wording
    expect(r.deviations[0].consistency).toMatch(/files/);
  });

  it("falls back to the collapsed slot when securitySubVotes is present but EMPTY (never silently drops a real security deviator)", () => {
    // Defensive: an empty {} securitySubVotes must not suppress a real collapsed
    // security_posture deviator. Mere presence is not enough to skip the slot;
    // there must be actual sub-votes to read instead, or never-false-bless breaks.
    const b = securityBaseline();
    b.securitySubVotes = {};
    b.perCategoryVote.security_posture!.deviators = [
      { path: "orders.ts", detectedPattern: "no_rate_limit" },
    ];
    const r = fileDriftFromBaseline(b, "orders.ts");
    expect(r.fits).toBe(false);
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0].dimension).toBe("security_posture");
    expect(r.deviations[0].consistency).toMatch(/files/);
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
