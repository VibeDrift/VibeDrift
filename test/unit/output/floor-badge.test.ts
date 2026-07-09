import { describe, it, expect } from "vitest";
import { hasFloorTrip } from "../../../src/output/floor-badge.js";
import { renderTerminalOutput, renderConciseSummary } from "../../../src/output/terminal.js";
import { renderHtmlReport, buildEmbeddedPrompts } from "../../../src/output/html.js";
import { buildFixPromptMarkdown } from "../../../src/output/fix-prompt.js";
import { computeScores } from "../../../src/scoring/engine.js";
import type { Finding, ScanResult } from "../../../src/core/types.js";

// ──── Fixture findings ────

function driftFinding(): Finding {
  // A real drift-kind finding so the composite starts below 100 — makes the
  // grade-invariance assertion meaningful rather than a vacuous 100 === 100.
  return {
    analyzerId: "naming",
    severity: "error",
    confidence: 0.9,
    message: "naming drift",
    locations: [{ file: "src/a.ts", line: 1 }],
    tags: [],
  };
}

function securityFinding(): Finding {
  // A plain (non-floor) security finding — must NOT trip the badge.
  return {
    analyzerId: "security",
    severity: "info",
    confidence: 0.5,
    message: "URL constructed from variable in src/data.ts:1",
    locations: [{ file: "src/data.ts", line: 1 }],
    tags: ["security", "ssrf", "demoted"],
  };
}

function privateKeyFloorFinding(): Finding {
  return {
    analyzerId: "security-floor",
    severity: "error",
    confidence: 0.98,
    message: "Private key embedded in source code in src/key.ts:1",
    locations: [{ file: "src/key.ts", line: 1 }],
    tags: ["security", "secrets", "critical"],
  };
}

function awsKeyFloorFinding(): Finding {
  return {
    analyzerId: "security-floor",
    severity: "error",
    confidence: 0.95,
    message: "AWS access key ID detected in creds.ts:1",
    locations: [{ file: "creds.ts", line: 1 }],
    tags: ["security", "secrets", "aws"],
  };
}

function tlsFloorFinding(): Finding {
  return {
    analyzerId: "security-floor",
    severity: "error",
    confidence: 0.95,
    message: "TLS certificate verification disabled in client.go:4",
    locations: [{ file: "client.go", line: 4 }],
    tags: ["security", "tls"],
  };
}

function evalTaintFinding(): Finding {
  // Shaped like taintFindings() in src/codedna/taint-analysis.ts for a
  // direct eval() sink (category code_injection, label "code evaluation").
  return {
    analyzerId: "codedna-taint",
    severity: "error",
    confidence: 0.75,
    message:
      "Unsanitized URL parameter reaches code evaluation in handleInput(): input (line 3) → code evaluation (line 5)",
    locations: [
      { file: "src/handler.ts", line: 3, snippet: "input = c.Param(...)" },
      { file: "src/handler.ts", line: 5, snippet: "eval(input)" },
    ],
    tags: ["codedna", "taint", "security"],
  };
}

function execTaintFinding(): Finding {
  // Direct command_injection sink (execSync).
  return {
    analyzerId: "codedna-taint",
    severity: "error",
    confidence: 0.75,
    message:
      "Unsanitized request body reaches sync command execution in runCmd(): body (line 8) → sync command execution (line 10)",
    locations: [
      { file: "src/runner.ts", line: 8, snippet: "body = req.body.cmd" },
      { file: "src/runner.ts", line: 10, snippet: "execSync(body)" },
    ],
    tags: ["codedna", "taint", "security"],
  };
}

function oneHopInjectionTaintFinding(): Finding {
  // Shaped like the one-hop finding in findOneHopFlows(), whose sink.type
  // embeds the raw category string (not the human label).
  return {
    analyzerId: "codedna-taint",
    severity: "warning",
    confidence: 0.75,
    message:
      "Unsanitized URL parameter reaches runShell() reaches command_injection sink in handler(): id (line 2) → runShell() reaches command_injection sink (line 6)",
    locations: [
      { file: "src/handler.ts", line: 2 },
      { file: "src/handler.ts", line: 6 },
    ],
    tags: ["codedna", "taint", "security"],
  };
}

