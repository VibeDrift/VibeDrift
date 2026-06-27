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
  /** Repo id whose context.md is used as this repo's wrong-repo placebo. */
  placeboFrom: string;
  postCutoff: boolean; // pretraining-contamination stratum
}

export interface TaskSpec {
  id: string;
  repoId: string;
  kind: "positive" | "negative-control";
  prompt: string; // the instruction given to claude -p
  applyTestsPatch?: string; // path to the merged-PR test patch to apply before gating
  gateTestCmd: string; // deterministic acceptance command
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
  startedAt: string;
  durationMs: number;
}
