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
 * the walk carries its own hard caps: per-file size, total bytes, and file
 * count. Exceeding the count/byte budget aborts to null rather than reporting
 * a truncated sum as the whole story. Runs once per locked SessionStart, never
 * on the capture path.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseJsonlLines } from "./ledger.js";
import { summarize } from "./summary.js";

export const RECAP_MAX_FILES = 200;
export const RECAP_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const RECAP_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

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
}

export function sumLocalLedgerTotals(
  sessionsDir: string,
  budget: RecapReadBudget = {},
): TrialRecapTotals | null {
  const maxFiles = budget.maxFiles ?? RECAP_MAX_FILES;
  const maxFileBytes = budget.maxFileBytes ?? RECAP_MAX_FILE_BYTES;
  const maxTotalBytes = budget.maxTotalBytes ?? RECAP_MAX_TOTAL_BYTES;
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
      // sidecars (.outcomes.json/.intent.json) and consent.log live beside the
      // ledgers; only the per-session .jsonl tapes are session evidence.
      if (!name.endsWith(".jsonl")) continue;
      const path = join(sessionsDir, project, name);
      let size: number;
      try {
        size = statSync(path).size;
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
