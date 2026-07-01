/**
 * analyze-drift.ts — compute the experiment's primary result (pure).
 *
 * Joins RunResults (arm, passed, vibedriftToolCalls) with the judge's
 * RunDriftScores and produces:
 *  - per-arm pass rate + pooled mean drift among judged passers,
 *  - MCP-usage / degenerate-T diagnostics,
 *  - the task-clustered paired contrasts T-P (primary), T-C, P-C, each with a
 *    seeded cluster-bootstrap 95% CI.
 *
 * Lower drift is better. A NEGATIVE T-P delta means the MCP arm drifted LESS
 * than the instruction-only arm (the hypothesized direction).
 *
 * No Math.random: the bootstrap uses a seeded LCG so the CI is reproducible.
 */

import type { Arm, RunResult } from "./types.js";
import type { RunDriftScore } from "./judge.js";

export interface ArmStat {
  arm: Arm;
  nRuns: number;
  nPassed: number;
  passRate: number;
  nJudged: number;
  meanDrift: number; // pooled mean over judged passing runs (NaN-safe: 0 if none)
}

export interface Contrast {
  label: string; // e.g. "T-P"
  deltaMean: number; // mean over tasks of (driftA - driftB); negative => A drifts less
  ci95: [number, number];
  nClusters: number; // tasks contributing (both arms present)
}

export interface DriftAnalysis {
  perArm: Record<Arm, ArmStat>;
  mcpUsageRateT: number; // fraction of T runs that called an mcp__vibedrift__* tool
  degenerateTRuns: number; // T runs with zero vibedrift tool calls
  contrasts: { TminusP: Contrast; TminusC: Contrast; PminusC: Contrast };
  /** Per-task per-arm mean drift (the cluster view feeding the contrasts). */
  byTask: Record<string, Partial<Record<Arm, number>>>;
  bootstrapResamples: number;
}

const ARMS: Arm[] = ["C", "P", "T"];

// --- seeded RNG (djb2 seed -> Numerical Recipes LCG), matches orchestrate.ts ---
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}
function lcg(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Task-clustered paired contrast for (armA - armB) with a seeded cluster
 * bootstrap CI. Only tasks where BOTH arms have a mean drift contribute.
 */
function pairedContrast(
  byTask: Record<string, Partial<Record<Arm, number>>>,
  armA: Arm,
  armB: Arm,
  resamples: number,
  seedKey: string,
): Contrast {
  const diffs: number[] = [];
  for (const arms of Object.values(byTask)) {
    const a = arms[armA];
    const b = arms[armB];
    if (typeof a === "number" && typeof b === "number") diffs.push(a - b);
  }
  const label = `${armA}-${armB}`;
  if (diffs.length === 0) {
    return { label, deltaMean: NaN, ci95: [NaN, NaN], nClusters: 0 };
  }
  const deltaMean = mean(diffs);

  // Cluster bootstrap: resample tasks (diffs) with replacement.
  let state = hashStr(`${seedKey}:${label}`);
  const boots: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const sample: number[] = [];
    for (let i = 0; i < diffs.length; i++) {
      state = lcg(state);
      sample.push(diffs[state % diffs.length]);
    }
    boots.push(mean(sample));
  }
  boots.sort((x, y) => x - y);
  return {
    label,
    deltaMean,
    ci95: [percentile(boots, 0.025), percentile(boots, 0.975)],
    nClusters: diffs.length,
  };
}

export interface AnalyzeOpts {
  resamples?: number; // bootstrap iterations (default 2000)
  seed?: string; // bootstrap seed key (default "drift")
}

export function analyzeDrift(
  runs: RunResult[],
  driftScores: RunDriftScore[],
  opts: AnalyzeOpts = {},
): DriftAnalysis {
  const resamples = opts.resamples ?? 2000;
  const seed = opts.seed ?? "drift";
  const driftById = new Map(driftScores.map((d) => [d.runId, d]));

  // Per-arm tallies + per-(task,arm) drift accumulation among judged passers.
  const perArm: Record<Arm, ArmStat> = {
    C: { arm: "C", nRuns: 0, nPassed: 0, passRate: 0, nJudged: 0, meanDrift: 0 },
    P: { arm: "P", nRuns: 0, nPassed: 0, passRate: 0, nJudged: 0, meanDrift: 0 },
    T: { arm: "T", nRuns: 0, nPassed: 0, passRate: 0, nJudged: 0, meanDrift: 0 },
  };
  const pooledDrift: Record<Arm, number[]> = { C: [], P: [], T: [] };
  const taskArmDrift: Record<string, Partial<Record<Arm, number[]>>> = {};

  let tRuns = 0;
  let tWithTools = 0;

  for (const run of runs) {
    const arm = run.arm;
    perArm[arm].nRuns++;
    if (run.passed) perArm[arm].nPassed++;
    if (arm === "T") {
      tRuns++;
      if ((run.vibedriftToolCalls ?? 0) > 0) tWithTools++;
    }
    const drift = driftById.get(run.runId);
    // Score drift among judged passing runs with a usable panel verdict.
    if (run.passed && drift && drift.nJudges > 0) {
      perArm[arm].nJudged++;
      pooledDrift[arm].push(drift.driftScore);
      ((taskArmDrift[run.taskId] ??= {})[arm] ??= []).push(drift.driftScore);
    }
  }

  for (const arm of ARMS) {
    perArm[arm].passRate = perArm[arm].nRuns === 0 ? 0 : perArm[arm].nPassed / perArm[arm].nRuns;
    perArm[arm].meanDrift = mean(pooledDrift[arm]);
  }

  // Collapse per-(task,arm) drift lists to means (the cluster view).
  const byTask: Record<string, Partial<Record<Arm, number>>> = {};
  for (const [taskId, arms] of Object.entries(taskArmDrift)) {
    byTask[taskId] = {};
    for (const arm of ARMS) {
      const vals = arms[arm];
      if (vals && vals.length > 0) byTask[taskId][arm] = mean(vals);
    }
  }

  return {
    perArm,
    mcpUsageRateT: tRuns === 0 ? 0 : tWithTools / tRuns,
    degenerateTRuns: tRuns - tWithTools,
    contrasts: {
      TminusP: pairedContrast(byTask, "T", "P", resamples, seed),
      TminusC: pairedContrast(byTask, "T", "C", resamples, seed),
      PminusC: pairedContrast(byTask, "P", "C", resamples, seed),
    },
    byTask,
    bootstrapResamples: resamples,
  };
}
