import { describe, it, expect } from "vitest";
import { computeScores } from "../../../src/scoring/engine.js";
import type { AnalysisContext, Finding, SourceFile, SupportedLanguage } from "../../../src/core/types.js";

/**
 * Decompression proof (v4). The legacy formula compressed every repo into the
 * 82.9–100 band (per-analyzer cap + sqrt-LOC dampener + additive composite +
 * a "drag" penalty that floored the score near 75). v4 removes all four and
 * threads the dominance ratio (deviation fraction) through as the per-finding
 * magnitude. These tests pin the decompression goal:
 *
 *   1. clean repos still score high (no false alarms),
 *   2. messy repos score low and materially below clean,
 *   3. the dominance ratio (consistencyScore) materially moves a category,
 *   4. there is no 75 floor — one collapsed category drags the headline below it,
 *   5. the score is invariant to repo size at fixed drift density (no sqrt-LOC).
 */

function makeCtx(totalLines: number, files: SourceFile[] = []): AnalysisContext {
  const languageBreakdown = new Map<SupportedLanguage, { files: number; lines: number }>([
    ["typescript", { files: Math.max(1, files.length), lines: totalLines }],
  ]);
  return {
    rootDir: "/repo",
    files,
    packageJson: null,
    goMod: null,
    cargoToml: null,
    requirementsTxt: null,
    envExample: null,
    totalLines,
    languageBreakdown,
    dominantLanguage: "typescript",
  };
}

function mkFile(relativePath: string): SourceFile {
  return { path: relativePath, relativePath, language: "typescript", content: "", lineCount: 50 };
}

/**
 * Build a drift-kind finding carrying a dominance ratio. `consistencyScore` is
 * 0-100; the engine derives the per-finding magnitude as `1 - consistencyScore/100`
 * (the deviation fraction). A consistencyScore of 50 means deviationFraction ~0.5.
 */
function mkDrift(
  analyzerId: string,
  severity: Finding["severity"],
  consistencyScore: number,
  file: string,
): Finding {
  const totalRelevantFiles = 10;
  const dominantCount = Math.round((consistencyScore / 100) * totalRelevantFiles);
  return {
    analyzerId,
    severity,
    confidence: 0.9,
    message: `drift in ${analyzerId}`,
    locations: [{ file, line: 1 }],
    tags: ["drift"],
    driftSignal: { consistencyScore, dominantCount, totalRelevantFiles },
  };
}

/**
 * Build a count-based drift finding (codedna / ml) with NO driftSignal. These
 * carry no dominance baseline, so the engine normalizes them per KLOC instead
 * of by deviation fraction — a high volume of them must not collapse a category
 * regardless of codebase size.
 */
function mkCount(analyzerId: string, severity: Finding["severity"], file: string): Finding {
  return {
    analyzerId,
    severity,
    confidence: 0.85,
    message: `${analyzerId} hit in ${file}`,
    locations: [{ file, line: 1 }],
    tags: ["drift"],
  };
}

