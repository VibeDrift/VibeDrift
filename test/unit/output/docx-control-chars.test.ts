import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { renderDocxReport } from "../../../src/output/docx.js";
import type { DriftFindingReport, ScanResult } from "../../../src/core/types.js";

/**
 * P2: docx.ts's xml() helper escaped XML markup characters (&, <, >) but not
 * the raw control characters XML 1.0 forbids outright. A source snippet
 * containing e.g. \x0B (vertical tab) or \x00 (NUL) — plausible in scanned
 * source, especially binary-ish or minified files — would be emitted
 * verbatim into word/document.xml, producing a document Word refuses to
 * open (or silently repairs, dropping content). xml() must strip
 * /[\x00-\x08\x0B\x0C\x0E-\x1F]/g before entity-escaping.
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

/** Inflate a DOCX (OOXML zip) and return word/document.xml as text. */
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

function driftFindingWithControlChar(): DriftFindingReport {
  return {
    detector: "naming-convention",
    driftCategory: "architectural_consistency",
    severity: "warning",
    confidence: 0.9,
    finding: "snippet with a control char",
    dominantPattern: "camelCase",
    dominantCount: 7,
    totalRelevantFiles: 10,
    consistencyScore: 70,
    deviatingFiles: [
      {
        path: "src/legacy.ts",
        detectedPattern: "snake_case",
        // \x0B (vertical tab) — XML-1.0-illegal control char.
        evidence: [{ line: 3, code: "let user_id\x0B = 1;" }],
      },
    ],
    recommendation: "Rename to camelCase.",
  };
}

describe("docx xml() strips XML-1.0-illegal control characters", () => {
  it("produces a document.xml with no raw control char, and the DOCX still unzips/inflates cleanly", () => {
    const result = minimalScanResult({ driftFindings: [driftFindingWithControlChar()] });
    const zip = renderDocxReport(result);
    const xmlText = docxDocumentXml(zip);

    // No XML-1.0-illegal control char anywhere in the produced document part.
    // eslint-disable-next-line no-control-regex
    expect(xmlText).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    // The surrounding text still made it through, just without the illegal char.
    expect(xmlText).toContain("let user_id");
    expect(xmlText).toContain("= 1;");
  });

  it("still entity-escapes ordinary markup characters alongside the control-char strip", () => {
    const result = minimalScanResult({
      driftFindings: [
        {
          ...driftFindingWithControlChar(),
          deviatingFiles: [
            {
              path: "src/legacy.ts",
              detectedPattern: "snake_case",
              evidence: [{ line: 3, code: "if (a \x0B< b && b > c) {}" }],
            },
          ],
        },
      ],
    });
    const xmlText = docxDocumentXml(renderDocxReport(result));
    expect(xmlText).toContain("&lt;");
    expect(xmlText).toContain("&gt;");
    // eslint-disable-next-line no-control-regex
    expect(xmlText).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  });
});
