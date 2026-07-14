import { describe, it, expect } from "vitest";
import { inflateRawSync } from "zlib";
import { securityConsistency } from "../../../src/drift/security-consistency.js";
import { driftFindingToFinding } from "../../../src/drift/index.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { ScanResult, Finding } from "../../../src/core/types.js";
import type { DriftFinding } from "../../../src/drift/types.js";
import { renderHtmlReport } from "../../../src/output/html.js";
import { renderCsvReport } from "../../../src/output/csv.js";
import { renderDocxReport } from "../../../src/output/docx.js";
import { buildContextMarkdown } from "../../../src/output/context-md.js";
import { renderJsonOutput } from "../../../src/output/terminal.js";
import { buildFixPromptMarkdown } from "../../../src/output/fix-prompt.js";

/**
 * Cross-surface hedge plumbing (Task 4).
 *
 * The hedged deviator copy and the appended "Double check" recommendation live
 * on the DriftFinding, which the HTML / CSV / DOCX / JSON renderers consume
 * directly, so the hedge reaches them natively (no code change) — these tests
 * pin that it does, and that a confident finding keeps the flat copy.
 * context-md renders only the neutral aggregate headline (never the deviator
 * copy or the recommendation), so it makes no confident per-route claim; its
 * output is byte-identical whether or not the route is hedged — justified below.
 */

const pyTree = (p: string, c: string) => fileWithTree(p, c, "python");
const ctxOf = (files: any[]) => ({
  files,
  totalLines: files.reduce((s: number, f: any) => s + f.lineCount, 0),
  dominantLanguage: "typescript",
});
const peerAuth = (n: number) =>
  pyTree(`src/routes/p${n}.py`, `@app.post("/p${n}")\n@requires_auth\ndef p${n}():\n    return {}\n`);

async function driftFindingsFor(kind: "hedged" | "confident"): Promise<DriftFinding[]> {
  const peers = await Promise.all([peerAuth(1), peerAuth(2), peerAuth(3), peerAuth(4)]);
  const x =
    kind === "hedged"
      ? await pyTree(
          "src/routes/x.py",
          `from auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`,
        )
      : await pyTree("src/routes/x.py", `@app.post("/x")\ndef x():\n    return {}\n`);
  return securityConsistency.detect(ctxOf([...peers, x]) as any) as DriftFinding[];
}

function mkResult(driftFindings: DriftFinding[]): ScanResult {
  const findings: Finding[] = driftFindings.map((d) => ({
    ...driftFindingToFinding(d),
    consistencyImpact: 5,
  }));
  const cat = { score: 15, maxScore: 20, locked: false, findingCount: 1, applicable: true };
  const na = { score: 20, maxScore: 20, locked: false, findingCount: 0, applicable: false };
  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "python",
      languageBreakdown: new Map(),
      totalLines: 500,
      files: [],
      intentHints: [],
    },
    compositeScore: 80,
    maxCompositeScore: 100,
    percentile: null,
    peerLanguage: "python",
    scores: {
      architecturalConsistency: { ...na },
      redundancy: { ...na },
      dependencyHealth: { ...na },
      securityPosture: { ...cat },
      intentClarity: { ...na },
    },
    hygieneScore: 0,
    maxHygieneScore: 0,
    hygieneScores: {},
    findings,
    driftFindings,
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    deepInsights: [],
    scanTimeMs: 5,
  } as unknown as ScanResult;
}

/** Inflate a DOCX (OOXML zip) and return word/document.xml as searchable text. */
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

describe("security hedge reaches every render surface", () => {
  it("HTML: hedged recommendation surfaces the hook + double check; confident stays flat", async () => {
    const hedged = renderHtmlReport(mkResult(await driftFindingsFor("hedged")), "detailed");
    expect(hedged).toContain("verify_session");
    expect(hedged.toLowerCase()).toContain("double check");

    const confident = renderHtmlReport(mkResult(await driftFindingsFor("confident")), "detailed");
    expect(confident).not.toContain("verify_session");
    expect(confident.toLowerCase()).not.toContain("double check");
  });

  it("CSV: hedged recommendation column carries the hedge; confident does not", async () => {
    const hedged = renderCsvReport(mkResult(await driftFindingsFor("hedged")));
    expect(hedged).toContain("verify_session");
    expect(hedged.toLowerCase()).toContain("double check");

    const confident = renderCsvReport(mkResult(await driftFindingsFor("confident")));
    expect(confident).not.toContain("verify_session");
    expect(confident.toLowerCase()).not.toContain("double check");
  });

  it("DOCX: hedged deviator pattern + recommendation carry the hedge; confident does not", async () => {
    const hedged = docxDocumentXml(renderDocxReport(mkResult(await driftFindingsFor("hedged"))));
    expect(hedged).toContain("verify_session");
    expect(hedged.toLowerCase()).toContain("double check");

    const confident = docxDocumentXml(renderDocxReport(mkResult(await driftFindingsFor("confident"))));
    expect(confident).not.toContain("verify_session");
    expect(confident.toLowerCase()).not.toContain("double check");
  });

  it("JSON: hedged deviator + recommendation are serialized; confident is flat", async () => {
    const hedged = renderJsonOutput(mkResult(await driftFindingsFor("hedged")));
    // The Finding metadata.recommendation carries the appended hedge sentence,
    // and locations snippet falls back to the hedged detectedPattern.
    expect(hedged).toContain("verify_session");
    expect(hedged.toLowerCase()).toContain("double check");

    const confident = renderJsonOutput(mkResult(await driftFindingsFor("confident")));
    expect(confident).not.toContain("verify_session");
    expect(confident.toLowerCase()).not.toContain("double check");
  });

  it("fix-prompt (Copy AI prompt): the recommendation carries the hedge into the AI prompt; confident does not", async () => {
    const hedgedFinding: Finding = {
      ...driftFindingToFinding((await driftFindingsFor("hedged"))[0]),
      consistencyImpact: 5,
    };
    const hedged = buildFixPromptMarkdown(hedgedFinding);
    expect(hedged).toContain("verify_session");
    expect(hedged.toLowerCase()).toContain("double check");

    const confidentFinding: Finding = {
      ...driftFindingToFinding((await driftFindingsFor("confident"))[0]),
      consistencyImpact: 5,
    };
    const confident = buildFixPromptMarkdown(confidentFinding);
    expect(confident).not.toContain("verify_session");
    expect(confident.toLowerCase()).not.toContain("double check");
  });

  it("context-md: renders only the accurate aggregate headline, so it makes no confident per-route claim (hedge-neutral, needs no change)", async () => {
    const hedged = buildContextMarkdown(mkResult(await driftFindingsFor("hedged")), "proj");
    const confident = buildContextMarkdown(mkResult(await driftFindingsFor("confident")), "proj");
    // Accurate, neutral headline in both (the unsure route legitimately counts as
    // not-authed). context-md renders neither the deviator copy nor the
    // recommendation, so it carries NO hedge tokens and NO flat confident
    // consequence — there is no false per-route claim to correct.
    for (const md of [hedged, confident]) {
      expect(md).toContain("Auth middleware missing on 1 of 5 routes");
      expect(md).not.toContain("Unprotected routes may be exposed in production");
      expect(md).not.toContain("verify_session");
      expect(md.toLowerCase()).not.toContain("double check");
    }
  });
});
