import { describe, it, expect } from "vitest";
import type { Arm, Rates, PerTurnUsage, RepoSpec, TaskSpec, RunResult } from "../src/types.js";

describe("Core types", () => {
  it("constructs a typed Arm value", () => {
    const arm: Arm = "T";
    expect(arm).toBe("T");
  });

  it("constructs a typed Rates object", () => {
    const rates: Rates = {
      input: 0.000003,
      output: 0.000015,
      cacheWrite: 0.00000375,
      cacheRead: 0.00000075,
    };
    expect(rates.input).toBe(0.000003);
  });

  it("constructs a typed PerTurnUsage object", () => {
    const usage: PerTurnUsage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 50,
    };
    expect(usage.input_tokens).toBe(1000);
  });

  it("constructs a typed RepoSpec object", () => {
    const repo: RepoSpec = {
      id: "repo-1",
      language: "python",
      gitUrl: "https://github.com/example/repo.git",
      sha: "abc123def456",
      testCmd: "pytest tests/",
      setupCmd: "pip install -r requirements.txt",
      placeboFrom: "repo-2",
      postCutoff: false,
    };
    expect(repo.id).toBe("repo-1");
  });

  it("constructs a typed TaskSpec object", () => {
    const task: TaskSpec = {
      id: "task-1",
      repoId: "repo-1",
      kind: "positive",
      prompt: "Fix the failing test in src/main.py",
      gateTestCmd: "pytest tests/test_main.py",
    };
    expect(task.kind).toBe("positive");
  });

  it("constructs a typed RunResult object", () => {
    const result: RunResult = {
      runId: "run-1",
      repoId: "repo-1",
      taskId: "task-1",
      arm: "C",
      replicate: 1,
      modelId: "claude-opus-4",
      cliVersion: "1.0.0",
      usage: {
        input_tokens: 5000,
        output_tokens: 1000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 100,
      },
      costUsd: 0.025,
      reportedCostUsd: null,
      passed: true,
      censored: false,
      competingFailure: false,
      compactionEvents: 2,
      startedAt: "2026-06-26T10:00:00Z",
      durationMs: 5000,
    };
    expect(result.passed).toBe(true);
  });
});
