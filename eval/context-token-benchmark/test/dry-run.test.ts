/**
 * dry-run.test.ts — END-TO-END pipeline proof with ZERO metered spend.
 *
 * Exercises the REAL orchestrate -> capture -> judge-run -> analyzeDrift pipeline,
 * faking ONLY the two metered boundaries (runAgent + the JudgeFn) and the IO deps.
 * Simulates the hypothesized effect (T reuses, P partial, C reimplements) and
 * asserts the analysis recovers a negative (T drifts less) primary contrast.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expandMatrix, orchestrate } from "../src/orchestrate.js";
import { runOne, type RunOneContext, type RunOneDeps } from "../src/run-one.js";
import { loadResults } from "../src/store.js";
import { selectRunsToJudge, judgeRuns } from "../src/judge-run.js";
import { analyzeDrift } from "../src/analyze-drift.js";
import { formatReport } from "../src/analyze-cli.js";
import type { Arm, RepoSpec, TaskSpec, Rates } from "../src/types.js";
import type { JudgeFn, RunDriftScore } from "../src/judge.js";

const RATES: Rates = {
  input: 5 / 1_000_000,
  output: 25 / 1_000_000,
  cacheWrite: 6.25 / 1_000_000,
  cacheRead: 0.5 / 1_000_000,
};

const REPO: RepoSpec = {
  id: "demo",
  language: "typescript",
  gitUrl: "https://example/demo",
  sha: "deadbeef",
  testCmd: "npm test",
  postCutoff: false,
};

const TARGETS = [
  { axis: "reuse" as const, expectation: "reuse existing helper", rationale: "repo reuses" },
  { axis: "naming" as const, expectation: "camelCase", rationale: "repo is camelCase" },
];
const TASKS: TaskSpec[] = [
  { id: "t1", repoId: "demo", kind: "positive", prompt: "add feature 1", gateTestCmd: "npm test", conventionTargets: TARGETS },
  { id: "t2", repoId: "demo", kind: "positive", prompt: "add feature 2", gateTestCmd: "npm test", conventionTargets: TARGETS },
];

/** Canned claude stream-json; T includes one mcp__vibedrift__* tool_use. */
function fakeStdout(arm: Arm): string {
  const lines = [
    '{"type":"system","subtype":"init","model":"claude-opus-4-8"}',
  ];
  if (arm === "T") {
    lines.push(
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"mcp__vibedrift__find_similar_function","input":{}}]}}',
    );
  }
  lines.push(
    '{"type":"result","subtype":"success","usage":{"input_tokens":1000,"output_tokens":200,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"total_cost_usd":0.01,"num_turns":2}',
  );
  return lines.join("\n");
}

/** Simulated outcome: T reuses (low drift), P partial, C reimplements (high drift). */
function fakeDiff(arm: Arm): string {
  if (arm === "T") return "+ import { helper } from './util'\n+ export const f = () => helper(); // reuse existing helper, camelCase";
  if (arm === "P") return "+ export const f = () => { /* partial: some reuse, some new */ };";
  return "+ export function reimplement_thing() { /* brand new duplicate, snake_case */ }";
}

function fakeDeps(): RunOneDeps {
  return {
    prepareWorkspace: async () => ({ cwd: "/tmp/none" }),
    applyArm: async () => undefined,
    applyTestsPatch: async () => undefined,
    runAgent: async (_cwd, _task, arm) => fakeStdout(arm),
    captureDiff: async (_cwd, _task, arm) => ({ diff: fakeDiff(arm), truncated: false }),
    reassertTests: async () => undefined,
    gate: async () => ({ passed: true, flaky: false, attempts: 1 }),
    cleanup: async () => undefined,
  };
}

/** Fake judge: scores the blinded diff by its content (no arm visible to it). */
const fakeJudge: JudgeFn = async (input) => {
  const d = input.diff;
  let s: number;
  if (d.includes("reuse existing helper")) s = 2;
  else if (d.includes("partial")) s = 1;
  else s = 0;
  return JSON.stringify({ targetScores: [s, s], holistic: s, notes: "fake" });
};

describe("end-to-end dry run (no metered spend)", () => {
  it("recovers the hypothesized T<P<C drift ordering through the real pipeline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dryrun-"));
    const resultsPath = join(dir, "results.jsonl");
    try {
      // 1. Run the matrix through the REAL orchestrator with faked metered boundaries.
      const ctx: RunOneContext = {
        modelId: "claude-opus-4-8",
        cliVersion: "0.1.0",
        maxTurns: 30,
        reruns: 2,
        rates: RATES,
      };
      const items = expandMatrix([REPO], TASKS, 2); // 2 tasks × 3 arms × 2 reps = 12
      const summary = await orchestrate(items, {
        resultsPath,
        concurrency: 4,
        runOne: async (item) => runOne(item.repo, item.task, item.arm, item.replicate, ctx, fakeDeps()),
      });
      expect(summary.ran).toBe(12);

      // 2. Judge (real selection + panel) with the fake judge.
      const runs = await loadResults(resultsPath);
      const byId = new Map(TASKS.map((t) => [t.id, t]));
      const selection = selectRunsToJudge(runs, byId, new Set());
      expect(selection).toHaveLength(12); // all passed, all have diffs + targets
      const scores: RunDriftScore[] = await judgeRuns(selection, fakeJudge, 3);

      // 3. Analyze (real).
      const analysis = analyzeDrift(runs, scores, { resamples: 1000, seed: "dry" });

      // --- assertions: the pipeline recovers the planted effect ---
      expect(analysis.perArm.T.meanDrift).toBeCloseTo(0, 5);
      expect(analysis.perArm.P.meanDrift).toBeCloseTo(0.5, 5);
      expect(analysis.perArm.C.meanDrift).toBeCloseTo(1, 5);
      // primary contrast: T drifts LESS than P (negative, CI entirely below 0)
      expect(analysis.contrasts.TminusP.deltaMean).toBeCloseTo(-0.5, 5);
      expect(analysis.contrasts.TminusP.ci95[1]).toBeLessThan(0);
      // MCP fidelity: every T run called a vibedrift tool
      expect(analysis.mcpUsageRateT).toBeCloseTo(1, 5);
      expect(analysis.degenerateTRuns).toBe(0);

      // surface the report for eyeballing in the test log
      // eslint-disable-next-line no-console
      console.log("\n" + formatReport(analysis) + "\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
