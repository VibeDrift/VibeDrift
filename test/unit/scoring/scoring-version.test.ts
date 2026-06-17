import { describe, it, expect } from "vitest";
import { computeScores, SCORING_VERSION } from "../../../src/scoring/engine.js";
import type { CategoryScores } from "../../../src/core/types.js";

const mkPrev = (score: number): CategoryScores => ({
  architecturalConsistency: { score, maxScore: 20, locked: false, findingCount: 0, applicable: true },
  redundancy: { score, maxScore: 20, locked: false, findingCount: 0, applicable: true },
  dependencyHealth: { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false },
  securityPosture: { score, maxScore: 20, locked: false, findingCount: 0, applicable: true },
  intentClarity: { score, maxScore: 20, locked: false, findingCount: 0, applicable: true },
});

describe("scoring version stamping", () => {
  it("SCORING_VERSION constant is exported and non-empty", () => {
    expect(typeof SCORING_VERSION).toBe("string");
    expect(SCORING_VERSION.length).toBeGreaterThan(0);
  });

  it("computeScores stamps the scoring version on its result", () => {
    const result = computeScores([], 1000);
    expect(result.scoringVersion).toBe(SCORING_VERSION);
  });
});

describe("scoring version delta gating", () => {
  it("computes a numeric delta when the previous version matches the current", () => {
    const prev = mkPrev(15);
    const result = computeScores([], 1000, undefined, prev, {
      previousScoringVersion: SCORING_VERSION,
    });
    // pristine current scan = 20/20 on every applicable category; prev was 15; delta should be +5
    expect(result.scores.architecturalConsistency.delta).toBe(5);
    expect(result.scores.redundancy.delta).toBe(5);
  });

  it("refuses to set a delta when the previous version is missing", () => {
    const prev = mkPrev(15);
    // legacy call shape: previousScoringVersion omitted → treated as a version mismatch
    const result = computeScores([], 1000, undefined, prev);
    expect(result.scores.architecturalConsistency.delta).toBeUndefined();
    expect(result.scores.redundancy.delta).toBeUndefined();
  });

  it("refuses to set a delta when the previous version is older", () => {
    const prev = mkPrev(15);
    const result = computeScores([], 1000, undefined, prev, {
      previousScoringVersion: "v1",
    });
    expect(result.scores.architecturalConsistency.delta).toBeUndefined();
    expect(result.scores.redundancy.delta).toBeUndefined();
  });

  it("sets a clear mismatch reason the renderer can surface", () => {
    const prev = mkPrev(15);
    const result = computeScores([], 1000, undefined, prev, {
      previousScoringVersion: "v1",
    });
    expect(result.previousScoresMismatch).toBe("scoring-version-mismatch");
  });

  it("does NOT set the mismatch reason when versions match", () => {
    const prev = mkPrev(15);
    const result = computeScores([], 1000, undefined, prev, {
      previousScoringVersion: SCORING_VERSION,
    });
    expect(result.previousScoresMismatch).toBeUndefined();
  });
});

// NOTE: the loud per-scan `renderVersionMismatchBanner` was removed in Phase 1.
// `previousScoresMismatch` now drives SILENT suppression of the diff banner
// (renderDiffBanner returns [] on mismatch) plus the one-time scoring-refined
// notice (src/core/scoring-notice.ts) — no user-facing version banner.
