import { describe, it, expect } from "vitest";
import { runOne } from "../src/run-one.js";
import { computeRunCostUsd } from "../src/pricing.js";
import type { RepoSpec, TaskSpec, Rates } from "../src/types.js";
import type { RunOneContext, RunOneDeps } from "../src/run-one.js";
import type { GateResult } from "../src/gate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RATES: Rates = {
  input: 15 / 1_000_000,
  output: 75 / 1_000_000,
  cacheWrite: 18.75 / 1_000_000,
  cacheRead: 1.875 / 1_000_000,
};

const REPO: RepoSpec = {
  id: "repo1",
  language: "typescript",
  gitUrl: "https://github.com/example/repo1",
  sha: "abc123",
  testCmd: "npm test",
  postCutoff: false,
};

const TASK: TaskSpec = {
  id: "task1",
  repoId: "repo1",
  kind: "positive",
  prompt: "Fix the bug in src/index.ts",
  gateTestCmd: "npm test",
};

const CTX: RunOneContext = {
  modelId: "claude-opus-4-8",
  cliVersion: "1.2.3",
  maxTurns: 10,
  reruns: 2,
  rates: RATES,
};

/**
 * A stdout string that parseClaudeUsage will parse via the authoritative result path:
 * - usage: { input: 1000, output: 200, cache_creation: 0, cache_read: 0 }
 * - turns: 2
 * - modelId: "claude-opus-4-8"
 * - compactionEvents: 0
 */
const FAKE_STDOUT_TURNS_2 = [
  '{"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":500,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"mcp__vibedrift__get_dominant_pattern","input":{}}]}}',
  '{"type":"result","subtype":"success","usage":{"input_tokens":1000,"output_tokens":200,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"total_cost_usd":0.0275,"num_turns":2}',
].join("\n");

/**
 * A stdout string where turns equals maxTurns (10), used for the censored test.
 */
const FAKE_STDOUT_TURNS_10 = [
  '{"type":"message_start","message":{"id":"msg-1","type":"message","role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":5000,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}',
  '{"type":"result","subtype":"success","usage":{"input_tokens":5000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"total_cost_usd":0.15,"num_turns":10}',
].join("\n");

// ---------------------------------------------------------------------------
// Fake deps factory
// ---------------------------------------------------------------------------

