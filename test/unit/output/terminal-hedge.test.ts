import { describe, it, expect } from "vitest";
import { renderTerminalOutput } from "../../../src/output/terminal.js";
import type { ScanResult, Finding } from "../../../src/core/types.js";

/**
 * Terminal hedge visibility (Task 4, gate item 5).
 *
 * The terminal renders neither `detectedPattern` nor `recommendation` for drift
 * findings directly: `findingConsequence` returns the hardcoded confident
 * "Unprotected routes may be exposed in production" for every security finding.
 * For a route whose auth could not be verified (the Python body-signature
 * analyzer marked it "unsure"), that flat confident consequence is a FALSE
 * claim. These tests pin that the terminal surfaces the hedge (the hook name and
 * "double check") for a hedged finding and keeps the confident output unchanged.
 */

const emptyCat = { score: 20, maxScore: 20, locked: false, findingCount: 0, applicable: true };

function mkResult(findings: Finding[]): ScanResult {
  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "python",
      languageBreakdown: new Map(),
      totalLines: 500,
      files: [],
      intentHints: [],
    },
    compositeScore: 82,
    maxCompositeScore: 100,
    percentile: null,
    peerLanguage: "python",
    scores: {
      architecturalConsistency: { ...emptyCat, applicable: false },
      redundancy: { ...emptyCat, applicable: false },
      dependencyHealth: { ...emptyCat, applicable: false },
      securityPosture: { ...emptyCat },
      intentClarity: { ...emptyCat, applicable: false },
    },
    hygieneScore: 0,
    maxHygieneScore: 0,
    hygieneScores: {},
    findings,
    driftFindings: [],
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    deepInsights: [],
    scanTimeMs: 5,
  } as unknown as ScanResult;
}

function securityFinding(recommendation: string): Finding {
  return {
    analyzerId: "drift-security_posture",
    severity: "warning",
    message: "DRIFT: Auth middleware missing on 1 of 5 routes (after router-scope middleware inheritance)",
    locations: [{ file: "src/routes/x.py", line: 4 }],
    consistencyImpact: 5,
    tags: ["drift", "security_posture", "cross-file"],
    metadata: {
      dominantPattern: "Auth middleware applied",
      dominantFiles: ["src/routes/p1.py"],
      recommendation,
    },
  } as unknown as Finding;
}

const HEDGED_REC =
  "4 of 5 routes have Auth middleware. Review 1 unprotected routes — apply per-route middleware or move them under a router that does. " +
  "1 of these could not be confirmed: a middleware (verify_session) may authenticate them but its body could not be verified. " +
  "Double check those hooks before treating the routes as unauthenticated.";

// A finding spanning multiple languages falls back to the neutral noun.
const HEDGED_REC_NEUTRAL =
  "4 of 5 routes have Auth middleware. Review 1 unprotected routes — apply per-route middleware or move them under a router that does. " +
  "1 of these could not be confirmed: an auth hook (guard) may authenticate them but its body could not be verified. " +
  "Double check those hooks before treating the routes as unauthenticated.";

const CONFIDENT_REC =
  "4 of 5 routes have Auth middleware. Review 1 unprotected routes — apply per-route middleware or move them under a router that does.";

describe("terminal hedge visibility", () => {
  it("hedged security finding: no flat confident consequence; surfaces the hook name and 'double check'", () => {
    const out = renderTerminalOutput(mkResult([securityFinding(HEDGED_REC)]));
    // The hardcoded confident consequence must NOT be the takeaway for an unsure route.
    expect(out).not.toContain("Unprotected routes may be exposed in production");
    // The hedge MUST reach the user: the exact hook and "double check".
    expect(out).toContain("verify_session");
    expect(out.toLowerCase()).toContain("double check");
    // Language-aware noun is read back from the recommendation, not hardcoded.
    expect(out).toContain("The middleware (verify_session)");
    expect(out).not.toContain("auth hook");
  });

  it("neutral noun (multi-language finding) still renders the hook name and 'double check'", () => {
    const out = renderTerminalOutput(mkResult([securityFinding(HEDGED_REC_NEUTRAL)]));
    expect(out).toContain("The auth hook (guard)");
    expect(out.toLowerCase()).toContain("double check");
  });

  it("confident security finding (sibling): keeps the flat consequence and shows no hedge", () => {
    const out = renderTerminalOutput(mkResult([securityFinding(CONFIDENT_REC)]));
    expect(out).toContain("Unprotected routes may be exposed in production");
    expect(out.toLowerCase()).not.toContain("double check");
    expect(out).not.toContain("verify_session");
  });
});