describe("scoring decompression (v4)", () => {
  it("clean repo (0-1 low-deviation findings) scores >= 88", () => {
    const findings: Finding[] = [
      // A single, barely-deviating finding: 95% consistent → deviationFraction 0.05.
      mkDrift("drift-architectural_consistency", "info", 95, "src/a.ts"),
    ];
    const { compositeScore } = computeScores(findings, 5000, makeCtx(5000));
    expect(compositeScore).toBeGreaterThanOrEqual(88);
  });

  it("messy repo (high-deviation error detectors across all categories) scores <= 55 and >= 35 below clean", () => {
    const clean = computeScores(
      [mkDrift("drift-architectural_consistency", "info", 95, "src/a.ts")],
      5000,
      makeCtx(5000),
    );

    // Drift across every drift category — several distinct detectors each at
    // ~65% deviation (consistencyScore 35). Multiple detectors per category
    // compound via the noisy-OR, then the geometric-mean composite compounds
    // across categories: a genuinely messy repo, not one bad area.
    const messy: Finding[] = [
      mkDrift("drift-architectural_consistency", "error", 35, "src/a.ts"),
      mkDrift("drift-naming_conventions", "error", 35, "src/b.ts"),
      mkDrift("drift-semantic_duplication", "error", 35, "src/c.ts"),
      mkDrift("drift-phantom_scaffolding", "error", 35, "src/d.ts"),
      mkDrift("drift-security_posture", "error", 35, "src/e.ts"),
      mkDrift("drift-comment_style_consistency", "error", 35, "src/f.ts"),
    ];
    const { compositeScore } = computeScores(messy, 5000, makeCtx(5000));

    expect(compositeScore).toBeLessThanOrEqual(55);
    expect(clean.compositeScore - compositeScore).toBeGreaterThanOrEqual(35);
  });

  it("dominance ratio is threaded: a category at consistencyScore 51 scores >= 4 (/20) below the same at 98", () => {
    // Two repos identical except the consistency of the architectural category.
    // Same finding count and severity in both — only the dominance ratio differs.
    const at = (consistencyScore: number) =>
      computeScores(
        [
          mkDrift("drift-architectural_consistency", "error", consistencyScore, "src/a.ts"),
          mkDrift("drift-architectural_consistency", "error", consistencyScore, "src/b.ts"),
        ],
        5000,
        makeCtx(5000),
      );

    const low = at(51).scores.architecturalConsistency.score;
    const high = at(98).scores.architecturalConsistency.score;
    expect(high - low).toBeGreaterThanOrEqual(4);
  });

  it("no 75 floor: one fully-collapsed category drags the composite below 75", () => {
    // Architectural consistency hammered by TWO distinct detectors at ~90%
    // deviation (consistencyScore 10); every other category pristine. Under the
    // old additive composite + drag floor this parked near 75 — the geometric
    // mean has to drop well below.
    const findings: Finding[] = [
      mkDrift("drift-architectural_consistency", "error", 10, "src/a.ts"),
      mkDrift("drift-architectural_consistency", "error", 10, "src/b.ts"),
      mkDrift("drift-naming_conventions", "error", 10, "src/c.ts"),
      mkDrift("drift-naming_conventions", "error", 10, "src/d.ts"),
    ];
    const { compositeScore, scores } = computeScores(findings, 5000, makeCtx(5000));
    // The hammered category is near-collapsed...
    expect(scores.architecturalConsistency.score).toBeLessThan(6);
    // ...and that drags the headline below the old 75 floor.
    expect(compositeScore).toBeLessThan(75);
  });

  it("LOC-invariant: a finding-bearing drift category scores identically at 2k vs 40k lines", () => {
    // Drift magnitudes are rate-normalized (deviation fraction), so a category
    // that HAS findings does not depend on repo size — the sqrt-LOC dampener is
    // gone. (The overall composite now carries a small, bounded size term from
    // evidence-weighting of NO-finding categories — thin evidence regresses
    // toward the prior — so we assert the invariance on the finding-bearing
    // category, which is exactly what density-normalization guarantees.)
    const findings = (): Finding[] => [
      mkDrift("drift-architectural_consistency", "error", 50, "src/a.ts"),
      mkDrift("drift-naming_conventions", "error", 50, "src/b.ts"),
    ];
    const small = computeScores(findings(), 2000, makeCtx(2000)).scores.architecturalConsistency.score;
    const large = computeScores(findings(), 40000, makeCtx(40000)).scores.architecturalConsistency.score;
    expect(small).toBe(large);
  });

  it("per-file score uses the v4 noisy-OR: deviator files score below clean, errors below warnings", () => {
    const files = [mkFile("src/bad.ts"), mkFile("src/mid.ts"), mkFile("src/clean.ts")];
    const findings: Finding[] = [
      mkDrift("drift-naming_conventions", "error", 50, "src/bad.ts"),
      mkDrift("drift-async_patterns", "warning", 50, "src/mid.ts"),
    ];
    const { perFileScores } = computeScores(findings, 1000, makeCtx(1000, files));
    const bad = perFileScores.get("src/bad.ts")!.score;
    const mid = perFileScores.get("src/mid.ts")!.score;
    const clean = perFileScores.get("src/clean.ts")!.score;
    expect(clean).toBe(100); // no findings → pristine
    expect(mid).toBeLessThan(100); // a warning dents it
    expect(bad).toBeLessThan(mid); // an error hurts more than a warning
  });

  it("n-aware: a small-sample dominance finding damages less than a large-sample one", () => {
    const mk = (totalRelevantFiles: number): Finding => ({
      analyzerId: "drift-architectural_consistency",
      severity: "error",
      confidence: 0.9,
      message: "arch drift",
      locations: [{ file: "src/a.ts", line: 1 }],
      tags: ["drift"],
      driftSignal: {
        consistencyScore: 50,
        dominantCount: Math.round(totalRelevantFiles / 2),
        totalRelevantFiles,
      },
    });
    const small = computeScores([mk(4)], 5000, makeCtx(5000)).scores.architecturalConsistency.score;
    const large = computeScores([mk(40)], 5000, makeCtx(5000)).scores.architecturalConsistency.score;
    // Same 50%-consistent split, but a 4-file sample is weaker evidence of drift
    // than a 40-file sample → less damage → higher (better) category score.
    expect(small).toBeGreaterThan(large);
  });

  it("granular (v6): composite decreases MONOTONICALLY as drift deepens (deviation + duplication)", () => {
    // Each level deepens BOTH dominance deviation (lower consistencyScore) AND the
    // duplicated-function fraction (larger dup group). The composite must strictly
    // decrease — the score is granular, not compressed/clustered at the top.
    const atLevel = (consistency: number, dupGroupSize: number): number => {
      const findings: Finding[] = [
        mkDrift("drift-architectural_consistency", "error", consistency, "src/a.ts"),
        mkDrift("drift-naming_conventions", "error", consistency, "src/b.ts"),
      ];
      if (dupGroupSize > 1) {
        findings.push({
          analyzerId: "codedna-fingerprint",
          severity: "warning",
          confidence: 1,
          message: "exact duplicate group",
          locations: [{ file: "src/d.ts", line: 1 }],
          tags: ["duplicate"],
          dupGroupSize,
        });
      }
      const ctx: AnalysisContext = { ...makeCtx(20000), functionCount: 200 };
      return computeScores(findings, 20000, ctx).compositeScore;
    };
    const gradient = [
      atLevel(90, 2),   // barely any drift
      atLevel(72, 12),
      atLevel(55, 28),
      atLevel(38, 55),
      atLevel(20, 95),  // severe drift + heavy duplication
    ];
    for (let i = 1; i < gradient.length; i++) {
      expect(gradient[i]).toBeLessThan(gradient[i - 1]);
    }
    // And the span is wide (granular), not compressed into a few points.
    expect(gradient[0] - gradient[gradient.length - 1]).toBeGreaterThan(25);
  });

  it("size-fair (v6): count-based drift at a FIXED per-function rate scores the same at any repo size", () => {
    // 10 dup findings across 100 functions (10% rate) vs 100 dup findings across
    // 1000 functions (same 10% rate). With function-count normalization the
    // redundancy score must be ~identical — structural similarity that scales with
    // function count no longer sinks the larger repo.
    const ctxFn = (functions: number, lines: number): AnalysisContext => ({
      ...makeCtx(lines),
      functionCount: functions,
    });
    const dupes = (n: number): Finding[] =>
      Array.from({ length: n }, (_, i) => mkCount("codedna-fingerprint", "warning", `src/dup${i}.ts`));
    const small = computeScores(dupes(10), 5000, ctxFn(100, 5000)).scores.redundancy.score;
    const large = computeScores(dupes(100), 50000, ctxFn(1000, 50000)).scores.redundancy.score;
    expect(Math.abs(small - large)).toBeLessThan(1);
  });

  it("size-fair (v6): a HIGHER per-function dup rate scores lower than a low rate (same size)", () => {
    const ctxFn = (functions: number): AnalysisContext => ({ ...makeCtx(20000), functionCount: functions });
    const dupes = (n: number): Finding[] =>
      Array.from({ length: n }, (_, i) => mkCount("codedna-fingerprint", "warning", `src/dup${i}.ts`));
    const lowRate = computeScores(dupes(10), 20000, ctxFn(1000)).scores.redundancy.score; // 1%
    const highRate = computeScores(dupes(300), 20000, ctxFn(1000)).scores.redundancy.score; // 30%
    expect(highRate).toBeLessThan(lowRate);
  });

  it("shipped-code weighting (v6): the SAME dup group damages src/ most, examples/tests less, generated ~none", () => {
    // The score measures drift in shipped code. An identical 40-member duplicate
    // group should hurt most in src/, less in examples/ or tests/, and be
    // effectively excluded when it lives in generated code.
    const redundancyFor = (file: string): number => {
      const findings: Finding[] = [{
        analyzerId: "codedna-fingerprint",
        severity: "error",
        confidence: 0.95,
        message: "exact duplicate group",
        locations: [{ file, line: 1 }],
        tags: ["duplicate"],
        dupGroupSize: 40,
      }];
      const ctx: AnalysisContext = { ...makeCtx(20000), functionCount: 200 };
      return computeScores(findings, 20000, ctx).scores.redundancy.score;
    };
    const src = redundancyFor("src/dup.ts");
    const example = redundancyFor("examples/demo/dup.ts");
    const test = redundancyFor("test/dup.test.ts");
    const generated = redundancyFor("src/client.gen.ts");
    // lower redundancy score = more damage. src is shipped → most damage.
    expect(src).toBeLessThan(example);
    expect(src).toBeLessThan(test);
    // generated is not authored → effectively excluded → near-clean redundancy.
    expect(generated).toBeGreaterThan(example);
    expect(generated).toBeGreaterThan(19);
  });

  it("shipped-code weighting (v6): dominance drift in src/ damages more than the same drift in tests/", () => {
    const compositeFor = (file: string): number => {
      const findings = [mkDrift("drift-naming_conventions", "error", 40, file)];
      return computeScores(findings, 20000, { ...makeCtx(20000), functionCount: 200 }).compositeScore;
    };
    expect(compositeFor("src/a.ts")).toBeLessThan(compositeFor("test/a.test.ts"));
  });

  it("count-based codedna findings are volume-normalized, not collapsed to zero", () => {
    // 40 codedna duplicate findings with no dominance ratio. Under the flat-0.5
    // magnitude (kloc=1) bug these collapsed redundancy to ~0 and tanked the
    // headline regardless of codebase size. Per-KLOC normalization must keep the
    // category meaningful and scale it with repo size.
    const dupes = (): Finding[] =>
      Array.from({ length: 40 }, (_, i) => mkCount("codedna-fingerprint", "warning", `src/dup${i}.ts`));

    const small = computeScores(dupes(), 20_000, makeCtx(20_000));
    const large = computeScores(dupes(), 200_000, makeCtx(200_000));

    // Not collapsed: 40 dupes across a 20k repo is real but not catastrophic.
    expect(small.scores.redundancy.score).toBeGreaterThan(3);
    // Volume-normalized: the same 40 dupes in a 10x larger repo are less dense,
    // so the category scores materially higher (size matters for raw counts).
    expect(large.scores.redundancy.score).toBeGreaterThan(small.scores.redundancy.score + 3);
    // And the headline is not floored at zero by the count-based detector.
    expect(small.compositeScore).toBeGreaterThan(20);
  });
});
