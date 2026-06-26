import { describe, it, expect } from "vitest";
import { buildFixPlanWidget } from "../../../src/output/html.js";
import type { ScanResult } from "../../../src/core/types.js";

// Render smoke test: the fix-plan widget must build without throwing (it once
// referenced `compositeScore` out of scope → ReferenceError only at HTML render,
// which --local-only never exercised) and present the projection in ONE scale.
function resultWithImpactFindings(): ScanResult {
  return {
    compositeScore: 84.4,
    maxCompositeScore: 100,
    context: {
      rootDir: "/r/proj",
      dominantLanguage: "typescript",
      totalLines: 2000,
      files: [{}, {}, {}],
      languageBreakdown: new Map([["typescript", 3]]),
      packageJson: null,
      goMod: null,
      cargoToml: null,
      requirementsTxt: null,
      envExample: null,
    },
    findings: [
      {
        analyzerId: "drift-architectural_consistency",
        severity: "warning",
        confidence: 0.8,
        message: "DRIFT: src/order.ts uses raw SQL while peers use a repository",
        locations: [{ file: "src/order.ts", line: 1 }],
        tags: [],
        consistencyImpact: 2.4,
      },
      {
        analyzerId: "drift-naming_conventions",
        severity: "warning",
        confidence: 0.8,
        message: "DRIFT: inconsistent naming in src/util",
        locations: [{ file: "src/util/a.ts", line: 1 }],
        tags: [],
        consistencyImpact: 0.8,
      },
    ],
  } as unknown as ScanResult;
}

describe("buildFixPlanWidget", () => {
  it("renders without throwing and shows a projected score", () => {
    let html = "";
    expect(() => { html = buildFixPlanWidget(resultWithImpactFindings()); }).not.toThrow();
    expect(html).toContain("projected");
    expect(html).toContain("/100");
  });

  it("presents the projection in one scale — no cross-scale cumulative", () => {
    const html = buildFixPlanWidget(resultWithImpactFindings());
    // The contradictory consistency-point cumulative + 'Sum of individual' lines
    // are gone; the headline is the composite score and its composite delta.
    expect(html).not.toContain("Sum of individual");
    expect(html).not.toContain("pts consistency)");
  });
});
