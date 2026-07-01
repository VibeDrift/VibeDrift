import { parseClaudeUsage } from "./usage.js";
import { computeRunCostUsd } from "./pricing.js";
import type { RepoSpec, TaskSpec, Arm, RunResult, Rates } from "./types.js";
import type { GateResult } from "./gate.js";

export interface RunOneContext {
  modelId: string;
  cliVersion: string;
  maxTurns: number;
  reruns: number;
  rates: Rates;
}

export interface RunOneDeps {
  prepareWorkspace: (
    repo: RepoSpec,
    arm: Arm,
    replicate: number
  ) => Promise<{ cwd: string }>;
  applyArm: (cwd: string, arm: Arm) => Promise<void>;
  applyTestsPatch: (cwd: string, task: TaskSpec) => Promise<void>;
  /** Returns claude -p stdout. METERED in real life; inject a fake in tests. */
  runAgent: (
    cwd: string,
    task: TaskSpec,
    arm: Arm,
    modelId: string,
    maxTurns: number
  ) => Promise<string>;
  /**
   * Capture the agent's BLINDED source diff after it runs and BEFORE reassertTests
   * mutates the test files. Must exclude harness artifacts (.mcp.json, the injected
   * CLAUDE.md directive, .vibedrift/) and the task's test files so the judge cannot
   * infer the arm. Non-destructive (leaves the working tree intact for gating).
   */
  captureDiff: (
    cwd: string,
    task: TaskSpec,
    arm: Arm
  ) => Promise<{ diff: string; truncated: boolean }>;
  /**
   * Restore the canonical test files AFTER the agent runs and BEFORE gating, so
   * the agent cannot weaken/delete the gate's tests to pass. Reverts the test
   * patch's files to base and re-applies the patch; agent source edits are kept.
   */
  reassertTests: (cwd: string, task: TaskSpec) => Promise<void>;
  gate: (cwd: string, cmd: string, reruns: number) => Promise<GateResult>;
  /** Remove the run's workspace to reclaim disk. Runs in a finally (best-effort). */
  cleanup: (cwd: string) => Promise<void>;
}

/**
 * Execute one benchmark run.
 *
 * Orchestration order:
 *   prepareWorkspace → applyArm → applyTestsPatch → runAgent →
 *   parseClaudeUsage → captureDiff → reassertTests → gate → assemble RunResult
 *
 * The caller is responsible for persisting the result via store.appendResult.
 */
export async function runOne(
  repo: RepoSpec,
  task: TaskSpec,
  arm: Arm,
  replicate: number,
  ctx: RunOneContext,
  deps: RunOneDeps
): Promise<RunResult> {
  const startMs = Date.now();
  const startedAt = new Date(startMs).toISOString();

  // 1. Prepare a fresh workspace
  const { cwd } = await deps.prepareWorkspace(repo, arm, replicate);

  let gateResult: GateResult;
  let parsed: ReturnType<typeof parseClaudeUsage>;
  let captured: { diff: string; truncated: boolean };
  try {
    // 2. Apply the arm-specific config (T attaches the VibeDrift MCP)
    await deps.applyArm(cwd, arm);

    // 3. Apply the task's test patch (if any) before the agent runs
    await deps.applyTestsPatch(cwd, task);

    // 4. Run the agent (METERED boundary — real impl calls `claude -p`)
    const stdout = await deps.runAgent(cwd, task, arm, ctx.modelId, ctx.maxTurns);

    // 5. Parse token usage from agent stdout
    parsed = parseClaudeUsage(stdout);

    // 6. Capture the agent's blinded source diff BEFORE reassertTests mutates
    //    the test files. Non-destructive (restores the index/working tree).
    captured = await deps.captureDiff(cwd, task, arm);

    // 7. Restore canonical tests (agent must not be able to weaken the gate)
    await deps.reassertTests(cwd, task);

    // 8. Run the acceptance gate (with retry/flake detection)
    gateResult = await deps.gate(cwd, task.gateTestCmd, ctx.reruns);
  } finally {
    // Always reclaim the workspace (clones + node_modules are large).
    await deps.cleanup(cwd);
  }

  const durationMs = Date.now() - startMs;

  // 7. Classify outcome
  const passed = gateResult.passed;
  const censored = !passed && parsed.turns >= ctx.maxTurns;
  const competingFailure = !passed && !censored;

  return {
    runId: `${repo.id}__${task.id}__${arm}__r${replicate}`,
    repoId: repo.id,
    taskId: task.id,
    arm,
    replicate,
    modelId: parsed.modelId ?? ctx.modelId,
    cliVersion: ctx.cliVersion,
    usage: parsed.usage,
    costUsd: computeRunCostUsd(parsed.usage, ctx.rates),
    reportedCostUsd: parsed.reportedCostUsd ?? null,
    passed,
    censored,
    competingFailure,
    compactionEvents: parsed.compactionEvents,
    vibedriftToolCalls: parsed.vibedriftToolCalls,
    startedAt,
    durationMs,
    diff: captured.diff,
    diffTruncated: captured.truncated,
  };
}
