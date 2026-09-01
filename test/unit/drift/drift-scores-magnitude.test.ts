import { describe, it, expect } from "vitest";
import { computeDriftScores } from "../../../src/drift/index.js";
import { categoryHealth } from "../../../src/scoring/engine.js";
import { DRIFT_WEIGHTS } from "../../../src/drift/types.js";
import type { Finding } from "../../../src/core/types.js";

/**
 * The per-category drift bars and the composite must read the SAME magnitude
 * formula for the same findings.
 *
 * Count-based categories (semantic_duplication, phantom_scaffolding) are
 * normalized by a per-FUNCTION rate when the function count is known and fall
 * back to a per-KLOC density when it is 0. `computeDriftScores` never received
 * a function count, so the bar was computed with the KLOC formula while the
 * composite used the function-rate one, and the two disagreed about the same
 * finding set.
 */

const TOTAL_LINES = 20000;
const FUNCTION_COUNT = 400;

function countBased(file: string): Finding {
  return {
    analyzerId: "drift-semantic_duplication",
    severity: "warning",
    confidence: 0.9,
    message: "DRIFT: near-duplicate implementations",
    locations: [{ file, line: 1 }],
    tags: ["drift", "semantic_duplication"],
  };
}

describe("computeDriftScores magnitude", () => {
  const findings = Array.from({ length: 24 }, (_, i) => countBased(`src/dup${i}.ts`));

  it("uses the same categoryHealth the composite uses, with the function count threaded through", () => {
    const scores = computeDriftScores(findings, TOTAL_LINES, FUNCTION_COUNT);
    const kloc = Math.max(1, TOTAL_LINES / 1000);
    const expected =
      Math.round(
        DRIFT_WEIGHTS.semantic_duplication *
          categoryHealth(findings, true, kloc, FUNCTION_COUNT) *
          10,
      ) / 10;
    expect(scores.semantic_duplication.score).toBe(expected);
    expect(scores.semantic_duplication.findings).toBe(findings.length);
  });

  it("binds: the two formulas really do produce different bars", () => {
    // Without this, the assertion above would hold even if the parameter were
    // being dropped again.
    const withCount = computeDriftScores(findings, TOTAL_LINES, FUNCTION_COUNT);
    const withoutCount = computeDriftScores(findings, TOTAL_LINES);
    expect(withCount.semantic_duplication.score).not.toBe(
      withoutCount.semantic_duplication.score,
    );
  });

  it("leaves dominance-based categories untouched by the function count", () => {
    const dominance: Finding[] = [
      {
        analyzerId: "drift-naming_conventions",
        severity: "warning",
        confidence: 0.9,
        message: "DRIFT: naming",
        locations: [{ file: "src/a.ts", line: 1 }],
        tags: ["drift"],
        driftSignal: { consistencyScore: 70, dominantCount: 14, totalRelevantFiles: 20 },
      },
    ];
    expect(computeDriftScores(dominance, TOTAL_LINES, FUNCTION_COUNT).naming_conventions.score).toBe(
      computeDriftScores(dominance, TOTAL_LINES).naming_conventions.score,
    );
  });
});
