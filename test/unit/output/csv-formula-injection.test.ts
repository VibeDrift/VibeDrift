import { describe, it, expect } from "vitest";
import { renderCsvReport } from "../../../src/output/csv.js";
import type { Finding, ScanResult } from "../../../src/core/types.js";

/**
 * P0 (CWE-1236): a CSV cell whose text starts with =, +, -, @, tab, or CR can
 * be interpreted by Excel/Sheets as a formula when the sheet is opened. Since
 * cell text here is repo-controlled (file paths, TODO text, finding
 * messages), an attacker who controls source under scan could get code to
 * execute in a reviewer's spreadsheet app. csvEscape must prefix a single
 * quote on any such leading character before its existing quote-wrap logic.
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

function findingWithMessage(message: string): Finding {
  return {
    analyzerId: "todo-density",
    severity: "info",
    confidence: 0.8,
    message,
    locations: [{ file: "src/a.ts", line: 1 }],
    tags: [],
  };
}

describe("csv formula-injection guard (csvEscape)", () => {
  it("neutralizes a formula-leading finding message with a leading single quote", () => {
    const payload = "=cmd|' /C calc'!A0";
    const result = minimalScanResult({ findings: [findingWithMessage(payload)] });
    const csv = renderCsvReport(result);
    // The raw formula must never appear un-neutralized (it would be a bare
    // "=cmd|..." cell, interpreted as a formula on open).
    expect(csv).not.toMatch(/(?<!')=cmd\|/);
    expect(csv).toContain("'=cmd|");
  });

  it.each(["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\t=evil", "\revil"])(
    "prefixes a leading %j with a single quote",
    (payload) => {
      const result = minimalScanResult({ findings: [findingWithMessage(payload)] });
      const csv = renderCsvReport(result);
      expect(csv).toContain("'" + payload);
    },
  );

  it("does not touch text that doesn't start with a formula-leading char", () => {
    const result = minimalScanResult({ findings: [findingWithMessage("normal message")] });
    const csv = renderCsvReport(result);
    expect(csv).toContain("normal message");
    expect(csv).not.toContain("'normal message");
  });

  it("prefixes ALL leading '-' cells, including ordinary negative numbers rendered as text — an intentional safe-over-ergonomic choice, since csvEscape only ever sees stringified cell values and can't distinguish a negative number from a formula", () => {
    const result = minimalScanResult({ findings: [findingWithMessage("-42 findings avoided")] });
    const csv = renderCsvReport(result);
    expect(csv).toContain("'-42 findings avoided");
  });

  it("still quote-wraps when the neutralized value also contains a comma", () => {
    const result = minimalScanResult({ findings: [findingWithMessage("=A1,B1")] });
    const csv = renderCsvReport(result);
    expect(csv).toContain(`"'=A1,B1"`);
  });
});
