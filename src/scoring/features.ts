/**
 * Size-invariant scoring features (F1–F4).
 *
 * ADDITIVE telemetry only — these features do NOT feed the composite score or
 * any scoring math. They are emitted alongside a scan so a validation
 * experiment can study how drift signals behave independent of repo size.
 *
 * The design goal is LOC-invariance: replicating a codebase's files N times
 * (same proportions) must leave the rate/entropy features unchanged. Only the
 * density feature (f3) is intentionally per-KLOC.
 */

import { shannonEntropy } from "../drift/utils.js";
import type { DriftFinding } from "../drift/types.js";
import type { PatternDistribution } from "../codedna/types.js";

export interface SizeInvariantFeatures {
  /** 1 − (Σ dominantCount / Σ totalRelevantFiles) over dominance findings. [0,1] */
  f1DriftRate: number;
  /** Normalized Shannon entropy of dominantPattern distribution. [0,1] */
  f2ConventionEntropy: number;
  /** Count of high-deviation dominance findings per KLOC. */
  f3ContradictionDensity: number;
  /** Fraction of pattern files that are internally inconsistent. [0,1] */
  f4IncoherenceRate: number;
  /** Number of non-countBased drift findings (dominance axes). */
  nDriftAxes: number;
  /** Number of pattern-classified files. */
  nPatternFiles: number;
  /** Thousands of lines of code (min 1). */
  kloc: number;
}

/**
 * Compute the four size-invariant features from raw drift + Code DNA outputs.
 * Pure function — no I/O, deterministic on its inputs.
 */
export function computeSizeInvariantFeatures(
  driftFindings: DriftFinding[],
  patternDistributions: PatternDistribution[],
  totalLines: number,
): SizeInvariantFeatures {
  const kloc = Math.max(1, totalLines / 1000);

  // ── F1: drift rate ──────────────────────────────────────────────────
  // Dominance-based findings only (a real dominant/total peer ratio exists).
  let dominantSum = 0;
  let totalSum = 0;
  for (const f of driftFindings) {
    if (f.countBased) continue;
    if (f.totalRelevantFiles > 0) {
      dominantSum += f.dominantCount;
      totalSum += f.totalRelevantFiles;
    }
  }
  let f1DriftRate = totalSum > 0 ? 1 - dominantSum / totalSum : 0;
  if (f1DriftRate < 0) f1DriftRate = 0;
  if (f1DriftRate > 1) f1DriftRate = 1;

  // ── F2: convention entropy ──────────────────────────────────────────
  // Normalized Shannon entropy of the dominantPattern distribution across
  // pattern-classified files. 0 when fewer than 2 distinct patterns.
  const patternCounts = new Map<string, number>();
  for (const pd of patternDistributions) {
    patternCounts.set(pd.dominantPattern, (patternCounts.get(pd.dominantPattern) ?? 0) + 1);
  }
  const counts = [...patternCounts.values()].filter((c) => c > 0);
  const k = counts.length;
  let f2ConventionEntropy = 0;
  if (k >= 2) {
    const H = shannonEntropy(counts);
    const maxH = Math.log2(k);
    f2ConventionEntropy = maxH > 0 ? H / maxH : 0;
  }

  // ── F3: contradiction density ───────────────────────────────────────
  // High-deviation dominance findings (deviation ≥ 0.2) normalized per KLOC.
  let contradictions = 0;
  for (const f of driftFindings) {
    if (f.countBased) continue;
    const deviation = 1 - f.consistencyScore / 100;
    if (deviation >= 0.2) contradictions++;
  }
  const f3ContradictionDensity = contradictions / Math.max(1, totalLines / 1000);

  // ── F4: incoherence rate ────────────────────────────────────────────
  // Fraction of pattern files flagged internally inconsistent.
  const nPatternFiles = patternDistributions.length;
  const incoherent = patternDistributions.filter((pd) => pd.isInternallyInconsistent === true).length;
  const f4IncoherenceRate = nPatternFiles > 0 ? incoherent / nPatternFiles : 0;

  // ── Diagnostic denominators ─────────────────────────────────────────
  const nDriftAxes = driftFindings.filter((f) => !f.countBased).length;

  return {
    f1DriftRate,
    f2ConventionEntropy,
    f3ContradictionDensity,
    f4IncoherenceRate,
    nDriftAxes,
    nPatternFiles,
    kloc,
  };
}
