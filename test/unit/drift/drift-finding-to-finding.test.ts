import { describe, it, expect } from "vitest";
import { driftFindingToFinding } from "../../../src/drift/index.js";
import type { DriftFinding } from "../../../src/drift/types.js";

function makeDriftFinding(overrides: Partial<DriftFinding> = {}): DriftFinding {
  return {
    detector: "convention-oscillation",
    driftCategory: "naming_conventions",
    severity: "warning",
    confidence: 0.9,
    finding: "Mixed naming conventions",
    dominantPattern: "camelCase",
    dominantCount: 7,
    totalRelevantFiles: 10,
    consistencyScore: 70,
    deviatingFiles: [
      {
        path: "src/a.ts",
        detectedPattern: "snake_case",
        evidence: [{ line: 3, code: "const my_var = 1" }],
      },
    ],
    recommendation: "Use camelCase",
    ...overrides,
  };
}

describe("driftFindingToFinding — dominance ratio is carried to scoring", () => {
  it("populates driftSignal from the DriftFinding's dominance numbers", () => {
    const f = driftFindingToFinding(makeDriftFinding());
    expect(f.driftSignal).toEqual({
      consistencyScore: 70,
      dominantCount: 7,
      totalRelevantFiles: 10,
    });
  });

  it("preserves the exact consistencyScore so the engine can derive the deviation fraction", () => {
    const f = driftFindingToFinding(
      makeDriftFinding({ consistencyScore: 51, dominantCount: 51, totalRelevantFiles: 100 }),
    );
    expect(f.driftSignal?.consistencyScore).toBe(51);
    // deviation fraction = share of relevant files that drift = 1 - 0.51
    expect(1 - f.driftSignal!.consistencyScore / 100).toBeCloseTo(0.49);
  });

  it("carries a near-zero deviation fraction for a highly consistent category", () => {
    const f = driftFindingToFinding(
      makeDriftFinding({ consistencyScore: 98, dominantCount: 98, totalRelevantFiles: 100 }),
    );
    expect(1 - f.driftSignal!.consistencyScore / 100).toBeCloseTo(0.02);
  });
});
