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
  ) => Promise<{ cwd: string; ownContextMd: string; placeboContextMd: string }>;
  applyArm: (
    cwd: string,
    arm: Arm,
    ownContextMd: string,
    placeboContextMd: string
  ) => Promise<void>;
  applyTestsPatch: (cwd: string, task: TaskSpec) => Promise<void>;
  /** Returns claude -p stdout. METERED in real life; inject a fake in tests. */
  runAgent: (
    cwd: string,
    task: TaskSpec,
    modelId: string,
    maxTurns: number
  ) => Promise<string>;
  gate: (cwd: string, cmd: string, reruns: number) => Promise<GateResult>;
}

/**
 * Execute one benchmark run.
 *
 * Orchestration order:
 *   prepareWorkspace → applyArm → applyTestsPatch → runAgent →
 *   parseClaudeUsage → gate → assemble RunResult
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
  const { cwd, ownContextMd, placeboContextMd } = await deps.prepareWorkspace(
    repo,
    arm,
    replicate
  );

  // 2. Inject the arm-specific context block into CLAUDE.md
  await deps.applyArm(cwd, arm, ownContextMd, placeboContextMd);

  // 3. Apply the task's test patch (if any) before the agent runs
  await deps.applyTestsPatch(cwd, task);

  // 4. Run the agent (METERED boundary — real impl calls `claude -p`)
  const stdout = await deps.runAgent(cwd, task, ctx.modelId, ctx.maxTurns);

  // 5. Parse token usage from agent stdout
  const parsed = parseClaudeUsage(stdout);

  // 6. Run the acceptance gate (with retry/flake detection)
  const gateResult = await deps.gate(cwd, task.gateTestCmd, ctx.reruns);

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
    startedAt,
    durationMs,
  };
}
