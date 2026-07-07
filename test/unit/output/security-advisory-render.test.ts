import { describe, it, expect } from "vitest";
import { inflateRawSync } from "zlib";
import { renderTerminalOutput } from "../../../src/output/terminal.js";
import { renderHtmlReport } from "../../../src/output/html.js";
import { renderCsvReport } from "../../../src/output/csv.js";
import { renderDocxReport } from "../../../src/output/docx.js";
import { applySecurityMinPeerFloor, MIN_SECURITY_PEERS, computeScores } from "../../../src/scoring/engine.js";
import { scoredDriftView, driftFindingToFinding, attachEngineComposite } from "../../../src/drift/index.js";
import type { DriftFinding } from "../../../src/drift/types.js";
import type { ScanResult, PerFileScore } from "../../../src/core/types.js";

/**
 * Render-level regression suite for the min-peer-floor consistency fix.
 *
 * A route-consistency security drift finding whose peer sample is below
 * MIN_SECURITY_PEERS is demoted to an advisory hygiene finding on the `Finding`
 * track. The ROOT fix (`scoredDriftView` in src/drift/index.ts, wired at the
 * scan source in buildScanResult) removes such findings from the DRIFT
 * representation entirely (both `result.driftFindings` and `result.driftScores`),
 * so every raw-driftFindings consumer (drift findings library, codebase intent,
 * coherence heatmap, CSV/DOCX drift sections) is consistent with the category's
 * N/A WITHOUT a per-widget gate. The finding still surfaces as advisory via
 * `result.findings` (hygiene-kind), so we are never silent.
 *
 * These fixtures are built through the SAME functions the scan pipeline uses
 * (`scoredDriftView`, `applySecurityMinPeerFloor`, `computeScores`) from a RAW
 * drift set that INCLUDES the below-floor finding, so the tests exercise the
 * source exclusion, not a pre-massaged fixture.
 */

const RAW_MESSAGE = "DRIFT: 1 mutating route(s) lack auth while the codebase uses auth elsewhere";
const TOTAL_LINES = 500;

// Below MIN_SECURITY_PEERS (4): the "small repo, 2-3 mutating routes, auth gap".
// consistencyScore is 67% (>= 60) on purpose: high enough that the finding WOULD
// pass extractIntentPatterns' consistency gate and appear as a "Security"
// codebase-intent card if it were not excluded from the drift representation.
// That is what makes the codebase-intent test able to catch a leak.
function rawThinSecurity(): DriftFinding {
  return {
    detector: "security_posture",
    subCategory: "Auth middleware",
    driftCategory: "security_posture",
    severity: "warning",
    confidence: 0.6,
    finding: "1 mutating route(s) lack auth while the codebase uses auth elsewhere",
    dominantPattern: "auth on mutating routes",
    dominantCount: 2,
    totalRelevantFiles: 3,
    consistencyScore: 67,
    deviatingFiles: [
      { path: "src/routes/admin.ts", detectedPattern: "POST /admin no auth", evidence: [{ line: 12, code: "POST /admin" }] },
    ],
    dominantFiles: [],
    recommendation: "Add auth middleware to this route, or confirm it is intentionally public.",
  };
}

// A security sub-check finding with a configurable peer sample, used to build
// the multi-sub-check scenario (auth voted over many routes, validation over a
// subset). subCategory distinguishes the sub-checks.
function rawSecuritySub(subCategory: string, totalRelevantFiles: number, dominantCount: number): DriftFinding {
  return {
    detector: "security_posture",
    subCategory,
    driftCategory: "security_posture",
    severity: "warning",
    confidence: 0.6,
    finding: `${subCategory}: ${totalRelevantFiles - dominantCount} route(s) deviate`,
    dominantPattern: subCategory,
    dominantCount,
    totalRelevantFiles,
    consistencyScore: Math.round((dominantCount / totalRelevantFiles) * 100),
    deviatingFiles: [
      { path: "src/routes/admin.ts", detectedPattern: `${subCategory} missing`, evidence: [{ line: 3, code: "handler" }] },
    ],
    dominantFiles: [],
    recommendation: `Apply ${subCategory} consistently.`,
  };
}

// An unrelated architectural finding at/above any floor, carrying a subCategory
// so it produces a heatmap column and an intent card (proving those widgets
// render and that ONLY the security finding is absent, not everything).
function rawArch(): DriftFinding {
  return {
    detector: "architectural_consistency",
    subCategory: "data_access",
    driftCategory: "architectural_consistency",
    severity: "warning",
    confidence: 0.8,
    finding: "src/order.ts uses raw SQL while peers use a repository",
    dominantPattern: "repository",
    dominantCount: 5,
    totalRelevantFiles: 6,
    consistencyScore: 83,
    deviatingFiles: [
      { path: "src/order.ts", detectedPattern: "raw SQL", evidence: [{ line: 4, code: "db.query(...)" }] },
    ],
    dominantFiles: ["src/repo.ts"],
    recommendation: "Use the repository pattern.",
  };
}

