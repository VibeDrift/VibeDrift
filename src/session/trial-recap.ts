/**
 * Trial recap totals for the locked-attempt prompt (P0.3): sum what the watch
 * ACTUALLY caught, from the real local session ledgers, across every project on
 * this machine (the trial is account-wide, not per-repo).
 *
 * Honesty constraints: only files that exist and read cleanly contribute; an
 * unreadable or oversized file is skipped and marks the read `complete: false`
 * (a partial read can support "flagged at least this" but never "ran clean"),
 * and when nothing was readable the answer is null so the caller falls back to
 * copy with no claims in it.
 *
 * Budget: the walk is synchronous, and the hook's 2s self-timeout cannot
 * preempt sync I/O (a setTimeout only fires once the event loop is free), so
 * the walk carries its own hard caps: per-file size, total bytes, file count,
 * AND a wall-clock deadline checked between files. The count/byte caps alone
 * are not enough on a slow or cloud-synced filesystem, where even
 * RECAP_MAX_FILES small reads can individually stall — the deadline is what
 * actually bounds elapsed time rather than just bytes read. Exceeding any
 * budget aborts to null rather than reporting a truncated sum as the whole
 * story. Runs once per locked SessionStart, never on the capture path.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseJsonlLines } from "./ledger.js";
import { summarize } from "./summary.js";

export const RECAP_MAX_FILES = 200;
export const RECAP_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const RECAP_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Wall-clock budget for the whole walk, checked between files. Small on
 *  purpose: this runs synchronously on the SessionStart hot path, inside a 2s
 *  self-timeout that cannot preempt sync I/O, alongside everything else the
 *  hook still has to do before it returns. */
export const RECAP_MAX_TIME_MS = 500;

export interface TrialRecapTotals {
  /** confirmed (non-experimental) flags, as `summarize` counts them */
  flagged: number;
  /** verified re-checked fixes, never the agent's stated intent */
  resolved: number;
  /** false when any ledger was skipped (size cap or read error): the sums are
   *  then a floor, and "ran clean" can no longer be claimed from them */
  complete: boolean;
}

export interface RecapReadBudget {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** wall-clock budget in ms; see RECAP_MAX_TIME_MS. */
  maxTimeMs?: number;
}

export function sumLocalLedgerTotals(
  sessionsDir: string,
  budget: RecapReadBudget = {},
  now: () => number = Date.now,
): TrialRecapTotals | null {
  const maxFiles = budget.maxFiles ?? RECAP_MAX_FILES;
  const maxFileBytes = budget.maxFileBytes ?? RECAP_MAX_FILE_BYTES;
  const maxTotalBytes = budget.maxTotalBytes ?? RECAP_MAX_TOTAL_BYTES;
  const maxTimeMs = budget.maxTimeMs ?? RECAP_MAX_TIME_MS;
  const deadline = now() + maxTimeMs;
  let flagged = 0;
  let resolved = 0;
  let filesRead = 0;
  let bytesRead = 0;
  let complete = true;
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(sessionsDir);
  } catch {
    return null;
  }
  for (const project of projectDirs) {
    let names: string[];
    try {
      names = readdirSync(join(sessionsDir, project));
    } catch {
      continue;
    }
    for (const name of names) {
      // Wall-clock deadline, checked between files: the byte/count caps bound
      // how much this walk reads, but not how long each read takes, and a
      // slow or cloud-synced filesystem (OneDrive, a network share) can make
      // even a small, in-budget file stall well past what the hook can
      // afford. A partial sum here is honest (complete:false), same as every
      // other skip in this walk; a hung hook is not.
      // Matches the count/byte budget below: a walk that ran out of time is a
      // truncated corpus, and a truncated corpus cannot honestly be summed as
      // "what the trial caught" — abort to the no-claims fallback rather than
      // reporting a partial floor.
      if (now() > deadline) return null;
      // sidecars (.outcomes.json/.intent.json) and consent.log live beside the
      // ledgers; only the per-session .jsonl tapes are session evidence.
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionsDir, project, name);
      let size: number;
      try {
        const st = statSync(path);
        // A non-regular file (FIFO, socket, device) reports a bogus size, and a
        // readFileSync on a writer-less FIFO blocks the thread forever, which no
        // in-process timer can interrupt and which defeats every cap below.
        // statSync follows symlinks, so a symlink to a real ledger still reads as
        // a regular file; skip anything that is not one.
        if (!st.isFile()) {
          complete = false;
          continue;
        }
        size = st.size;
      } catch {
        complete = false;
        continue;
      }
      if (size > maxFileBytes) {
        complete = false;
        continue;
      }
      // Count/byte budget exceeded: a truncated corpus cannot honestly be
      // summed as "what the trial caught", so abort to the no-claims fallback.
      if (filesRead >= maxFiles || bytesRead + size > maxTotalBytes) return null;
      try {
        const s = summarize(parseJsonlLines(readFileSync(path, "utf8")));
        flagged += s.flagged;
        resolved += s.resolved;
        filesRead++;
        bytesRead += size;
      } catch {
        // unreadable ledger: skip it rather than guess
        complete = false;
      }
    }
  }
  return filesRead > 0 ? { flagged, resolved, complete } : null;
}
