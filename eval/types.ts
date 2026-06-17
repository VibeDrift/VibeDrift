// Shared types for the drift-delta eval harness.

/** A code artifact the agent produced; `path` is relative to the repo root. */
export interface Artifact {
  path: string;
  body: string;
}

/** How much VibeDrift the agent had access to for an arm.
 *  - "none":    agent alone (control)
 *  - "context": VibeDrift's repo knowledge injected into the prompt
 *  - "tools":   real MCP tool-use in the loop (deferred) */
export type Treatment = "none" | "context" | "tools";

/** A coding task: a prompt that tempts drift, answerable from the repo alone. */
export interface EvalTask {
  id: string;
  repo: string;        // seed-repo dir name under eval/fixtures/repos/
  targetPath: string;  // new file the agent writes, relative to the repo root
  prompt: string;
}

/** VibeDrift's view of a repo, injected for the "context" treatment and
 *  withheld for "none". Derived from the repo's baseline (dominant votes +
 *  declared intent hints). */
export interface RepoContext {
  rootDir: string;
  guidance?: { dominantPatterns: Record<string, string>; declaredRules: string[] };
}

/** Produces code for a task under a given treatment. The real implementation
 *  calls an LLM; tests use a deterministic stub. */
export interface AgentRunner {
  run(ctx: RepoContext, task: EvalTask, treatment: Treatment): Promise<Artifact[]>;
}

/** Result of scoring one set of new files against a seed repo's patterns. */
export interface DriftMeasure {
  /** # of drift findings (full engine) the new file(s) participate in. Lower = conformed. */
  introduced: number;
  bySeverity: { info: number; warning: number; error: number };
  findings: Array<{ category: string; detector: string; dominantPattern: string; file: string }>;
  /** Pinned scoring version, so eval runs are comparable across releases. */
  scoringVersion: string;
}

/** Aggregated drift for one arm of one task across N trials. */
export interface ArmResult {
  treatment: Treatment;
  trials: number;
  meanDrift: number;
  stdevDrift: number;
  /** Raw per-trial introduced-drift values (length === trials), retained so the
   *  analyzer can show within-arm noise, not just the mean. */
  drifts: number[];
}

/** Control vs treatment for a single task. */
export interface TaskResult {
  taskId: string;
  repo: string;
  control: ArmResult;
  treatment: ArmResult;
  delta: number; // control.meanDrift − treatment.meanDrift; positive = VibeDrift helped
  example?: { controlBody: string; treatmentBody: string };
}

/** The whole experiment. `delta > 0` means agent+VibeDrift introduced less drift. */
export interface EvalReport {
  scoringVersion: string;
  model?: string;
  trials: number;
  meanDriftControl: number;
  meanDriftTreatment: number;
  delta: number;
  tasks: TaskResult[];
  /** Condition metadata, so a report self-describes which cell of the matrix it
   *  is (set by run.ts; the analyzer reads these to label conditions). */
  sampleCap?: number;
  taskFile?: string;
  label?: string;
}