function sqlTaintFinding(): Finding {
  // codedna-taint, but sql_injection — must NOT trip the badge.
  return {
    analyzerId: "codedna-taint",
    severity: "error",
    confidence: 0.75,
    message:
      "Unsanitized query parameter reaches SQL query in getUser(): id (line 2) → SQL query (line 4)",
    locations: [
      { file: "src/db.ts", line: 2 },
      { file: "src/db.ts", line: 4 },
    ],
    tags: ["codedna", "taint", "security"],
  };
}

// ──── hasFloorTrip ────

describe("hasFloorTrip", () => {
  it("is not tripped for an empty finding set", () => {
    expect(hasFloorTrip([])).toEqual({ tripped: false, reasons: [] });
  });

  it("is not tripped by a demoted (non-floor) 'security' finding", () => {
    const result = hasFloorTrip([securityFinding()]);
    expect(result.tripped).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("is not tripped by a codedna-taint finding whose sink is sql_injection", () => {
    const result = hasFloorTrip([sqlTaintFinding()]);
    expect(result.tripped).toBe(false);
  });

  it("trips on a security-floor private-key finding with reason 'private key in source'", () => {
    const result = hasFloorTrip([privateKeyFloorFinding()]);
    expect(result.tripped).toBe(true);
    expect(result.reasons).toContain("private key in source");
  });

  it("trips on a security-floor AWS-key finding", () => {
    const result = hasFloorTrip([awsKeyFloorFinding()]);
    expect(result.tripped).toBe(true);
    expect(result.reasons.length).toBe(1);
  });

  it("trips on a security-floor TLS finding", () => {
    const result = hasFloorTrip([tlsFloorFinding()]);
    expect(result.tripped).toBe(true);
    expect(result.reasons[0]).toMatch(/TLS certificate verification disabled/i);
  });

  it("trips on a codedna-taint eval() (code_injection) finding with reason 'unsanitized input reaches eval/exec'", () => {
    const result = hasFloorTrip([evalTaintFinding()]);
    expect(result.tripped).toBe(true);
    expect(result.reasons).toContain("unsanitized input reaches eval/exec");
  });

  it("trips on a codedna-taint execSync() (command_injection) finding", () => {
    const result = hasFloorTrip([execTaintFinding()]);
    expect(result.tripped).toBe(true);
    expect(result.reasons).toContain("unsanitized input reaches eval/exec");
  });

  it("trips on a one-hop codedna-taint finding whose message embeds the raw command_injection category", () => {
    const result = hasFloorTrip([oneHopInjectionTaintFinding()]);
    expect(result.tripped).toBe(true);
    expect(result.reasons).toContain("unsanitized input reaches eval/exec");
  });

  it("dedupes reasons across multiple floor findings of the same kind", () => {
    const result = hasFloorTrip([awsKeyFloorFinding(), awsKeyFloorFinding(), evalTaintFinding()]);
    expect(result.reasons.length).toBe(2);
  });

  it("never emits an em-dash or double hyphen in any reason string", () => {
    const result = hasFloorTrip([
      privateKeyFloorFinding(),
      awsKeyFloorFinding(),
      tlsFloorFinding(),
      evalTaintFinding(),
    ]);
    for (const reason of result.reasons) {
      expect(reason).not.toContain("—");
      expect(reason).not.toContain("--");
    }
  });
});

// ──── Terminal render site ────

describe("terminal render: Security floor badge", () => {
  function terminalResult(findings: Finding[]): ScanResult {
    const { scores, hygieneScores, hygieneScore, maxHygieneScore, compositeScore, maxCompositeScore } =
      computeScores(findings, 30000);
    return {
      context: {
        rootDir: "/tmp/proj",
        dominantLanguage: "typescript",
        languageBreakdown: new Map([["typescript", { files: 1, lines: 100 }]]),
        totalLines: 30000,
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
      findings,
      driftFindings: [],
      driftScores: {},
      perFileScores: new Map(),
      teaseMessages: [],
      deepInsights: [],
      scanTimeMs: 5,
    } as unknown as ScanResult;
  }

  it("shows the floor badge line when a security-floor finding is present", () => {
    const out = renderTerminalOutput(terminalResult([driftFinding(), privateKeyFloorFinding()]));
    expect(out).toContain("Security floor:");
    expect(out).toContain("private key in source");
    expect(out).toContain("does not change the score");
  });

  it("does not show the floor badge line when there is no floor trip", () => {
    const out = renderTerminalOutput(terminalResult([driftFinding(), securityFinding()]));
    expect(out).not.toContain("Security floor:");
  });
});

// ──── HTML render site ────

describe("html render: Security floor badge", () => {
  function htmlResult(findings: Finding[]): ScanResult {
    const { scores, hygieneScores, hygieneScore, maxHygieneScore, compositeScore, maxCompositeScore } =
      computeScores(findings, 30000);
    return {
      context: {
        rootDir: "/tmp/proj",
        dominantLanguage: "typescript",
        languageBreakdown: new Map([["typescript", { files: 1, lines: 100 }]]),
        totalLines: 30000,
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
      findings,
      driftFindings: [],
      driftScores: {},
      perFileScores: new Map(),
      teaseMessages: [],
      deepInsights: [],
      scanTimeMs: 5,
    } as unknown as ScanResult;
  }

  it("renders a floor-trip chip reusing the existing .badge.warn class when tripped", () => {
    const html = renderHtmlReport(htmlResult([driftFinding(), privateKeyFloorFinding()]), "summary");
    expect(html).toContain("Security floor");
    expect(html).toMatch(/class="badge warn"/);
  });

  it("does not render a floor-trip chip when there is no floor trip", () => {
    const html = renderHtmlReport(htmlResult([driftFinding(), securityFinding()]), "summary");
    expect(html).not.toContain("Security floor tripped");
  });

  it("introduces no new CSS color token — only reuses existing --warn/--warn-tint", () => {
    const html = renderHtmlReport(htmlResult([driftFinding(), privateKeyFloorFinding()]), "summary");
    // Sanity: the stylesheet's badge.warn rule (pre-existing, reused) is present.
    expect(html).toContain(".badge.warn{background:var(--warn-tint);color:var(--warn)}");
  });
});

// ──── Grade invariance (locked constraint) ────

describe("grade invariance: the badge never changes compositeScore or the letter grade", () => {
  function extractGradeLetter(html: string): string {
    const m = html.match(/class="va-grade"[^>]*>([A-F])</);
    expect(m).not.toBeNull();
    return m![1];
  }

  it("compositeScore and the rendered letter grade are identical with vs without a security-floor finding", () => {
    const base = [driftFinding(), driftFinding()];
    const without = computeScores(base, 30000);
    const withFloor = computeScores([...base, awsKeyFloorFinding()], 30000);

    expect(withFloor.compositeScore).toBe(without.compositeScore);

    function toScanResult(scored: ReturnType<typeof computeScores>, findings: Finding[]): ScanResult {
      return {
        context: {
          rootDir: "/tmp/proj",
          dominantLanguage: "typescript",
          languageBreakdown: new Map([["typescript", { files: 1, lines: 100 }]]),
          totalLines: 30000,
          files: [],
          intentHints: [],
        },
        compositeScore: scored.compositeScore,
        maxCompositeScore: scored.maxCompositeScore,
        percentile: null,
        peerLanguage: "typescript",
        scores: scored.scores,
        hygieneScore: scored.hygieneScore,
        maxHygieneScore: scored.maxHygieneScore,
        hygieneScores: scored.hygieneScores,
        findings,
        driftFindings: [],
        driftScores: {},
        perFileScores: new Map(),
        teaseMessages: [],
        deepInsights: [],
        scanTimeMs: 5,
      } as unknown as ScanResult;
    }

    const htmlWithout = renderHtmlReport(toScanResult(without, base), "summary");
    const htmlWithFloor = renderHtmlReport(toScanResult(withFloor, [...base, awsKeyFloorFinding()]), "summary");

    expect(extractGradeLetter(htmlWithFloor)).toBe(extractGradeLetter(htmlWithout));
    // Sanity: the floor badge IS present in the "with" render (proves this
    // isn't a vacuous comparison where the badge never showed up).
    expect(htmlWithFloor).toContain("Security floor");
    expect(htmlWithout).not.toContain("Security floor tripped");
  });
});

// ──── Consumer-guidance fixes (Task 2 review fold-in) ────
//
// security-floor findings are hygiene-kind, so computeScores never populates
// their `consistencyImpact` (see src/scoring/engine.ts: "Hygiene track: ...
// never mutates consistencyImpact"). These tests set consistencyImpact
// directly on the fixture, matching how test/unit/output/fix-plan-widget.test.ts
// builds Fix Plan fixtures, so the terminal.ts Fix Plan path (which is
// impact-gated) can be exercised for a security-floor finding.

function minimalScanResult(findings: Finding[]): ScanResult {
  const emptyCat = { score: 18, maxScore: 20, locked: false, findingCount: 0, applicable: true };
  // renderHygienePane (terminal.ts) reads result.hygieneScores[cat].applicable for
  // every ScoringCategory key; applicable:false makes it a no-op skip so it
  // doesn't crash or interfere with the Fix Plan assertions below.
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
    findings,
    driftFindings: [],
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    deepInsights: [],
    scanTimeMs: 5,
  } as unknown as ScanResult;
}

describe("terminal: findingConsequence recognizes security-floor (terminal.ts ~L193)", () => {
  it("shows the security 'why it matters' line for a security-floor Fix Plan item", () => {
    const floor: Finding = {
      ...privateKeyFloorFinding(),
      consistencyImpact: 1.0, // manually set — see comment above
    };
    const out = renderTerminalOutput(minimalScanResult([floor]));
    expect(out).toContain("Hardcoded secrets or injection risks may be in production");
  });
});

describe("terminal: findingPriority treats security-floor as top priority (terminal.ts ~L241)", () => {
  it("ranks a security-floor item ahead of a lower-priority, higher-impact naming item in the drift-first Fix Plan", () => {
    // Same severity ("error") on both so the default (non-security) priority
    // tier ties at 2*3=6 for each — without the fix, findingPriority would not
    // recognize "security-floor" and this pair would tie, falling through to
    // the consistencyImpact tie-break (naming's 5.0 > floor's 1.0), putting
    // naming FIRST. With the fix, security-floor jumps to the top tier
    // (10*3=30) and wins outright. This makes the test a real regression
    // guard, not a vacuous pass.
    const floor: Finding = {
      analyzerId: "security-floor",
      severity: "error",
      confidence: 0.98,
      message: "SECURITY_FLOOR_ITEM: private key embedded in source",
      locations: [{ file: "src/key.ts", line: 1 }],
      tags: ["security", "secrets", "critical"],
      consistencyImpact: 1.0,
    };
    const naming: Finding = {
      analyzerId: "naming",
      severity: "error",
      confidence: 0.8,
      message: "NAMING_ITEM: inconsistent casing",
      locations: [{ file: "src/b.ts", line: 1 }],
      tags: [],
      consistencyImpact: 5.0, // much higher impact, but lower priority tier
    };
    const out = renderConciseSummary(minimalScanResult([naming, floor]));
    const floorIdx = out.indexOf("SECURITY_FLOOR_ITEM");
    const namingIdx = out.indexOf("NAMING_ITEM");
    expect(floorIdx).toBeGreaterThan(-1);
    expect(namingIdx).toBeGreaterThan(-1);
    expect(floorIdx).toBeLessThan(namingIdx);
  });
});

describe("fix-prompt: security-floor gets the specific 'rotate the secret' recommendation, not the generic fallback", () => {
  it("buildFixPromptMarkdown for a security-floor finding surfaces the security-specific recommendation", () => {
    const md = buildFixPromptMarkdown(privateKeyFloorFinding());
    expect(md).toContain("rotate it immediately");
    expect(md).not.toContain("Address the finding described above");
  });

  it("html buildEmbeddedPrompts (paid) surfaces the specific recommendation for a security-floor finding", () => {
    const html = buildEmbeddedPrompts(minimalScanResult([privateKeyFloorFinding()]), true);
    expect(html).toContain("rotate it immediately");
  });
});
