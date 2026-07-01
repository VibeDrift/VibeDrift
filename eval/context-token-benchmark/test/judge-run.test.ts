import { describe, it, expect } from "vitest";
import { selectRunsToJudge } from "../src/judge-run.js";
import type { Arm, RunResult, TaskSpec } from "../src/types.js";

const TASK_WITH_TARGETS: TaskSpec = {
  id: "t1",
  repoId: "repo",
  kind: "positive",
  prompt: "do x",
  gateTestCmd: "npm test",
  conventionTargets: [{ axis: "reuse", expectation: "reuse y", rationale: "repo uses y" }],
};
const TASK_NO_TARGETS: TaskSpec = {
  id: "t2",
  repoId: "repo",
  kind: "positive",
  prompt: "do z",
  gateTestCmd: "npm test",
};

function run(taskId: string, arm: Arm, passed: boolean, diff: string | undefined): RunResult {
  return {
    runId: `repo__${taskId}__${arm}__r0`,
    repoId: "repo",
    taskId,
    arm,
    replicate: 0,
    modelId: "m",
    cliVersion: "0.1.0",
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    costUsd: 0,
    reportedCostUsd: null,
    passed,
    censored: false,
    competingFailure: !passed,
    compactionEvents: 0,
    vibedriftToolCalls: 0,
    startedAt: "2026-06-29T00:00:00.000Z",
    durationMs: 1,
    diff,
  };
}

const tasksById = new Map<string, TaskSpec>([
  ["t1", TASK_WITH_TARGETS],
  ["t2", TASK_NO_TARGETS],
]);

describe("selectRunsToJudge", () => {
  it("selects a passing run with a diff and targets", () => {
    const sel = selectRunsToJudge([run("t1", "T", true, "some diff")], tasksById, new Set());
    expect(sel).toHaveLength(1);
    expect(sel[0].runId).toBe("repo__t1__T__r0");
    expect(sel[0].input.conventionTargets).toHaveLength(1);
    expect(sel[0].input.diff).toBe("some diff");
  });

  it("excludes failed runs by default but includes them with judgeAll", () => {
    const runs = [run("t1", "C", false, "diff")];
    expect(selectRunsToJudge(runs, tasksById, new Set())).toHaveLength(0);
    expect(selectRunsToJudge(runs, tasksById, new Set(), true)).toHaveLength(1);
  });

  it("excludes runs with an empty or missing diff", () => {
    expect(selectRunsToJudge([run("t1", "T", true, "")], tasksById, new Set())).toHaveLength(0);
    expect(selectRunsToJudge([run("t1", "T", true, "   ")], tasksById, new Set())).toHaveLength(0);
    expect(selectRunsToJudge([run("t1", "T", true, undefined)], tasksById, new Set())).toHaveLength(0);
  });

  it("excludes tasks without conventionTargets", () => {
    expect(selectRunsToJudge([run("t2", "T", true, "diff")], tasksById, new Set())).toHaveLength(0);
  });

  it("excludes already-judged runIds", () => {
    const r = run("t1", "T", true, "diff");
    expect(selectRunsToJudge([r], tasksById, new Set([r.runId]))).toHaveLength(0);
  });
});