function makeDeps(overrides: {
  gateResult: GateResult;
  stdout: string;
}): RunOneDeps & { callLog: string[] } {
  const callLog: string[] = [];

  return {
    callLog,
    prepareWorkspace: async (_repo, _arm, _replicate) => {
      callLog.push("prepareWorkspace");
      return { cwd: "/tmp/fake-cwd" };
    },
    applyArm: async (_cwd, _arm) => {
      callLog.push("applyArm");
    },
    applyTestsPatch: async (_cwd, _task) => {
      callLog.push("applyTestsPatch");
    },
    runAgent: async (_cwd, _task, _arm, _modelId, _maxTurns) => {
      callLog.push("runAgent");
      return overrides.stdout;
    },
    captureDiff: async (_cwd, _task, _arm) => {
      callLog.push("captureDiff");
      return { diff: "--- a/src/x.ts\n+++ b/src/x.ts\n@@\n+fake", truncated: false };
    },
    reassertTests: async (_cwd, _task) => {
      callLog.push("reassertTests");
    },
    gate: async (_cwd, _cmd, _reruns) => {
      callLog.push("gate");
      return overrides.gateResult;
    },
    cleanup: async (_cwd) => {
      callLog.push("cleanup");
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runOne", () => {
  describe("1. happy path — gate passes", () => {
    it("returns passed=true, censored=false, competingFailure=false", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      expect(result.passed).toBe(true);
      expect(result.censored).toBe(false);
      expect(result.competingFailure).toBe(false);
      expect(result.compactionEvents).toBe(0);
      expect(result.cliVersion).toBe(CTX.cliVersion);
    });

    it("runId is correctly formatted", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      expect(result.runId).toBe("repo1__task1__T__r0");
    });

    it("costUsd equals computeRunCostUsd with the parsed usage and rates", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      const expectedUsage = {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      expect(result.costUsd).toBeCloseTo(computeRunCostUsd(expectedUsage, RATES), 10);
      expect(result.usage).toEqual(expectedUsage);
    });

    it("captures reportedCostUsd from parsed stdout (total_cost_usd field)", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      // FAKE_STDOUT_TURNS_2 result line has total_cost_usd=0.0275
      expect(result.reportedCostUsd).toBeCloseTo(0.0275, 10);
    });

    it("captures modelId from parsed stdout (not ctx.modelId)", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      // Use a different ctx.modelId to verify parsed value wins
      const result = await runOne(REPO, TASK, "T", 0, { ...CTX, modelId: "some-other-model" }, deps);

      expect(result.modelId).toBe("claude-opus-4-8");
    });

    it("flows vibedriftToolCalls through from parsed stdout", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      // FAKE_STDOUT_TURNS_2 contains one mcp__vibedrift__* tool_use block.
      expect(result.vibedriftToolCalls).toBe(1);
    });

    it("includes repoId, taskId, arm, replicate", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      const result = await runOne(REPO, TASK, "C", 3, CTX, deps);

      expect(result.repoId).toBe("repo1");
      expect(result.taskId).toBe("task1");
      expect(result.arm).toBe("C");
      expect(result.replicate).toBe(3);
    });

    it("calls deps in the correct order", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      await runOne(REPO, TASK, "T", 0, CTX, deps);

      expect(deps.callLog).toEqual([
        "prepareWorkspace",
        "applyArm",
        "applyTestsPatch",
        "runAgent",
        "captureDiff",
        "reassertTests",
        "gate",
        "cleanup",
      ]);
    });

    it("captures the blinded diff into the result", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      expect(result.diff).toBe("--- a/src/x.ts\n+++ b/src/x.ts\n@@\n+fake");
      expect(result.diffTruncated).toBe(false);
    });

    it("startedAt is an ISO string and durationMs is a non-negative number", async () => {
      const deps = makeDeps({ gateResult: { passed: true, flaky: false, attempts: 1 }, stdout: FAKE_STDOUT_TURNS_2 });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      expect(() => new Date(result.startedAt)).not.toThrow();
      expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("2. censored — gate fails and turns >= maxTurns", () => {
    it("returns censored=true, competingFailure=false, passed=false", async () => {
      const deps = makeDeps({
        gateResult: { passed: false, flaky: false, attempts: 3 },
        stdout: FAKE_STDOUT_TURNS_10,
      });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      expect(result.passed).toBe(false);
      expect(result.censored).toBe(true);
      expect(result.competingFailure).toBe(false);
    });
  });

  describe("3. competing-failure — gate fails and turns < maxTurns", () => {
    it("returns competingFailure=true, censored=false, passed=false", async () => {
      const deps = makeDeps({
        gateResult: { passed: false, flaky: false, attempts: 3 },
        stdout: FAKE_STDOUT_TURNS_2, // turns=2, maxTurns=10 → not censored
      });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      expect(result.passed).toBe(false);
      expect(result.censored).toBe(false);
      expect(result.competingFailure).toBe(true);
    });
  });

  describe("4. modelId NULL fallback — parsed modelId is null, ctx.modelId wins", () => {
    it("uses ctx.modelId when parseClaudeUsage returns modelId=null", async () => {
      // Stdout with result object but no message_start or system-init model info
      // parseClaudeUsage will return modelId: null
      const fakeStdoutNoModel = '{"type":"result","subtype":"success","usage":{"input_tokens":10,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"num_turns":1}';

      const deps = makeDeps({
        gateResult: { passed: true, flaky: false, attempts: 1 },
        stdout: fakeStdoutNoModel,
      });
      const result = await runOne(REPO, TASK, "T", 0, CTX, deps);

      expect(result.modelId).toBe(CTX.modelId);
      expect(result.reportedCostUsd).toBeNull();
    });
  });
});
