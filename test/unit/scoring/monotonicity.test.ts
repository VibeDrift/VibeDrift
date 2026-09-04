import { describe, it, expect } from "vitest";
import { computeScores, estimateScoreAfterFixes } from "../../../src/scoring/engine.js";
import type { Finding } from "../../../src/core/types.js";

/**
 * The composite must be MONOTONE in the finding set: adding a finding can never
 * raise the Vibe Drift Score, and closing one can never lower it. A score that
 * goes UP when a detector fires is not a measurement, and the Fix Plan's
 * projection ("if you close these, you'll be at N") is unusable when closing a
 * finding can make N smaller.
 *
 * Three separate inversions existed (all fixed in SCORING_VERSION v16):
 *
 *   1. securityPosture / intentClarity are excluded from the composite while
 *      EMPTY (SURFACE_SPECIFIC_DRIFT_CATEGORIES: zero findings can't be told
 *      apart from "no surface"), and re-enter on their first finding. Entering
 *      near full health, ABOVE the mean of the categories we always measure,
 *      pulled the geometric mean UP — measured at 65.0 -> 74.9 on adding a
 *      single security drift finding.
 *   2. A category holding one faint finding could score above the evidence-
 *      weighted clean credit an EMPTY category earns, so closing the last
 *      finding LOWERED that category.
 *   3. Detector confidence was the group MEAN, so adding a low-confidence
 *      finding to a group lowered the mean and therefore the damage.
 *
 * These tests bind by construction: each is a strict comparison between two real
 * `computeScores` runs, so reverting any of the three fixes fails one of them.
 */

function drift(
  analyzerId: string,
  opts: {
    severity?: Finding["severity"];
    confidence?: number;
    file?: string;
    consistencyScore?: number;
    totalRelevantFiles?: number;
    message?: string;
  } = {},
): Finding {
  const consistencyScore = opts.consistencyScore ?? 70;
  const totalRelevantFiles = opts.totalRelevantFiles ?? 12;
  return {
    analyzerId,
    severity: opts.severity ?? "warning",
    confidence: opts.confidence ?? 0.9,
    message: opts.message ?? `DRIFT ${analyzerId}`,
    locations: [{ file: opts.file ?? "src/a.ts", line: 1 }],
    tags: ["drift"],
    driftSignal: {
      consistencyScore,
      dominantCount: Math.round((totalRelevantFiles * consistencyScore) / 100),
      totalRelevantFiles,
    },
  };
}

const LINES = 12000;

