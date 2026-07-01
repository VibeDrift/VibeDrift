import { describe, it, expect } from "vitest";
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  runJudgePanel,
  type JudgeInput,
  type JudgeFn,
} from "../src/judge.js";
import type { ConventionTarget } from "../src/types.js";

const TARGETS: ConventionTarget[] = [
  {
    axis: "reuse",
    expectation: "reuse the existing `pipe` helper instead of a new compose",
    rationale: "the repo composes via pipe() everywhere",
  },
  {
    axis: "naming",
    expectation: "name the function in camelCase like its neighbors",
    rationale: "all functions in this module are camelCase",
  },
];

const INPUT: JudgeInput = {
  taskId: "task-1",
  conventionTargets: TARGETS,
  diff: "--- a/src/x.ts\n+++ b/src/x.ts\n@@\n+export const y = pipe(a, b);",
};

describe("buildJudgePrompt", () => {
  it("includes every convention target and the diff", () => {
    const p = buildJudgePrompt(INPUT);
    expect(p).toContain("reuse the existing `pipe` helper");
    expect(p).toContain("camelCase");
    expect(p).toContain("export const y = pipe(a, b);");
    expect(p).toContain("targetScores");
  });

  it("stays blind: leaks no arm / tool / product identity", () => {
    const p = buildJudgePrompt(INPUT).toLowerCase();
    for (const leak of ["vibedrift", "mcp", "treatment", "control", "placebo", "arm "]) {
      expect(p).not.toContain(leak);
    }
  });

  it("handles an empty diff gracefully", () => {
    const p = buildJudgePrompt({ ...INPUT, diff: "" });
    expect(p).toContain("empty diff");
  });
});

describe("parseJudgeVerdict", () => {
  it("parses clean strict JSON", () => {
    const v = parseJudgeVerdict('{"targetScores":[2,1],"holistic":2,"notes":"ok"}', 2);
    expect(v.targetScores).toEqual([2, 1]);
    expect(v.holistic).toBe(2);
    expect(v.notes).toBe("ok");
  });

  it("tolerates ```json fences and surrounding prose", () => {
    const raw = 'Here is my verdict:\n```json\n{"targetScores":[0,2],"holistic":1,"notes":"x"}\n```\nThanks!';
    const v = parseJudgeVerdict(raw, 2);
    expect(v.targetScores).toEqual([0, 2]);
    expect(v.holistic).toBe(1);
  });

  it("clamps out-of-range and rounds fractional scores", () => {
    const v = parseJudgeVerdict('{"targetScores":[5,-3],"holistic":1.6,"notes":""}', 2);
    expect(v.targetScores).toEqual([2, 0]);
    expect(v.holistic).toBe(2);
  });

  it("throws when targetScores length != nTargets", () => {
    expect(() => parseJudgeVerdict('{"targetScores":[2],"holistic":2}', 2)).toThrow();
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseJudgeVerdict("I cannot comply.", 2)).toThrow();
  });

  it("throws when targetScores is missing/not an array", () => {
    expect(() => parseJudgeVerdict('{"holistic":2}', 2)).toThrow();
  });
});

/** A JudgeFn that always returns the same fixed verdict JSON. */
function fixedJudge(targetScores: number[], holistic: number): JudgeFn {
  return async () =>
    JSON.stringify({ targetScores, holistic, notes: "fixed" });
}

describe("runJudgePanel", () => {
  it("perfect adherence (all 2s) => driftScore 0", async () => {
    const r = await runJudgePanel("run-1", INPUT, fixedJudge([2, 2], 2), 3);
    expect(r.driftScore).toBe(0);
    expect(r.holisticDrift).toBe(0);
    expect(r.nJudges).toBe(3);
    expect(r.nJudgeFailures).toBe(0);
  });

  it("full violation (all 0s) => driftScore 1", async () => {
    const r = await runJudgePanel("run-1", INPUT, fixedJudge([0, 0], 0), 3);
    expect(r.driftScore).toBe(1);
    expect(r.holisticDrift).toBe(1);
  });

  it("mixed scores [2,0] => driftScore 0.5 and correct per-axis drift", async () => {
    const r = await runJudgePanel("run-1", INPUT, fixedJudge([2, 0], 1), 3);
    expect(r.driftScore).toBeCloseTo(0.5, 10);
    expect(r.holisticDrift).toBeCloseTo(0.5, 10);
    // target 0 is axis "reuse" (score 2 -> drift 0), target 1 is "naming" (score 0 -> drift 1)
    expect(r.driftByAxis.reuse).toBeCloseTo(0, 10);
    expect(r.driftByAxis.naming).toBeCloseTo(1, 10);
    // identical judges => zero spread
    expect(r.judgeStdev).toBeCloseTo(0, 10);
  });

  it("drops unparseable judges and counts them", async () => {
    let call = 0;
    const flaky: JudgeFn = async () => {
      call++;
      // 2nd judge emits garbage, others valid
      return call === 2
        ? "no json here"
        : JSON.stringify({ targetScores: [2, 2], holistic: 2, notes: "" });
    };
    const r = await runJudgePanel("run-1", INPUT, flaky, 3);
    expect(r.nJudges).toBe(2);
    expect(r.nJudgeFailures).toBe(1);
    expect(r.driftScore).toBe(0);
  });

  it("reports judge disagreement via judgeStdev", async () => {
    let call = 0;
    const split: JudgeFn = async () => {
      call++;
      // judge 1: all match (drift 0); judge 2: all violate (drift 1)
      return call === 1
        ? JSON.stringify({ targetScores: [2, 2], holistic: 2, notes: "" })
        : JSON.stringify({ targetScores: [0, 0], holistic: 0, notes: "" });
    };
    const r = await runJudgePanel("run-1", INPUT, split, 2);
    expect(r.perJudgeDrift).toEqual([0, 1]);
    expect(r.driftScore).toBeCloseTo(0.5, 10);
    expect(r.judgeStdev).toBeGreaterThan(0);
  });

  it("all judges fail => nJudges 0, driftScore 0, failures counted", async () => {
    const bad: JudgeFn = async () => "garbage";
    const r = await runJudgePanel("run-1", INPUT, bad, 3);
    expect(r.nJudges).toBe(0);
    expect(r.nJudgeFailures).toBe(3);
    expect(r.driftScore).toBe(0);
  });
});