/**
 * Build a ScanResult exactly the way buildScanResult now does: floor the mapped
 * findings for result.findings (advisory surfacing), and derive the rendered
 * DRIFT representation via scoredDriftView (below-floor security excluded).
 * perFileScores is populated from the findings' files so the coherence heatmap
 * actually renders (the previous fixture used an empty Map, making the heatmap
 * blind to this bug).
 */
function mkPipelineResult(rawDrift: DriftFinding[]): ScanResult {
  const mapped = rawDrift.map(driftFindingToFinding);
  const floored = applySecurityMinPeerFloor(mapped);
  const { scores, hygieneScores, hygieneScore, maxHygieneScore, compositeScore, maxCompositeScore } =
    computeScores(floored, TOTAL_LINES);
  const rendered = scoredDriftView(rawDrift, TOTAL_LINES);

  const perFileScores = new Map<string, PerFileScore>();
  for (const f of floored) {
    const file = f.locations[0]?.file;
    if (!file) continue;
    if (!perFileScores.has(file)) {
      perFileScores.set(file, {
        file,
        findings: floored.filter((x) => x.locations[0]?.file === file),
        score: 62,
        maxScore: 100,
      });
    }
  }

  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "typescript",
      languageBreakdown: new Map([["typescript", { files: 3 }]]),
      totalLines: TOTAL_LINES,
      files: [],
      intentHints: [],
    },
    compositeScore,
    maxCompositeScore,
    percentile: null,
    peerLanguage: "typescript",
    scores,
    hygieneScore,
    maxHygieneScore,
    hygieneScores,
    findings: floored,
    driftFindings: rendered.driftFindings,
    driftScores: attachEngineComposite(rendered.driftScores, compositeScore),
    perFileScores,
    teaseMessages: [],
    deepInsights: [],
    scanTimeMs: 5,
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

