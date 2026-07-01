import { describe, it, expect } from "vitest";
import { computeSizeInvariantFeatures } from "./features.js";
import type { DriftFinding, DriftCategory } from "../drift/types.js";
import type { PatternDistribution, ArchPattern } from "../codedna/types.js";

// ── Fixture builders ──────────────────────────────────────────────────

function drift(opts: {
  dominantCount: number;
  totalRelevantFiles: number;
  consistencyScore: number;
  countBased?: boolean;
  category?: DriftCategory;
}): DriftFinding {
  return {
    detector: "test",
    driftCategory: opts.category ?? "architectural_consistency",
    severity: "warning",
    confidence: 0.9,
    finding: "test finding",
    dominantPattern: "dominant",
    dominantCount: opts.dominantCount,
    totalRelevantFiles: opts.totalRelevantFiles,
    consistencyScore: opts.consistencyScore,
    countBased: opts.countBased,
    deviatingFiles: [],
    recommendation: "fix it",
  };
}

function pattern(dominantPattern: ArchPattern, inconsistent = false): PatternDistribution {
  return {
    file: `/abs/${dominantPattern}-${Math.random()}.ts`,
    relativePath: `${dominantPattern}.ts`,
    patterns: { [dominantPattern]: 1 },
    dominantPattern,
    confidence: 0.9,
    signals: [],
    isInternallyInconsistent: inconsistent,
  };
}

/** Replicate a list N times to simulate a proportionally larger repo. */
function replicate<T>(arr: T[], n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(...arr);
  return out;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("computeSizeInvariantFeatures", () => {
  // (b) Correctness on a small hand-built fixture.
  it("computes exact hand-verified values", () => {
    const findings: DriftFinding[] = [
      // A: dominance, deviation = 1 - 0.75 = 0.25 (>= 0.2 → counts for f3)
      drift({ dominantCount: 8, totalRelevantFiles: 10, consistencyScore: 75 }),
      // B: dominance, deviation = 1 - 0.30 = 0.70 (>= 0.2 → counts for f3)
      drift({ dominantCount: 3, totalRelevantFiles: 10, consistencyScore: 30 }),
      // C: count-based → excluded from f1 (rate) and f3 (density) and nDriftAxes
      drift({ dominantCount: 0, totalRelevantFiles: 0, consistencyScore: 50, countBased: true }),
    ];
    const patterns: PatternDistribution[] = [
      pattern("repository"),
      pattern("repository"),
      pattern("repository"),
      pattern("raw_sql", true), // 1 of 4 internally inconsistent
    ];
    const totalLines = 2000;

    const f = computeSizeInvariantFeatures(findings, patterns, totalLines);

    // f1 = 1 - (8+3)/(10+10) = 1 - 11/20 = 0.45
    expect(f.f1DriftRate).toBeCloseTo(0.45, 10);

    // f2: counts repository=3, raw_sql=1, total=4, k=2
    // H = -(0.75·log2(0.75) + 0.25·log2(0.25)) = 0.8112781...
    // normalized = H / log2(2) = H
    expect(f.f2ConventionEntropy).toBeCloseTo(0.8112781244591328, 10);

    // f3: 2 high-deviation dominance findings / max(1, 2000/1000) = 2/2 = 1.0
    expect(f.f3ContradictionDensity).toBeCloseTo(1.0, 10);

    // f4: 1 inconsistent / 4 files = 0.25
    expect(f.f4IncoherenceRate).toBeCloseTo(0.25, 10);

    expect(f.nDriftAxes).toBe(2); // only the two non-countBased findings
    expect(f.nPatternFiles).toBe(4);
    expect(f.kloc).toBeCloseTo(2, 10);
  });

  // (a) LOC-invariance: proportional replication leaves rate/entropy features unchanged.
  it("f1/f2/f4 are invariant under proportional scaling (replication)", () => {
    const findings: DriftFinding[] = [
      drift({ dominantCount: 7, totalRelevantFiles: 12, consistencyScore: 58 }),
      drift({ dominantCount: 4, totalRelevantFiles: 9, consistencyScore: 44 }),
      drift({ dominantCount: 0, totalRelevantFiles: 0, consistencyScore: 25, countBased: true }),
    ];
    const patterns: PatternDistribution[] = [
      pattern("repository"),
      pattern("repository"),
      pattern("orm", true),
      pattern("raw_sql"),
      pattern("raw_sql", true),
    ];

    const base = computeSizeInvariantFeatures(findings, patterns, 3000);

    for (const n of [2, 5, 13]) {
      const scaled = computeSizeInvariantFeatures(
        replicate(findings, n),
        replicate(patterns, n),
        3000 * n, // LOC scales proportionally
      );
      expect(scaled.f1DriftRate).toBeCloseTo(base.f1DriftRate, 12);
      expect(scaled.f2ConventionEntropy).toBeCloseTo(base.f2ConventionEntropy, 12);
      expect(scaled.f4IncoherenceRate).toBeCloseTo(base.f4IncoherenceRate, 12);
    }
  });

  // (c) f2ConventionEntropy is 0 for one pattern, > 0 for a 50/50 split.
  it("f2ConventionEntropy is 0 when all files share one pattern", () => {
    const patterns: PatternDistribution[] = [
      pattern("repository"),
      pattern("repository"),
      pattern("repository"),
    ];
    const f = computeSizeInvariantFeatures([], patterns, 1000);
    expect(f.f2ConventionEntropy).toBe(0);
  });

  it("f2ConventionEntropy is > 0 (== 1 normalized) on a 50/50 split", () => {
    const patterns: PatternDistribution[] = [
      pattern("repository"),
      pattern("repository"),
      pattern("raw_sql"),
      pattern("raw_sql"),
    ];
    const f = computeSizeInvariantFeatures([], patterns, 1000);
    expect(f.f2ConventionEntropy).toBeGreaterThan(0);
    // Perfectly even 2-way split → normalized entropy = 1.
    expect(f.f2ConventionEntropy).toBeCloseTo(1, 10);
  });

  // Edge cases from the spec.
  it("returns zeros on empty inputs", () => {
    const f = computeSizeInvariantFeatures([], [], 0);
    expect(f.f1DriftRate).toBe(0);
    expect(f.f2ConventionEntropy).toBe(0);
    expect(f.f3ContradictionDensity).toBe(0);
    expect(f.f4IncoherenceRate).toBe(0);
    expect(f.nDriftAxes).toBe(0);
    expect(f.nPatternFiles).toBe(0);
    expect(f.kloc).toBe(1); // max(1, 0/1000)
  });

  it("f1 ignores count-based findings and clamps to [0,1]", () => {
    const findings: DriftFinding[] = [
      drift({ dominantCount: 5, totalRelevantFiles: 5, consistencyScore: 100 }),
      drift({ dominantCount: 999, totalRelevantFiles: 0, consistencyScore: 10, countBased: true }),
    ];
    const f = computeSizeInvariantFeatures(findings, [], 1000);
    // Only the first (dominance) finding counts: 1 - 5/5 = 0.
    expect(f.f1DriftRate).toBe(0);
  });
});
