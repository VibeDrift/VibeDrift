import { describe, it, expect } from "vitest";
import { renderTerminalOutput } from "../../../src/output/terminal.js";
import type { ScanResult } from "../../../src/core/types.js";

// Pins the diff banner's version gates: a cross-version pair must render NO
// banner at all (the sole guard for `--since` targeting an old-engine scan),
// while a same-version pair renders normally.

function diffBase() {
  return {
    findingsDiff: { resolved: [], new: [{ analyzerId: "naming", severity: "warning" as const, message: "new drift thing", key: "k1" }], persistent: [] },
    driftFindingsDiff: { resolved: [], new: [], persistent: [] },
    scoreDelta: 4.2,
    hygieneDelta: 0,
    fromTimestamp: "2026-07-15T10:00:00Z",
    toTimestamp: "2026-07-16T10:00:00Z",
    incomparable: false,
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

describe("renderDiffBanner version gates (terminal.ts)", () => {
  it("renders the banner for a same-version diff (positive control)", () => {
    const out = renderTerminalOutput(minimalScanResult({ diff: { ...diffBase(), versionMismatch: false } } as Partial<ScanResult>));
    expect(out).toContain("Since last scan");
    expect(out).toContain("+4.2");
  });

  it("stays completely silent when the diffed pair spans scoring versions", () => {
    const out = renderTerminalOutput(minimalScanResult({ diff: { ...diffBase(), versionMismatch: true } } as Partial<ScanResult>));
    expect(out).not.toContain("Since last scan");
    expect(out).not.toContain("+4.2");
    expect(out).not.toContain("new drift thing");
    // Silent means silent: no version jargon either.
    expect(out.toLowerCase()).not.toContain("version");
  });

  it("stays silent on the latest-scan mismatch flag too (previousScoresMismatch)", () => {
    const out = renderTerminalOutput(
      minimalScanResult({
        previousScoresMismatch: "scoring-version-mismatch",
        diff: { ...diffBase(), versionMismatch: false },
      } as Partial<ScanResult>),
    );
    expect(out).not.toContain("Since last scan");
    expect(out).not.toContain("+4.2");
  });
});