/** Strip XML tags so section text can be searched as plain prose. */
function docxText(zip: Buffer): string {
  return docxDocumentXml(zip).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Slice a labelled HTML section (from one heading up to the next). */
function htmlSection(html: string, fromHeading: string, toHeading: string): string {
  const start = html.indexOf(fromHeading);
  const end = html.indexOf(toHeading, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

// The below-floor case: only security finding is thin, plus an unrelated arch
// finding so the drift widgets have something legitimate to render.
const THIN_PLUS_ARCH = () => mkPipelineResult([rawThinSecurity(), rawArch()]);

describe("min-peer-floor render consistency (root fix)", () => {
  it("computeScores marks Security Consistency N/A on the drift track (sanity)", () => {
    expect(THIN_PLUS_ARCH().scores.securityPosture.applicable).toBe(false);
  });

  describe("scoredDriftView (source exclusion)", () => {
    it("drops a below-floor security finding while keeping at/above-floor and unrelated findings", () => {
      const { driftFindings } = scoredDriftView([rawThinSecurity(), rawArch()], TOTAL_LINES);
      expect(driftFindings.map((d) => d.driftCategory)).not.toContain("security_posture");
      expect(driftFindings.map((d) => d.driftCategory)).toContain("architectural_consistency");
    });

    it("multi-sub-check: keeps auth (n>=4), drops validation (n<4), and driftScores counts only the scored sub-finding", () => {
      const auth = rawSecuritySub("Auth middleware", 5, 3); // n=5 >= floor -> scored
      const validation = rawSecuritySub("Input validation", 2, 1); // n=2 < floor -> below
      const { driftFindings, driftScores } = scoredDriftView([auth, validation, rawArch()], TOTAL_LINES);

      const secSubs = driftFindings.filter((d) => d.driftCategory === "security_posture").map((d) => d.subCategory);
      expect(secSubs).toContain("Auth middleware");
      expect(secSubs).not.toContain("Input validation");

      // driftScores.security_posture reflects ONLY the scored sub-finding, so the
      // CSV/DOCX score-row count matches what the drift findings list shows.
      expect(driftScores.security_posture.findings).toBe(1);
    });

    it("all-below-floor security yields zero security drift findings and an empty-category breakdown", () => {
      const { driftFindings, driftScores } = scoredDriftView([rawSecuritySub("Auth middleware", 2, 1)], TOTAL_LINES);
      expect(driftFindings.length).toBe(0);
      expect(driftScores.security_posture.findings).toBe(0);
    });
  });

  describe("terminal", () => {
    it("shows Security Consistency N/A in the drift pane and surfaces the finding in the hygiene pane", () => {
      const out = renderTerminalOutput(THIN_PLUS_ARCH());
      expect(out).toContain("Security Consistency (N/A)");
      const hygieneBannerIdx = out.indexOf("Hygiene findings");
      const messageIdx = out.indexOf(RAW_MESSAGE);
      expect(hygieneBannerIdx).toBeGreaterThan(-1);
      expect(messageIdx).toBeGreaterThan(hygieneBannerIdx);
    });
  });

  describe("html (detailed report)", () => {
    it("drift findings library: no security card, arch card present, advisory surfaced in hygiene", () => {
      const html = renderHtmlReport(THIN_PLUS_ARCH(), "detailed");
      const library = htmlSection(html, "Drift findings", "File ranking");
      expect(library).not.toContain(rawThinSecurity().finding);
      expect(library).toContain(rawArch().finding);
      // Advisory finding still appears somewhere (the Hygiene section reads
      // result.findings, which carries the demoted id).
      expect(html).toContain(RAW_MESSAGE);
    });

    it("codebase intent: no Security pattern card, unrelated Data Access card present", () => {
      const html = renderHtmlReport(THIN_PLUS_ARCH(), "detailed");
      const intent = htmlSection(html, "Codebase intent", "Intent coherence");
      expect(intent).not.toContain("Security");
      expect(intent).toContain("Data Access");
    });

    it("coherence heatmap: renders (non-blind) with a Data Access column and NO Security column", () => {
      const html = renderHtmlReport(THIN_PLUS_ARCH(), "detailed");
      const heatmap = htmlSection(html, "Intent coherence", "Drift findings");
      // The heatmap actually rendered a category column (the old fixture used an
      // empty perFileScores, so it rendered "" and could never catch this).
      expect(heatmap).toContain('hm-cat">Data Access');
      // The below-floor security finding produced NO Security column.
      expect(heatmap).not.toContain('hm-cat">Security');
    });
  });

  describe("csv export", () => {
    it("DRIFT FINDINGS omits the thin finding; ALL FINDINGS surfaces it as advisory; DRIFT SCORES omits the security row", () => {
      const csv = renderCsvReport(THIN_PLUS_ARCH());

      const driftFindingsStart = csv.indexOf("DRIFT FINDINGS");
      const allFindingsStart = csv.indexOf("ALL FINDINGS");
      const driftScoresStart = csv.indexOf("DRIFT SCORES");
      expect(driftScoresStart).toBeGreaterThan(-1);
      expect(driftFindingsStart).toBeGreaterThan(driftScoresStart);
      expect(allFindingsStart).toBeGreaterThan(driftFindingsStart);

      const driftScoresSection = csv.slice(driftScoresStart, driftFindingsStart);
      expect(driftScoresSection).not.toContain("security_posture");
      expect(driftScoresSection).toContain("architectural_consistency");

      const driftFindingsSection = csv.slice(driftFindingsStart, allFindingsStart);
      expect(driftFindingsSection).not.toContain("security_posture");
      expect(driftFindingsSection).toContain("raw SQL");

      const allFindingsSection = csv.slice(allFindingsStart);
      expect(allFindingsSection).toContain("security_posture-advisory");
      expect(allFindingsSection).toContain(RAW_MESSAGE);
    });
  });

  describe("docx export", () => {
    it("Security score-table row is N/A, thin finding excluded from DRIFT FINDINGS, surfaced in general findings", () => {
      const text = docxText(renderDocxReport(THIN_PLUS_ARCH()));

      expect(text).toContain("Security Consistency N/A N/A N/A");

      const driftStart = text.indexOf("3. DRIFT FINDINGS");
      const driftEnd = text.indexOf("FILE RANKING");
      expect(driftStart).toBeGreaterThan(-1);
      expect(driftEnd).toBeGreaterThan(driftStart);
      const driftSection = text.slice(driftStart, driftEnd);
      expect(driftSection).not.toContain("1 mutating route(s) lack auth");
      expect(driftSection).toContain("raw SQL");
      expect(driftSection).toContain("1 cross-file contradictions detected");

      const staticSection = text.slice(text.indexOf("STATIC ANALYSIS FINDINGS"));
      expect(staticSection).toContain("security_posture-advisory");
      expect(staticSection).toContain("1 mutating route(s) lack auth");
    });

    it("does not present the demoted finding's pattern as established codebase intent", () => {
      const text = docxText(renderDocxReport(THIN_PLUS_ARCH()));
      const intentSection = text.slice(text.indexOf("CODEBASE INTENT"), text.indexOf("3. DRIFT FINDINGS"));
      expect(intentSection).not.toContain("SECURITY");
      expect(intentSection).toContain("ARCHITECTURAL CONSISTENCY");
    });
  });

  describe("at/above-floor findings are unaffected", () => {
    it("a well-sampled (n>=MIN_SECURITY_PEERS) security finding stays a scored drift finding", () => {
      const atFloor = rawSecuritySub("Auth middleware", MIN_SECURITY_PEERS, 3);
      atFloor.finding = "1 mutating route(s) lack auth (at floor)";
      const result = mkPipelineResult([atFloor]);

      expect(result.scores.securityPosture.applicable).toBe(true);
      const html = renderHtmlReport(result, "detailed");
      const library = htmlSection(html, "Drift findings", "File ranking");
      expect(library).toContain("1 mutating route(s) lack auth (at floor)");
    });
  });
});
