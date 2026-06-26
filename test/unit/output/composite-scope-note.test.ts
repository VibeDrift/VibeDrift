import { describe, it, expect } from "vitest";
import {
  applicableCategoryCount,
  compositeScopeNote,
  renderTerminalOutput,
} from "../../../src/output/terminal.js";
import { renderHtmlReport } from "../../../src/output/html.js";
import type { ScanResult } from "../../../src/core/types.js";

/**
 * Minimal ScanResult sufficient for renderTerminalOutput to run. The
 * category-bar renderer reads `scores`, `compositeScore`, and
 * `maxCompositeScore`; the rest is filler the renderer needs to not throw.
 */
function mkResult(overrides: Partial<ScanResult>): ScanResult {
  const emptyCat = { score: 18, maxScore: 20, locked: false, findingCount: 0, applicable: true };
  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "typescript",
      languageBreakdown: new Map(),
      totalLines: 100,
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
    maxHygieneScore: 0,
    hygieneScores: {},
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

describe("compositeScopeNote (pure)", () => {
  it("returns empty when all categories are applicable", () => {
    expect(compositeScopeNote(5, 5)).toBe("");
  });

  it("returns a scope qualifier when fewer than all categories scored", () => {
    expect(compositeScopeNote(3, 5)).toBe("(over 3 of 5 categories)");
  });

  it("returns a scope qualifier for a single-category scope", () => {
    expect(compositeScopeNote(1, 5)).toBe("(over 1 of 5 categories)");
  });
});

describe("applicableCategoryCount (pure)", () => {
  it("counts all 5 when every category is applicable", () => {
    const r = mkResult({});
    expect(applicableCategoryCount(r.scores)).toBe(5);
  });

  it("excludes N/A categories from the count", () => {
    const r = mkResult({
      scores: {
        ...mkResult({}).scores,
        dependencyHealth: { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false },
        securityPosture: { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false },
      } as ScanResult["scores"],
    });
    expect(applicableCategoryCount(r.scores)).toBe(3);
  });
});

describe("renderTerminalOutput composite scope qualifier", () => {
  it("appends 'of 5 categories' when two drift categories are N/A", () => {
    const out = renderTerminalOutput(
      mkResult({
        scores: {
          ...mkResult({}).scores,
          dependencyHealth: { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false },
          securityPosture: { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false },
        } as ScanResult["scores"],
      }),
    );
    expect(out).toContain("of 5 categories");
    expect(out).toContain("over 3 of 5 categories");
  });

  it("does NOT add the qualifier when all categories are applicable", () => {
    const out = renderTerminalOutput(mkResult({}));
    expect(out).not.toContain("of 5 categories");
  });
});

describe("renderHtmlReport composite scope qualifier (hero mirror)", () => {
  it("surfaces 'composite over 3 of 5 categories' near the hero when two are N/A", () => {
    const html = renderHtmlReport(
      mkResult({
        scores: {
          ...mkResult({}).scores,
          dependencyHealth: { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false },
          securityPosture: { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false },
        } as ScanResult["scores"],
      }),
    );
    expect(html).toContain("over 3 of 5 categories");
  });

  it("does NOT add the hero qualifier when all categories are applicable", () => {
    const html = renderHtmlReport(mkResult({}));
    expect(html).not.toContain("of 5 categories");
  });
});
