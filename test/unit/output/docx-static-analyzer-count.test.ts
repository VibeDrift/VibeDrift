import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { renderDocxReport } from "../../../src/output/docx.js";
import { createAnalyzerRegistry } from "../../../src/analyzers/index.js";
import type { ScanResult } from "../../../src/core/types.js";

/**
 * P3: docx.ts hardcoded `${13} static analyzers` in the STATIC ANALYSIS
 * FINDINGS section header, which silently goes stale whenever an analyzer is
 * added or removed from the registry. The fix derives the count from
 * createAnalyzerRegistry().length instead.
 */

function minimalScanResult(overrides?: Partial<ScanResult>): ScanResult {
  const emptyCat = { score: 18, maxScore: 20, locked: false, findingCount: 0, applicable: true };
  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "typescript",
      languageBreakdown: new Map([["typescript", { files: 3, lines: 1000 }]]),
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
    hygieneScore: 55.5,
    maxHygieneScore: 100,
    hygieneScores: {
      architecturalConsistency: { ...emptyCat },
      redundancy: { ...emptyCat },
      dependencyHealth: { ...emptyCat },
      securityPosture: { ...emptyCat },
      intentClarity: { ...emptyCat },
    },
    findings: [
      {
        analyzerId: "complexity",
        severity: "warning",
        confidence: 0.7,
        message: "Function too complex",
        locations: [{ file: "src/big.ts", line: 10 }],
        tags: [],
      },
    ],
    driftFindings: [],
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    deepInsights: [],
    scanTimeMs: 5,
    ...overrides,
  } as unknown as ScanResult;
}

function docxDocumentXml(zip: Buffer): string {
  let off = 0;
  while (off + 4 <= zip.length && zip.readUInt32LE(off) === 0x04034b50) {
    const compSize = zip.readUInt32LE(off + 18);
    const nameLen = zip.readUInt16LE(off + 26);
    const extraLen = zip.readUInt16LE(off + 28);
    const name = zip.slice(off + 30, off + 30 + nameLen).toString("utf-8");
    const dataStart = off + 30 + nameLen + extraLen;
    const data = zip.slice(dataStart, dataStart + compSize);
    if (name === "word/document.xml") return inflateRawSync(data).toString("utf-8");
    off = dataStart + compSize;
  }
  throw new Error("word/document.xml not found in DOCX");
}

describe("docx STATIC ANALYSIS FINDINGS header derives the analyzer count from the registry", () => {
  it("matches createAnalyzerRegistry().length, not a hardcoded literal", () => {
    const expectedCount = createAnalyzerRegistry().length;
    const text = docxDocumentXml(renderDocxReport(minimalScanResult())).replace(/<[^>]+>/g, " ");
    expect(text).toContain(`static analyzers`);
    expect(text).toMatch(new RegExp(`findings from ${expectedCount} static analyzers`));
  });

  it("also surfaces the Hygiene Score scalar in that section", () => {
    const text = docxDocumentXml(renderDocxReport(minimalScanResult())).replace(/<[^>]+>/g, " ");
    expect(text).toContain("Hygiene Score: 55.5/100");
  });
});
