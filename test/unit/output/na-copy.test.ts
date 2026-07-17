import { describe, it, expect } from "vitest";
import { inflateRawSync } from "node:zlib";
import { renderTerminalOutput } from "../../../src/output/terminal.js";
import { renderHtmlReport } from "../../../src/output/html.js";
import { renderDocxReport } from "../../../src/output/docx.js";
import { SECURITY_ADVISORY_ID } from "../../../src/scoring/engine.js";
import type { Finding, ScanResult } from "../../../src/core/types.js";

// Pins the honest N/A copy (issue #34 D1) and the three-sub-convention gloss
// (D3): "no findings in this repo" read as a clean bill for a check that never
// ran, and the gloss omitted rate limiting, the third security sub-convention.

function advisoryFinding(): Finding {
  return {
    analyzerId: SECURITY_ADVISORY_ID,
    severity: "info",
    confidence: 0.5,
    message: "Auth middleware missing on 1 of 2 routes (below peer floor, advisory)",
    locations: [{ file: "src/routes.ts", line: 4 }],
    tags: ["security", "drift"],
  };
}

function minimalScanResult(overrides?: Partial<ScanResult>): ScanResult {
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
      dependencyHealth: { ...naCat },
      securityPosture: { ...naCat },
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
    deepInsights: [],
    scanTimeMs: 5,
    ...overrides,
  } as unknown as ScanResult;
}

describe("N/A copy is honest about WHY there is no score (terminal)", () => {
  it("says nothing-to-measure, never 'no findings', when no surface exists", () => {
    const out = renderTerminalOutput(minimalScanResult());
    expect(out).toContain("N/A — nothing to measure in this repo");
    expect(out).not.toContain("no findings in this repo");
  });

  it("names the advisory demotion when the floor demoted the findings", () => {
    const out = renderTerminalOutput(minimalScanResult({ findings: [advisoryFinding()] }));
    expect(out).toContain("not scored (evidence below floor); findings kept as advisory");
    expect(out).not.toContain("no findings in this repo");
    // No locational claim: this line also renders in the concise summary,
    // which has no findings list below it.
    expect(out).not.toContain("advisory findings below");
  });

  it("gloss names all three security sub-conventions", () => {
    const out = renderTerminalOutput(minimalScanResult());
    expect(out).toContain("auth, validation, and rate-limit patterns");
  });
});

describe("N/A copy is honest about WHY there is no score (HTML)", () => {
  it("says nothing-to-measure when no surface exists", () => {
    const html = renderHtmlReport(minimalScanResult(), "summary", {}, { isPaid: false });
    expect(html).toContain("Nothing to measure in this repo");
    expect(html).not.toContain("No findings in this repo");
  });

  it("names the advisory demotion when the floor demoted the findings", () => {
    const html = renderHtmlReport(minimalScanResult({ findings: [advisoryFinding()] }), "summary", {}, { isPaid: false });
    expect(html).toContain("Not scored (evidence below floor) — findings kept as advisory");
    expect(html).not.toContain("No findings in this repo");
  });

  it("gloss names all three security sub-conventions", () => {
    const html = renderHtmlReport(minimalScanResult(), "summary", {}, { isPaid: false });
    expect(html).toContain("auth, validation, and rate-limit patterns");
  });
});

// ──── Issue #34 C5: per-file Drift/Static tallies are kind-based ────

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

describe("per-file Drift/Static tallies match the headline's kind-based split", () => {
  it("a demoted advisory finding (hygiene-kind, still tagged drift) tallies as Static", () => {
    const adv = advisoryFinding();
    const result = minimalScanResult({
      findings: [adv],
      perFileScores: new Map([
        ["src/routes.ts", { file: "src/routes.ts", findings: [adv], score: 80, maxScore: 100 }],
      ]),
    } as Partial<ScanResult>);
    const text = docxDocumentXml(renderDocxReport(result)).replace(/<[^>]+>/g, " ");
    // Per-file row: path, score, Drift count, Static count. The advisory
    // finding is hygiene-kind, so Drift must be 0 and Static 1 — the same
    // split the headline sections use (it renders under Static Analysis).
    expect(text).toMatch(/src\/routes\.ts\s+80\/100\s+0\s+1\b/);
  });
});
