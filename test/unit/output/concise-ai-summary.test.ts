import { describe, it, expect } from "vitest";
import { renderConciseSummary, renderTerminalOutput } from "../../../src/output/terminal.js";
import type { CoherenceReport, Finding, ScanResult } from "../../../src/core/types.js";

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

/** AI-validated finding as the deep path merges it (ml-client/confidence.ts). */
function mlFinding(message: string): Finding {
  return {
    analyzerId: "ml-duplicate",
    severity: "warning",
    confidence: 0.9,
    message,
    locations: [{ file: "src/a.ts", line: 1 }],
    tags: ["ml", "duplicate"],
  };
}

/**
 * Minimal ScanResult for renderConciseSummary — same shape as the fixture in
 * floor-badge.test.ts. hygieneScores are applicable:false so renderers that
 * read every category key no-op instead of interfering with the assertions.
 */
function minimalScanResult(deep?: {
  coherenceReport?: CoherenceReport;
  aiSummary?: { summary: string; highlights: string[] };
  findings?: Finding[];
}): ScanResult {
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
    findings: deep?.findings ?? [],
    driftFindings: [],
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    deepInsights: [],
    coherenceReport: deep?.coherenceReport,
    aiSummary: deep?.aiSummary,
    scanTimeMs: 5,
  } as unknown as ScanResult;
}

// ──── Tests ────

describe("concise summary: AI deep-analysis block (terminal.ts renderConciseAiSummary)", () => {
  it("surfaces grade, top finding, and count on a paid deep result", () => {
    const out = renderConciseSummary(
      minimalScanResult({
        coherenceReport: coherenceReport(),
        findings: [mlFinding("Duplicate normalization helpers in src/utils"), mlFinding("Second dup")],
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
    expect(out).not.toContain("AI summary:");
    expect(out).not.toContain("Top AI finding:");
    expect(out).not.toContain("AI-validated");
  });

  it("covers the free-tier deep shape: aiSummary + ml findings, no coherence report", () => {
    const out = renderConciseSummary(
      minimalScanResult({
        aiSummary: { summary: "One redundant helper cluster dominates the drift.", highlights: [] },
        findings: [mlFinding("Duplicate normalization helpers in src/utils")],
      }),
    );
    expect(out).toContain("AI Deep Analysis");
    expect(out).not.toContain("Coherence:");
    expect(out).toContain("AI summary: One redundant helper cluster dominates the drift.");
    expect(out).toContain("Top AI finding:");
    expect(out).toContain("Duplicate normalization helpers in src/utils");
    expect(out).toContain("1 AI-validated finding");
    expect(out).not.toContain("1 AI-validated findings");
  });

  it("ignores non-ml findings when deciding whether to render", () => {
    const staticFinding: Finding = {
      analyzerId: "naming",
      severity: "warning",
      confidence: 0.9,
      message: "naming drift",
      locations: [{ file: "src/a.ts", line: 1 }],
      tags: ["drift"],
    };
    const out = renderConciseSummary(minimalScanResult({ findings: [staticFinding] }));
    expect(out).not.toContain("AI Deep Analysis");
    expect(out).not.toContain("AI-validated");
  });

  it("shows the grade without a top-finding line when the report has no ranked issues", () => {
    const out = renderConciseSummary(minimalScanResult({ coherenceReport: coherenceReport({ rankedIssues: [] }) }));
    expect(out).toContain("B (78/100)");
    expect(out).not.toContain("Top AI finding:");
    expect(out).toContain("Full analysis:");
  });

  it("uses the bare-score fallback when there is no grade letter", () => {
    const out = renderConciseSummary(minimalScanResult({ coherenceReport: coherenceReport({ coherenceGrade: "", coherenceScore: 61 }) }));
    expect(out).toContain("61/100");
    expect(out).not.toContain("(61/100)");
  });

  it("renders the same grade string as the full coherence renderer", () => {
    const result = minimalScanResult({ coherenceReport: coherenceReport({ coherenceGrade: "C", coherenceScore: 55 }) });
    const concise = renderConciseSummary(result);
    const full = renderTerminalOutput(result);
    expect(concise).toContain("C (55/100)");
    expect(full).toContain("C (55/100)");
  });
});
