/**
 * judge-run.ts — select which runs to judge and run the panel over them.
 *
 * Pure selection logic (selectRunsToJudge) is unit-tested; judgeRuns just maps
 * the panel over the selection with the injected JudgeFn (real one is metered).
 */

import type { RunResult, TaskSpec } from "./types.js";
import { runJudgePanel, type JudgeFn, type JudgeInput, type RunDriftScore } from "./judge.js";

export interface JudgeSelection {
  runId: string;
  input: JudgeInput;
}

/**
 * Choose runs eligible for judging. A run is judged only if:
 *  - it passed the gate (unless judgeAll), AND
 *  - it has a non-empty captured diff, AND
 *  - its task carries conventionTargets, AND
 *  - it has not already been judged.
 *
 * The primary endpoint scores drift among PASSING solutions, so judgeAll=false
 * is the default. Returns selections paired with a blinded JudgeInput.
 */
export function selectRunsToJudge(
  runs: RunResult[],
  tasksById: Map<string, TaskSpec>,
  alreadyJudgedIds: Set<string>,
  judgeAll = false,
): JudgeSelection[] {
  const out: JudgeSelection[] = [];
  for (const run of runs) {
    if (alreadyJudgedIds.has(run.runId)) continue;
    if (!judgeAll && !run.passed) continue;
    if (typeof run.diff !== "string" || run.diff.trim().length === 0) continue;
    const task = tasksById.get(run.taskId);
    if (!task || !task.conventionTargets || task.conventionTargets.length === 0) continue;
    out.push({
      runId: run.runId,
      input: {
        taskId: run.taskId,
        conventionTargets: task.conventionTargets,
        diff: run.diff,
      },
    });
  }
  return out;
}

/**
 * Run the judge panel over a selection. Calls onResult for each completed score
 * (so the CLI can persist incrementally / resume). Returns all scores.
 */
export async function judgeRuns(
  selection: JudgeSelection[],
  judgeFn: JudgeFn,
  nJudges: number,
  onResult?: (score: RunDriftScore) => Promise<void>,
): Promise<RunDriftScore[]> {
  const scores: RunDriftScore[] = [];
  for (const sel of selection) {
    const score = await runJudgePanel(sel.runId, sel.input, judgeFn, nJudges);
    scores.push(score);
    if (onResult) await onResult(score);
  }
  return scores;
}
