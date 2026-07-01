/**
 * Experiment arms:
 *   C — Control: bare task prompt, no MCP, no nudge.
 *   P — Instruction-only (active placebo): the nudge (reuse existing code, match
 *       conventions) WITHOUT the MCP and without baseline warming.
 *   T — Treatment: the same nudge plus the VibeDrift MCP + a warmed local baseline.
 *
 * Primary drift-quality contrast is T vs P (the MCP's marginal effect over the
 * nudge). C is the headroom floor.
 */
export type Arm = "C" | "P" | "T";

export interface Rates {
  // USD per token
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface PerTurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface RepoSpec {
  id: string;
  language: string;
  gitUrl: string;
  sha: string;
  testCmd: string;
  setupCmd?: string;
  postCutoff: boolean; // pretraining-contamination stratum
}

/**
 * A checkable convention the change should satisfy, derived from the real merged
 * PR. This is the GROUND TRUTH the blinded judge scores the agent's diff against
 * — it is independent of VibeDrift's own detectors (no "grading its own homework").
 */
export interface ConventionTarget {
  axis: "reuse" | "naming" | "error-handling" | "imports" | "other";
  /** What the change should do, in repo terms (e.g. "reuse the existing `pipe` helper"). */
  expectation: string;
  /** Why this is the repo's convention (grounds the target in the codebase). */
  rationale: string;
}

export interface TaskSpec {
  id: string;
  repoId: string;
  kind: "positive" | "negative-control";
  prompt: string; // the instruction given to claude -p
  applyTestsPatch?: string; // path to the merged-PR test patch to apply before gating
  gateTestCmd: string; // deterministic acceptance command
  /** Ground-truth conventions the blinded judge scores adherence against. */
  conventionTargets?: ConventionTarget[];
}

export interface RunResult {
  runId: string;
  repoId: string;
  taskId: string;
  arm: Arm;
  replicate: number;
  modelId: string;
  cliVersion: string;
  usage: PerTurnUsage; // summed across all turns
  costUsd: number;
  reportedCostUsd: number | null;
  passed: boolean;
  censored: boolean; // censored = hit --max-turns / budget
  competingFailure: boolean; // finished but wrong
  compactionEvents: number;
  vibedriftToolCalls: number; // count of mcp__vibedrift__* tool_use blocks the agent made
  startedAt: string;
  durationMs: number;
  /**
   * The agent's BLINDED source diff (unified) captured before cleanup, with all
   * harness artifacts excluded (.mcp.json, the injected CLAUDE.md directive,
   * .vibedrift/, and the task's test files). This is what the blinded convention
   * judge scores — it carries no signal of which arm produced it. Optional so
   * pre-diff-capture rows (and unit fixtures) remain valid; real runs populate it.
   */
  diff?: string;
  /** True if the captured diff exceeded the size cap and was truncated. */
  diffTruncated?: boolean;
}
