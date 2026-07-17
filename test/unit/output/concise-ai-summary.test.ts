import { describe, it, expect } from "vitest";
import { renderConciseSummary } from "../../../src/output/terminal.js";
import type { CoherenceReport, DeepInsight, ScanResult } from "../../../src/core/types.js";

// ──── Fixtures ────

function coherenceReport(overrides?: Partial<CoherenceReport>): CoherenceReport {
  return {
    coherenceGrade: "B",
    coherenceScore: 78,
    verdict: "Mostly coherent with two competing error styles.",
    rankedIssues: [
      {
        rank: 1,
        title: "Two competing error-handling styles in src/handlers",
        severity: "high",
        pattern: "throw on error",
        locations: ["src/handlers/a.ts:10"],
        why: "Half the handlers return null instead of throwing.",
        fix: "Align handlers on throw.",
      },
    ],
    strengths: ["Consistent naming"],
    ...overrides,
  };
}

function deepInsight(title: string): DeepInsight {
  return {
    category: "redundancy",
    title,
    description: "Two functions implement the same normalization.",
    severity: "medium",
    relatedFiles: ["src/a.ts", "src/b.ts"],
  };
}

/**
 * Minimal ScanResult for renderConciseSummary — same shape as the fixture in
 * floor-badge.test.ts. hygieneScores are applicable:false so renderers that
 * read every category key no-op instead of interfering with the assertions.
 */
function minimalScanResult(deep?: { coherenceReport?: CoherenceReport; deepInsights?: DeepInsight[] }): ScanResult {
  const emptyCat = { score: 18, maxScore: 20, locked: false, findingCount: 0, applicable: true };
  const naCat = { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false };
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
      architecturalConsistency: { ...naCat },
      redundancy: { ...naCat },
      dependencyHealth: { ...naCat },
      securityPosture: { ...naCat },
      intentClarity: { ...naCat },
    },
    findings: [],
    driftFindings: [],
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    deepInsights: deep?.deepInsights ?? [],
    coherenceReport: deep?.coherenceReport,
    scanTimeMs: 5,
  } as unknown as ScanResult;
}

// ──── Tests ────

describe("concise summary: AI deep-analysis block (terminal.ts renderConciseAiSummary)", () => {
  it("surfaces grade, top finding, and count on a deep result", () => {
    const out = renderConciseSummary(
      minimalScanResult({
        coherenceReport: coherenceReport(),
        deepInsights: [deepInsight("Duplicate normalization helpers"), deepInsight("Second insight")],
      }),
    );
    expect(out).toContain("AI Deep Analysis");
    expect(out).toContain("B (78/100)");
    expect(out).toContain("Top AI finding:");
    expect(out).toContain("Two competing error-handling styles in src/handlers");
    expect(out).toContain("2 AI-validated findings");
    expect(out).toContain("--format terminal");
  });

  it("renders nothing AI-related on a non-deep result", () => {
    const out = renderConciseSummary(minimalScanResult());
    expect(out).not.toContain("AI Deep Analysis");
    expect(out).not.toContain("Coherence:");
    expect(out).not.toContain("Top AI finding:");
    expect(out).not.toContain("AI-validated");
  });

  it("falls back to the top deep insight when there is no coherence report", () => {
    const out = renderConciseSummary(minimalScanResult({ deepInsights: [deepInsight("Duplicate normalization helpers")] }));
    expect(out).toContain("AI Deep Analysis");
    expect(out).not.toContain("Coherence:");
    expect(out).toContain("Top AI finding:");
    expect(out).toContain("Duplicate normalization helpers");
    expect(out).toContain("1 AI-validated finding");
    expect(out).not.toContain("1 AI-validated findings");
  });

  it("shows the grade without a top-finding line when the report has no ranked issues", () => {
    const out = renderConciseSummary(minimalScanResult({ coherenceReport: coherenceReport({ rankedIssues: [] }) }));
    expect(out).toContain("B (78/100)");
    expect(out).not.toContain("Top AI finding:");
    expect(out).toContain("Full analysis:");
  });

  it("matches the full renderer's grade string exactly", () => {
    const out = renderConciseSummary(minimalScanResult({ coherenceReport: coherenceReport({ coherenceGrade: "", coherenceScore: 61 }) }));
    // No grade letter → bare score, same fallback as renderCoherenceReport.
    expect(out).toContain("61/100");
    expect(out).not.toContain("(61/100)");
  });
});
