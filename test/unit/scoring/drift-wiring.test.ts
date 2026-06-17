import { describe, it, expect } from "vitest";
import { getAnalyzerKind } from "../../../src/scoring/categories.js";
import { driftFindingToFinding, attachEngineComposite } from "../../../src/drift/index.js";
import { DRIFT_WEIGHTS } from "../../../src/drift/types.js";
import type { DriftFinding, DriftCategory } from "../../../src/drift/types.js";

/**
 * Regression guard for the wiring bug: every drift detector must emit a
 * finding whose analyzerId resolves to kind "drift" in the scoring engine.
 * Before the fix, 11 of 14 detectors emitted `drift-<freeform-detector-name>`
 * ids that matched nothing in CATEGORY_CONFIG, so getAnalyzerKind() defaulted
 * them to "hygiene" and they were filtered out of the Vibe Drift Score
 * entirely — the flagship drift signals (duplication, naming, async/import/
 * export) moved the headline by exactly 0.
 *
 * The fix keys the analyzerId off the typed `driftCategory` enum (one source
 * of truth), and registers all 13 `drift-<category>` ids in CATEGORY_CONFIG.
 * DRIFT_WEIGHTS is a Record over every DriftCategory, so iterating its keys
 * guarantees we cover the full enum — a new category added without a scoring
 * registration fails this test.
 */
describe("drift detector → scoring wiring", () => {
  const allCategories = Object.keys(DRIFT_WEIGHTS) as DriftCategory[];

  it("every DriftCategory resolves to kind 'drift' in scoring", () => {
    for (const cat of allCategories) {
      expect(getAnalyzerKind(`drift-${cat}`)).toBe("drift");
    }
  });

  it("driftFindingToFinding builds the analyzerId from driftCategory", () => {
    const mk = (driftCategory: DriftCategory): DriftFinding => ({
      detector: "whatever-freeform-name",
      driftCategory,
      severity: "warning",
      confidence: 0.8,
      finding: "test",
      dominantPattern: "x",
      dominantCount: 5,
      totalRelevantFiles: 7,
      consistencyScore: 71,
      deviatingFiles: [],
      recommendation: "fix it",
    });

    // The id must come from the typed category, NOT the freeform detector name.
    expect(driftFindingToFinding(mk("semantic_duplication")).analyzerId).toBe(
      "drift-semantic_duplication",
    );
    expect(driftFindingToFinding(mk("naming_conventions")).analyzerId).toBe(
      "drift-naming_conventions",
    );
  });

  it("every drift finding scores as drift kind (not hygiene)", () => {
    const mk = (driftCategory: DriftCategory): DriftFinding => ({
      detector: "whatever",
      driftCategory,
      severity: "warning",
      confidence: 0.8,
      finding: "test",
      dominantPattern: "x",
      dominantCount: 5,
      totalRelevantFiles: 7,
      consistencyScore: 71,
      deviatingFiles: [],
      recommendation: "fix it",
    });
    for (const cat of allCategories) {
      const f = driftFindingToFinding(mk(cat));
      expect(getAnalyzerKind(f.analyzerId)).toBe("drift");
    }
  });
});

/**
 * Dual-engine collapse: the only composite is the scoring engine's
 * compositeScore. The uploaded driftScores payload (which the dashboard reads
 * at result_json.driftScores.composite) must mirror that single number, never
 * recompute its own. attachEngineComposite is the one place that mirror happens.
 */
describe("single-composite mirror", () => {
  it("mirrors the engine composite onto driftScores without mutating input", () => {
    const breakdown = { architectural_consistency: { score: 16, maxScore: 16, findings: 0 } } as never;
    const out = attachEngineComposite(breakdown, 73.4);
    expect(out.composite).toBe(73.4);
    // input is not mutated (no stray composite leaks back onto the breakdown)
    expect((breakdown as Record<string, unknown>).composite).toBeUndefined();
  });
});
