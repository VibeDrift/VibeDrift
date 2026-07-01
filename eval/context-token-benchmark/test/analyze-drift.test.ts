import { describe, it, expect } from "vitest";
import { analyzeDrift } from "../src/analyze-drift.js";
import type { Arm, RunResult } from "../src/types.js";
import type { RunDriftScore } from "../src/judge.js";

function run(
  taskId: string,
  arm: Arm,
  rep: number,
  passed: boolean,
  toolCalls = 0,
): RunResult {
  return {
    runId: `repo__${taskId}__${arm}__r${rep}`,
    repoId: "repo",
    taskId,
    arm,
    replicate: rep,
    modelId: "claude-opus-4-8",
    cliVersion: "0.1.0",
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0,
    reportedCostUsd: null,
    passed,
    censored: false,
    competingFailure: !passed,
    compactionEvents: 0,
    vibedriftToolCalls: toolCalls,
    startedAt: "2026-06-29T00:00:00.000Z",
    durationMs: 1,
    diff: "x",
  };
}

function drift(runId: string, d: number): RunDriftScore {
  return {
    runId,
    nJudges: 3,
    nJudgeFailures: 0,
    driftScore: d,
    holisticDrift: d,
    perJudgeDrift: [d, d, d],
    judgeStdev: 0,
    driftByAxis: {},
  };
}

describe("analyzeDrift", () => {
  // 2 tasks × 3 arms × 2 reps, all passing. T drifts 0.1, P 0.5, C 0.6.
  const runs: RunResult[] = [];
  const scores: RunDriftScore[] = [];
  for (const taskId of ["t1", "t2"]) {
    for (const rep of [0, 1]) {
      for (const [arm, d] of [["C", 0.6], ["P", 0.5], ["T", 0.1]] as const) {
        const r = run(taskId, arm, rep, true, arm === "T" ? 2 : 0);
        runs.push(r);
        scores.push(drift(r.runId, d));
      }
    }
  }

  it("computes per-arm pooled mean drift", () => {
    const a = analyzeDrift(runs, scores, { resamples: 200 });
    expect(a.perArm.T.meanDrift).toBeCloseTo(0.1, 10);
    expect(a.perArm.P.meanDrift).toBeCloseTo(0.5, 10);
    expect(a.perArm.C.meanDrift).toBeCloseTo(0.6, 10);
    expect(a.perArm.T.nJudged).toBe(4);
  });

  it("primary T-P contrast is negative (T drifts less) with a tight CI", () => {
    const a = analyzeDrift(runs, scores, { resamples: 500 });
    expect(a.contrasts.TminusP.deltaMean).toBeCloseTo(-0.4, 10);
    expect(a.contrasts.TminusP.nClusters).toBe(2);
    // identical per-task diffs => CI collapses to the point estimate
    expect(a.contrasts.TminusP.ci95[0]).toBeCloseTo(-0.4, 10);
    expect(a.contrasts.TminusP.ci95[1]).toBeCloseTo(-0.4, 10);
  });

  it("reports MCP usage rate and degenerate-T count", () => {
    const a = analyzeDrift(runs, scores, { resamples: 50 });
    expect(a.mcpUsageRateT).toBeCloseTo(1, 10); // all T runs called a tool
    expect(a.degenerateTRuns).toBe(0);
  });

  it("flags degenerate T runs (zero tool calls)", () => {
    const r2 = [...runs];
    // turn one T run into a zero-tool degenerate
    const idx = r2.findIndex((r) => r.arm === "T");
    r2[idx] = { ...r2[idx], vibedriftToolCalls: 0 };
    const a = analyzeDrift(r2, scores, { resamples: 50 });
    expect(a.degenerateTRuns).toBe(1);
    expect(a.mcpUsageRateT).toBeCloseTo(3 / 4, 10);
  });

  it("excludes failed runs from drift but counts them in pass rate", () => {
    // Fail both C runs of t1
    const r2 = runs.map((r) =>
      r.taskId === "t1" && r.arm === "C" ? { ...r, passed: false, competingFailure: true } : r,
    );
    const a = analyzeDrift(r2, scores, { resamples: 50 });
    expect(a.perArm.C.nPassed).toBe(2); // t2's two C runs
    expect(a.perArm.C.nRuns).toBe(4);
    expect(a.perArm.C.passRate).toBeCloseTo(0.5, 10);
    // t1 now has no C cluster, so P-C and T-C contrasts use only t2
    expect(a.contrasts.TminusC.nClusters).toBe(1);
  });

  it("is reproducible: same inputs => identical CI", () => {
    const a1 = analyzeDrift(runs, scores, { resamples: 300, seed: "x" });
    const a2 = analyzeDrift(runs, scores, { resamples: 300, seed: "x" });
    expect(a1.contrasts.TminusP.ci95).toEqual(a2.contrasts.TminusP.ci95);
  });
});
