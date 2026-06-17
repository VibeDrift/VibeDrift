import { introducedDrift } from "./measure.js";
import { SCORING_VERSION } from "../src/scoring/engine.js";
import type {
  AgentRunner, ArmResult, EvalReport, EvalTask, RepoContext, TaskResult, Treatment,
} from "./types.js";

export interface RunEvalOpts {
  trials: number;
  control: Treatment;
  treatment: Treatment;
  /** Map a task's repo name to its absolute dir (e.g. fixtures.repoDir). */
  resolveRepoDir: (repo: string) => string;
  /** Derive VibeDrift's guidance for a repo (dominant patterns + declared rules).
   *  Omitted in unit tests (the StubRunner ignores guidance); supplied for the
   *  real run so the "context"/"tools" arms actually receive it. */
  buildGuidance?: (rootDir: string) => Promise<RepoContext["guidance"]>;
  model?: string;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

async function runArm(
  runner: AgentRunner, ctx: RepoContext, task: EvalTask, treatment: Treatment, trials: number,
): Promise<{ result: ArmResult; lastBody: string }> {
  const drifts: number[] = [];
  let lastBody = "";
  for (let i = 0; i < trials; i++) {
    const artifacts = await runner.run(ctx, task, treatment);
    lastBody = artifacts.map((a) => a.body).join("\n\n");
    const m = await introducedDrift(ctx.rootDir, artifacts);
    drifts.push(m.introduced);
  }
  return {
    result: { treatment, trials, meanDrift: mean(drifts), stdevDrift: stdev(drifts), drifts },
    lastBody,
  };
}

/**
 * Run the full eval: for each task, run a control arm and a treatment arm N
 * trials each, score every output's introduced drift, and aggregate into a
 * drift-delta. Pure orchestration over the injected `runner` + `resolveRepoDir`
 * — deterministic when the runner is (the LLM variance lives inside the runner,
 * absorbed by the N-trial mean ± stdev).
 */
export async function runEval(
  tasks: EvalTask[], runner: AgentRunner, opts: RunEvalOpts,
): Promise<EvalReport> {
  const tasksOut: TaskResult[] = [];

  for (const task of tasks) {
    const rootDir = opts.resolveRepoDir(task.repo);
    const guidance = opts.buildGuidance ? await opts.buildGuidance(rootDir) : undefined;
    const ctxFor = (t: Treatment): RepoContext =>
      t === "none" ? { rootDir } : { rootDir, guidance };

    const control = await runArm(runner, ctxFor(opts.control), task, opts.control, opts.trials);
    const treat = await runArm(runner, ctxFor(opts.treatment), task, opts.treatment, opts.trials);

    tasksOut.push({
      taskId: task.id,
      repo: task.repo,
      control: control.result,
      treatment: treat.result,
      delta: control.result.meanDrift - treat.result.meanDrift,
      example: { controlBody: control.lastBody, treatmentBody: treat.lastBody },
    });
  }

  const meanDriftControl = mean(tasksOut.map((t) => t.control.meanDrift));
  const meanDriftTreatment = mean(tasksOut.map((t) => t.treatment.meanDrift));
  return {
    scoringVersion: SCORING_VERSION,
    model: opts.model,
    trials: opts.trials,
    meanDriftControl,
    meanDriftTreatment,
    delta: meanDriftControl - meanDriftTreatment,
    tasks: tasksOut,
  };
}