describe("composite monotonicity", () => {
  it("adding the FIRST security drift finding never raises the composite (the 65.0 -> 74.9 inversion)", () => {
    // A repo with real drift in the always-measured categories and no security
    // surface at all. securityPosture and intentClarity are excluded, so the
    // composite is the geometric mean of what is left — a middling score.
    const withoutSecurity: Finding[] = [
      drift("drift-architectural_consistency", { consistencyScore: 55, severity: "error" }),
      drift("drift-naming_conventions", { consistencyScore: 50, severity: "error", file: "src/b.ts" }),
      drift("drift-import_style", { consistencyScore: 60, file: "src/c.ts" }),
      drift("drift-semantic_duplication", { consistencyScore: 58, file: "src/d.ts" }),
      drift("drift-logging_consistency", { consistencyScore: 52, severity: "error", file: "src/e.ts" }),
    ];

    const before = computeScores(withoutSecurity, LINES, undefined, undefined, {
      mutateImpact: false,
    });
    expect(before.scores.securityPosture.applicable).toBe(false);

    // Now the security detector fires once. The category enters the composite at
    // a health well ABOVE the drift already measured elsewhere — the exact shape
    // that used to lift the headline.
    const withSecurity = [
      ...withoutSecurity,
      drift("drift-security_posture", {
        consistencyScore: 90,
        totalRelevantFiles: 20,
        file: "src/routes/x.ts",
        severity: "warning",
      }),
    ];
    const after = computeScores(withSecurity, LINES, undefined, undefined, { mutateImpact: false });

    expect(after.scores.securityPosture.applicable).toBe(true);
    // The finding is still REPORTED at its own honest health — only its
    // contribution to the mean is clamped.
    expect(after.scores.securityPosture.score).toBeGreaterThan(0);
    // The headline may fall, or hold. It may never rise.
    expect(after.compositeScore).toBeLessThanOrEqual(before.compositeScore);
  });

  it("removing ANY single finding never lowers the composite", () => {
    // A realistic mixed population: several categories, both tracks, mixed
    // severities, mixed confidences within the same detector (inversion 3), a
    // count-based detector, a category that empties out when its only finding is
    // removed (inversion 2), and a surface-specific category (inversion 1).
    const all: Finding[] = [
      drift("drift-architectural_consistency", { consistencyScore: 62, severity: "error", confidence: 0.95 }),
      drift("drift-architectural_consistency", { consistencyScore: 88, confidence: 0.2, file: "src/b.ts" }),
      drift("drift-naming_conventions", { consistencyScore: 71, confidence: 0.6, file: "src/c.ts" }),
      drift("drift-naming_conventions", { consistencyScore: 99, confidence: 0.05, file: "src/d.ts" }),
      drift("drift-import_style", { consistencyScore: 96, severity: "info", confidence: 0.3, file: "src/e.ts" }),
      drift("drift-logging_consistency", { consistencyScore: 80, file: "src/index.ts" }),
      drift("drift-security_posture", { consistencyScore: 92, totalRelevantFiles: 16, file: "src/routes/a.ts" }),
      drift("drift-security_posture", { consistencyScore: 40, totalRelevantFiles: 16, severity: "error", file: "src/routes/b.ts" }),
      {
        analyzerId: "codedna-fingerprint",
        severity: "warning",
        confidence: 0.85,
        message: "duplicate group",
        locations: [{ file: "src/dup-a.ts", line: 3 }, { file: "src/dup-b.ts", line: 9 }],
        tags: ["codedna"],
        dupGroupSize: 4,
      },
      {
        analyzerId: "codedna-taint",
        severity: "error",
        confidence: 0.75,
        message: "taint",
        locations: [{ file: "src/routes/c.ts", line: 12 }],
        tags: ["codedna", "taint"],
      },
      // Hygiene-track findings, present so the drift track is exercised
      // alongside a populated hygiene track rather than in isolation.
      {
        analyzerId: "complexity",
        severity: "warning",
        confidence: 0.7,
        message: "complex",
        locations: [{ file: "src/f.ts", line: 4 }],
        tags: [],
      },
    ];

    const ctx = undefined;
    const base = computeScores(all, LINES, ctx, undefined, { mutateImpact: false }).compositeScore;

    for (let i = 0; i < all.length; i++) {
      const without = all.slice(0, i).concat(all.slice(i + 1));
      const removed = computeScores(without, LINES, ctx, undefined, {
        mutateImpact: false,
      }).compositeScore;
      expect(
        base,
        `removing findings[${i}] (${all[i].analyzerId}, confidence ${all[i].confidence}) lowered the composite: ${base} -> ${removed}`,
      ).toBeLessThanOrEqual(removed);
    }
  });

  it("holds on a thin-evidence repo, where the empty-category clean credit is well under 1.0", () => {
    // Small LOC is where inversion 2 bites: an empty category earns only
    // NO_FINDING_PRIOR..1 of maxScore, so a category holding one faint finding
    // could out-score the same category holding none.
    const all: Finding[] = [
      drift("drift-import_style", { consistencyScore: 99, severity: "info", confidence: 0.1 }),
      drift("drift-naming_conventions", { consistencyScore: 97, severity: "info", confidence: 0.1, file: "src/b.ts" }),
    ];
    const base = computeScores(all, 400, undefined, undefined, { mutateImpact: false }).compositeScore;
    for (let i = 0; i < all.length; i++) {
      const without = all.slice(0, i).concat(all.slice(i + 1));
      const removed = computeScores(without, 400, undefined, undefined, {
        mutateImpact: false,
      }).compositeScore;
      expect(base).toBeLessThanOrEqual(removed);
    }
  });

  it("a category holding findings never out-scores the same category holding none", () => {
    const one = computeScores(
      [drift("drift-import_style", { consistencyScore: 99, severity: "info", confidence: 0.05 })],
      400,
      undefined,
      undefined,
      { mutateImpact: false },
    );
    const none = computeScores([], 400, undefined, undefined, { mutateImpact: false });
    expect(one.scores.architecturalConsistency.score).toBeLessThanOrEqual(
      none.scores.architecturalConsistency.score,
    );
  });

  it("adding one signal-less finding to a dominance group under the same analyzerId never raises the composite", () => {
    // `groupDeviation` used to pick its branch with `findings.every(driftSignal)`:
    // ONE signal-less finding flipped a whole dominance group into the count
    // branch, swapping a large worst-deviation for a tiny per-function rate —
    // measured at +31.3 points from a single added finding. `codedna-pattern`
    // really does this: "Pattern drift" carries driftSignal, "Mixed patterns"
    // (same analyzerId) deliberately does not.
    const dominance: Finding[] = [
      drift("codedna-pattern", { consistencyScore: 30, severity: "warning", totalRelevantFiles: 20 }),
      drift("codedna-pattern", { consistencyScore: 35, severity: "warning", totalRelevantFiles: 20, file: "src/b.ts" }),
      drift("drift-naming_conventions", { consistencyScore: 70, file: "src/c.ts" }),
    ];
    const plain: Finding = {
      analyzerId: "codedna-pattern",
      severity: "info",
      confidence: 0.6,
      message: "Mixed patterns in src/d.ts: a, b — file mixes architectural approaches internally",
      locations: [{ file: "src/d.ts" }],
      tags: ["codedna", "pattern", "mixed"],
    };

    const before = computeScores(dominance, LINES, undefined, undefined, { mutateImpact: false });
    const after = computeScores([...dominance, plain], LINES, undefined, undefined, {
      mutateImpact: false,
    });
    expect(after.compositeScore).toBeLessThanOrEqual(before.compositeScore);
  });

  it("removing ANY single finding from a mixed signal / signal-less detector group never lowers the composite (randomized)", () => {
    // Deterministic PRNG so a failure reproduces from its trial index.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const severities: Finding["severity"][] = ["info", "warning", "error"];

    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rand() * 5);
      const all: Finding[] = [];
      for (let i = 0; i < n; i++) {
        const file = `src/${String.fromCharCode(97 + i)}.ts`;
        if (rand() < 0.5) {
          all.push(
            drift("codedna-pattern", {
              consistencyScore: Math.round(rand() * 100),
              totalRelevantFiles: 2 + Math.floor(rand() * 30),
              severity: pick(severities),
              confidence: 0.05 + rand() * 0.95,
              file,
            }),
          );
        } else {
          all.push({
            analyzerId: "codedna-pattern",
            severity: pick(severities),
            confidence: 0.05 + rand() * 0.95,
            message: `Mixed patterns in ${file}`,
            locations: [{ file }],
            tags: ["codedna", "pattern", "mixed"],
            ...(rand() < 0.5 ? { itemCount: 1 + Math.floor(rand() * 10) } : {}),
          });
        }
      }
      // A second detector so the category is never emptied by a removal (that
      // path is pinned by the other tests; this one isolates the branch flip).
      all.push(drift("drift-naming_conventions", { consistencyScore: 70, file: "src/zz.ts" }));

      const lines = pick([400, 3000, 12000]);
      const base = computeScores(all, lines, undefined, undefined, { mutateImpact: false }).compositeScore;
      for (let i = 0; i < all.length; i++) {
        const without = all.slice(0, i).concat(all.slice(i + 1));
        const removed = computeScores(without, lines, undefined, undefined, {
          mutateImpact: false,
        }).compositeScore;
        expect(
          base,
          `trial ${trial}: removing findings[${i}] (${all[i].driftSignal ? "signal" : "plain"}, ${all[i].severity}) lowered the composite: ${base} -> ${removed}`,
        ).toBeLessThanOrEqual(removed);
      }
    }
  });

  it("estimateScoreAfterFixes never projects a LOWER score than doing nothing", () => {
    const all: Finding[] = [
      drift("drift-architectural_consistency", { consistencyScore: 60, severity: "error" }),
      drift("drift-naming_conventions", { consistencyScore: 65, file: "src/b.ts" }),
      drift("drift-logging_consistency", { consistencyScore: 58, severity: "error", file: "src/c.ts" }),
      drift("drift-security_posture", { consistencyScore: 95, totalRelevantFiles: 14, file: "src/routes/a.ts" }),
    ];
    const before = computeScores(all, LINES, undefined, undefined, { mutateImpact: false });

    // Every single-finding fix, and the all-at-once fix, must project forward.
    for (const f of all) {
      const projected = estimateScoreAfterFixes(all, [f], LINES);
      expect(
        projected.compositeScore,
        `fixing ${f.analyzerId} projected a DROP: ${before.compositeScore} -> ${projected.compositeScore}`,
      ).toBeGreaterThanOrEqual(before.compositeScore);
      expect(projected.consistencyGain).toBeGreaterThanOrEqual(0);
    }
    const allFixed = estimateScoreAfterFixes(all, all, LINES);
    expect(allFixed.compositeScore).toBeGreaterThanOrEqual(before.compositeScore);
  });
});
