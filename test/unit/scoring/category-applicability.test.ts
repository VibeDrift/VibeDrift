import { describe, it, expect } from "vitest";
import { computeScores, MIN_SECURITY_PEERS } from "../../../src/scoring/engine.js";
import { isCategoryApplicable, DRIFT_DISPLAY_CATEGORIES } from "../../../src/scoring/categories.js";
import { applicableCategoryCount } from "../../../src/output/terminal.js";
import type { Finding } from "../../../src/core/types.js";

/**
 * These tests answer a specific correctness question: when a category shows
 * "N/A", is that because there is genuinely NOTHING to measure, or because a
 * measurement is broken/missing and we are quietly hiding it?
 *
 * The contract we lock down:
 *   1. A category is N/A on the drift score for EXACTLY two honest reasons:
 *      (a) it has no drift detector at all (Dependency Health — a known,
 *          intentional gap, not a bug: it feeds only the Hygiene score); or
 *      (b) it is "surface-specific" (Security Posture, Intent Clarity) and its
 *          detector found no relevant surface in this repo.
 *   2. Any category whose detector DID find a surface (a real finding) MUST be
 *      scored — it can never be hidden behind N/A. (The anti-bug guard.)
 *   3. A category that is NOT surface-specific (Architectural Consistency,
 *      Redundancy) always scores, even with zero findings (clean credit) — it
 *      never silently vanishes.
 */

function mk(
  analyzerId: string,
  severity: Finding["severity"] = "warning",
  driftSignal?: Finding["driftSignal"],
): Finding {
  return {
    analyzerId,
    severity,
    confidence: 0.9,
    message: `test finding for ${analyzerId}`,
    locations: [{ file: "src/example.ts", line: 1 }],
    tags: [],
    ...(driftSignal ? { driftSignal } : {}),
  };
}

// A drift-security_posture finding with a peer sample AT the min-peer floor
// (see applySecurityMinPeerFloor, src/scoring/engine.ts). Real detector output
// always carries driftSignal for this category (driftFindingToFinding,
// src/drift/index.ts) — a bare mk("drift-security_posture") with no
// driftSignal is a 0-peer sample and is (correctly) demoted to advisory by the
// floor, so these "real finding" guards use a well-sampled fixture instead.
function wellSampledSecurityFinding(severity: Finding["severity"] = "warning"): Finding {
  return mk("drift-security_posture", severity, {
    consistencyScore: 50,
    dominantCount: MIN_SECURITY_PEERS - 1,
    totalRelevantFiles: MIN_SECURITY_PEERS,
  });
}

describe("why a category is N/A: drift-detector presence (isCategoryApplicable)", () => {
  it("Dependency Health has NO drift detector -> N/A on the drift track ALWAYS (missing feature, not a bug)", () => {
    expect(isCategoryApplicable("dependencyHealth", ["typescript"], "drift")).toBe(false);
    expect(isCategoryApplicable("dependencyHealth", ["python"], "drift")).toBe(false);
    expect(isCategoryApplicable("dependencyHealth", ["go"], "drift")).toBe(false);
  });

  it("Dependency Health DOES measure on the hygiene track (dependencies + config-drift analyzers)", () => {
    // Proves the N/A is specifically 'no DRIFT detector', not 'we ignore deps entirely'.
    expect(isCategoryApplicable("dependencyHealth", ["typescript"], "hygiene")).toBe(true);
  });

  it("every other category HAS a drift detector, so it is applicable on the drift track", () => {
    for (const cat of ["architecturalConsistency", "redundancy", "securityPosture", "intentClarity"] as const) {
      expect(isCategoryApplicable(cat, ["typescript"], "drift")).toBe(true);
    }
  });
});

describe("DRIFT_DISPLAY_CATEGORIES: the drift score DISPLAY excludes Dependency Health", () => {
  it("has exactly four categories, none of them dependencyHealth", () => {
    expect(DRIFT_DISPLAY_CATEGORIES).toHaveLength(4);
    expect(DRIFT_DISPLAY_CATEGORIES).not.toContain("dependencyHealth");
  });

  it("is exactly the drift-detector-backed categories", () => {
    expect([...DRIFT_DISPLAY_CATEGORIES]).toEqual([
      "architecturalConsistency",
      "redundancy",
      "securityPosture",
      "intentClarity",
    ]);
  });
});

describe("N/A means nothing to measure — a real surface always scores", () => {
  it("Dependency Health is N/A even when other findings exist (structurally has no drift measurement)", () => {
    const { scores } = computeScores([mk("drift-architectural_consistency"), mk("dependencies")], 30000);
    expect(scores.dependencyHealth.applicable).toBe(false);
    expect(scores.dependencyHealth.findingCount).toBe(0);
  });

  it("non-surface categories score with ZERO findings (clean credit) — never N/A", () => {
    const { scores } = computeScores([], 30000);
    expect(scores.architecturalConsistency.applicable).toBe(true);
    expect(scores.architecturalConsistency.score).toBeGreaterThan(0);
    expect(scores.redundancy.applicable).toBe(true);
    expect(scores.redundancy.score).toBeGreaterThan(0);
  });

  it("surface-specific categories are N/A ONLY when their detector found no surface", () => {
    const { scores } = computeScores([], 30000);
    expect(scores.securityPosture.applicable).toBe(false);
    expect(scores.intentClarity.applicable).toBe(false);
  });

  it("ANTI-BUG GUARD: a security surface (real drift finding) is SCORED, never hidden as N/A", () => {
    const { scores } = computeScores([wellSampledSecurityFinding("error")], 30000);
    expect(scores.securityPosture.applicable).toBe(true);
    expect(scores.securityPosture.findingCount).toBeGreaterThan(0);
  });

  it("ANTI-BUG GUARD: an intent surface (real drift finding) is SCORED, never hidden as N/A", () => {
    const { scores } = computeScores([mk("ml-intent")], 30000);
    expect(scores.intentClarity.applicable).toBe(true);
    expect(scores.intentClarity.findingCount).toBeGreaterThan(0);
  });
});

describe("N/A set is exactly the honest set; composite excludes N/A", () => {
  it("on an empty scan, exactly {dependencyHealth, intentClarity, securityPosture} are N/A", () => {
    const { scores } = computeScores([], 30000);
    const na = Object.entries(scores as Record<string, { applicable: boolean }>)
      .filter(([, s]) => s.applicable === false)
      .map(([k]) => k)
      .sort();
    // If this ever changes, a category either lost its detector or was wrongly
    // made surface-specific (and would silently vanish) — investigate, don't
    // just update the expectation.
    expect(na).toEqual(["dependencyHealth", "intentClarity", "securityPosture"]);
  });

  it("composite counts only applicable categories, and a new surface adds to the count", () => {
    expect(applicableCategoryCount(computeScores([], 30000).scores)).toBe(2); // arch + redundancy
    expect(applicableCategoryCount(computeScores([wellSampledSecurityFinding()], 30000).scores)).toBe(3); // + security
  });
});
