import type { RepoSpec, TaskSpec, Arm, RunResult } from "./types.js";
import { appendResult, loadResults } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatrixItem {
  repo: RepoSpec;
  task: TaskSpec;
  arm: Arm;
  replicate: number;
}

export interface OrchestrateOpts {
  resultsPath: string;
  concurrency: number;
  /** Injected; default in cli wires the real runOne+deps. */
  runOne: (item: MatrixItem) => Promise<RunResult>;
}

export interface OrchestrateSummary {
  total: number;
  ran: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG: djb2 hash → Numerical Recipes LCG → Fisher-Yates
// ---------------------------------------------------------------------------

/**
 * djb2 string hash, returns an unsigned 32-bit integer.
 * Deterministic: same string → same hash, no external state.
 */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // h = h * 33 ^ charCode  (imul for 32-bit wrapping)
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/**
 * One step of the Numerical Recipes LCG.
 * a=1664525, c=1013904223, m=2^32 (all arithmetic mod 2^32 via imul/>>>0).
 */
function lcgNext(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

/**
 * Deterministic per-(taskId, replicate) arm ordering.
 *
 * Seeds an LCG from djb2(`${taskId}:${replicate}`) then Fisher-Yates
 * shuffles ["C","P","T"]. Same inputs → same order every time (reproducible).
 * No Math.random is used.
 */
export function armOrder(taskId: string, replicate: number): Arm[] {
  let state = hashStr(`${taskId}:${replicate}`);
  const arms: Arm[] = ["C", "P", "T"];
  // Fisher-Yates in-place
  for (let i = arms.length - 1; i > 0; i--) {
    state = lcgNext(state);
    const j = state % (i + 1);
    // swap
    const tmp = arms[i];
    arms[i] = arms[j];
    arms[j] = tmp;
  }
  return arms;
}

// ---------------------------------------------------------------------------
// Matrix expansion
// ---------------------------------------------------------------------------

/**
 * Expand repos × tasks (filtered by task.repoId) × arms × replicates into
 * a flat list of MatrixItems. Arm ordering per (task, replicate) is determined
 * by armOrder (deterministic, no Math.random).
 */
export function expandMatrix(
  repos: RepoSpec[],
  tasks: TaskSpec[],
  replicates: number,
): MatrixItem[] {
  const items: MatrixItem[] = [];
  for (const repo of repos) {
    const repoTasks = tasks.filter((t) => t.repoId === repo.id);
    for (const task of repoTasks) {
      for (let r = 0; r < replicates; r++) {
        const order = armOrder(task.id, r);
        for (const arm of order) {
          items.push({ repo, task, arm, replicate: r });
        }
      }
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Bounded-concurrency orchestrator with resume
// ---------------------------------------------------------------------------

/**
 * Derive the canonical runId for a MatrixItem.
 * Must match the runId formula used by runOne in run-one.ts.
 */
function makeRunId(item: MatrixItem): string {
  return `${item.repo.id}__${item.task.id}__${item.arm}__r${item.replicate}`;
}

/**
 * Resume-capable orchestrator.
 *
 * 1. Loads existing results from `opts.resultsPath` (file may not exist → []).
 * 2. Skips any MatrixItem whose runId is already present.
 * 3. Runs pending items with bounded concurrency (at most `opts.concurrency`
 *    calls to `opts.runOne` in flight at once).
 * 4. Appends each RunResult to the JSONL file as it completes.
 * 5. Returns a summary { total, ran, skipped }.
 */
export async function orchestrate(
  items: MatrixItem[],
  opts: OrchestrateOpts,
): Promise<OrchestrateSummary> {
  // Clamp concurrency to at least 1 to prevent a caller passing 0 from stalling.
  const concurrency = Math.max(1, opts.concurrency);

  // --- Resume: determine which items have already been completed ---
  const existing = await loadResults(opts.resultsPath);
  const doneIds = new Set<string>(existing.map((r) => r.runId));
  const pending = items.filter((item) => !doneIds.has(makeRunId(item)));
  const skipped = items.length - pending.length;

  if (pending.length === 0) {
    return { total: items.length, ran: 0, skipped };
  }

  // --- Bounded-concurrency worker pool ---
  let ran = 0;
  let index = 0;
  let inFlight = 0;

  await new Promise<void>((resolve, reject) => {
    const dispatch = (): void => {
      // Fill up to concurrency slots
      while (inFlight < concurrency && index < pending.length) {
        const item = pending[index++];
        inFlight++;
        opts
          .runOne(item)
          .then(async (result) => {
            await appendResult(opts.resultsPath, result);
            ran++;
            inFlight--;
            // Start next batch
            dispatch();
            // Resolve when all work is done
            if (inFlight === 0) resolve();
          })
          .catch(reject);
      }
      // Edge case: nothing was pending to begin with (caller skipped all) —
      // but we already handle pending.length === 0 above, so this covers
      // the case where concurrency > pending.length and all are dispatched
      // synchronously then nothing remains.
    };

    dispatch();
  });

  return { total: items.length, ran, skipped };
}
