import { describe, it, expect } from "vitest";
import { renderJsonOutput } from "../../../src/output/terminal.js";
import type { DriftFindingReport, ScanResult } from "../../../src/core/types.js";

/**
 * P1: --format json is the machine surface for CI/tooling consumers, and
 * every OTHER renderer (HTML, CSV, DOCX) already includes drift findings and
 * the Code DNA result. renderJsonOutput dropped both, silently making the
 * one machine-readable format the least complete one.
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

function driftFinding(): DriftFindingReport {
  return {
    detector: "naming-convention",
    driftCategory: "architectural_consistency",
    severity: "warning",
    confidence: 0.9,
    finding: "3 of 10 files use snake_case while the rest use camelCase",
    dominantPattern: "camelCase",
    dominantCount: 7,
    totalRelevantFiles: 10,
    consistencyScore: 70,
    deviatingFiles: [{ path: "src/legacy.ts", detectedPattern: "snake_case", evidence: [{ line: 3, code: "let user_id = 1;" }] }],
    recommendation: "Rename to camelCase to match the dominant convention.",
  };
}

describe("renderJsonOutput includes driftFindings but not the raw CodeDnaResult", () => {
  it("includes non-empty driftFindings", () => {
    const result = minimalScanResult({ driftFindings: [driftFinding()] });
    const parsed = JSON.parse(renderJsonOutput(result));
    expect(parsed.driftFindings).toHaveLength(1);
    expect(parsed.driftFindings[0].finding).toContain("snake_case");
  });

  it("omits codeDnaResult (it embeds every extracted function's full source body)", () => {
    const dna = {
      functions: [{ name: "secret", rawBody: "return process.env.SECRET;" }],
      findings: [],
      duplicateGroups: [{ groupId: "g1", functions: [] }],
    };
    const result = minimalScanResult({ codeDnaResult: dna as unknown as ScanResult["codeDnaResult"] });
    const out = renderJsonOutput(result);
    expect(JSON.parse(out).codeDnaResult).toBeUndefined();
    expect(out).not.toContain("process.env.SECRET");
  });

  it("includes teaseMessages and reimplementationCandidates when present", () => {
    const result = minimalScanResult({
      teaseMessages: ["3 more findings available with deep scan"],
      reimplementationCandidates: 2,
    });
    const parsed = JSON.parse(renderJsonOutput(result));
    expect(parsed.teaseMessages).toEqual(["3 more findings available with deep scan"]);
    expect(parsed.reimplementationCandidates).toBe(2);
  });

  it("still includes driftFindings as an empty array when there are none (not silently omitted)", () => {
    const parsed = JSON.parse(renderJsonOutput(minimalScanResult()));
    expect(parsed.driftFindings).toEqual([]);
  });
});
