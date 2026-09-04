import { describe, it, expect } from "vitest";
import { renderTerminalOutput, renderConciseSummary } from "../../../src/output/terminal.js";
import type { Finding, ScanResult } from "../../../src/core/types.js";

/**
 * P2: the drift-first Fix Plan's diversity guard (renderFixPlan) hardcoded
 * "3" as the max duplicates-per-analyzer allowance while maxItems defaults
 * to 5. When the top-priority findings all share one analyzer, the guard
 * stopped filling at 3 items even though 2 more slots (and 2 more qualifying
 * findings) were available — the plan under-filled instead of using the
 * full cap. The fix derives the cap from maxItems and backfills any
 * remaining slots with duplicates rather than leaving them empty.
 */

function minimalScanResult(overrides?: Partial<ScanResult>): ScanResult {
  const emptyCat = { score: 18, maxScore: 20, locked: false, findingCount: 0, applicable: true };
  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "typescript",
      languageBreakdown: new Map(),
      totalLines: 1000,
      files: [],
      intentHints: [],
    },
    compositeScore: 84,
    maxCompositeScore: 100,
    percentile: null,
    peerLanguage: "typescript",
    scores: {
      architecturalConsistency: { ...emptyCat },
      redundancy: { ...emptyCat },
      dependencyHealth: { ...emptyCat },
      securityPosture: { ...emptyCat },
      intentClarity: { ...emptyCat },
    },
    hygieneScore: 90,
    maxHygieneScore: 100,
    hygieneScores: {
      architecturalConsistency: { ...emptyCat },
      redundancy: { ...emptyCat },
      dependencyHealth: { ...emptyCat },
      securityPosture: { ...emptyCat },
      intentClarity: { ...emptyCat },
    },
    findings: [],
    driftFindings: [],
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    deepInsights: [],
    scanTimeMs: 5,
    ...overrides,
  } as unknown as ScanResult;
}

/** Five findings, all from the same analyzer (no diversity possible). */
function fiveSameAnalyzerFindings(): Finding[] {
  return Array.from({ length: 5 }, (_, i) => ({
    analyzerId: "naming",
    severity: "warning",
    confidence: 0.9,
    message: `naming-drift-item-${i + 1}`,
    locations: [{ file: `src/file-${i + 1}.ts`, line: 1 }],
    tags: [],
    consistencyImpact: 5 - i, // 5,4,3,2,1 — all above the 0.05 display floor
  }));
}

describe("Fix Plan diversity guard scales with maxItems", () => {
  it("fills all 5 slots (maxItems=5) even when every top finding shares one analyzer", () => {
    const result = minimalScanResult({ findings: fiveSameAnalyzerFindings() });
    // brief output with no `concise` flag uses maxFixes=5 and driftFirst=true
    // (renderBriefOutput -> renderFixPlan(result, true, 5)).
    const out = renderTerminalOutput(result, { brief: true });
    for (let i = 1; i <= 5; i++) {
      expect(out).toContain(`naming-drift-item-${i}`);
    }
  });

  it("still shows only 3 items for the concise (authenticated) summary cap", () => {
    const result = minimalScanResult({ findings: fiveSameAnalyzerFindings() });
    // renderConciseSummary caps maxFixes at 3 regardless of the diversity fix.
    const out = renderConciseSummary(result);
    let count = 0;
    for (let i = 1; i <= 5; i++) {
      if (out.includes(`naming-drift-item-${i}`)) count++;
    }
    expect(count).toBe(3);
  });
});
