/**
 * Trial recap totals for the locked-attempt prompt (P0.3): sum what the trial
 * ACTUALLY caught, from the real local session ledgers, across every project on
 * this machine (the trial is account-wide, not per-repo).
 *
 * Honesty constraints: only files that exist and read cleanly contribute; an
 * unreadable file is skipped, and when nothing was readable the answer is null
 * so the caller falls back to copy with no numbers in it. Synchronous and
 * bounded by the local ledger count; runs once per locked SessionStart, never
 * on the capture path.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonlLines } from "./ledger.js";
import { summarize } from "./summary.js";

export interface TrialRecapTotals {
  /** confirmed (non-experimental) flags, as `summarize` counts them */
  flagged: number;
  /** verified re-checked fixes, never the agent's stated intent */
  resolved: number;
}

export function sumLocalLedgerTotals(sessionsDir: string): TrialRecapTotals | null {
  let flagged = 0;
  let resolved = 0;
  let filesRead = 0;
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
      try {
        const s = summarize(parseJsonlLines(readFileSync(join(sessionsDir, project, name), "utf8")));
        flagged += s.flagged;
        resolved += s.resolved;
        filesRead++;
      } catch {
        // unreadable ledger: skip it rather than guess
      }
    }
  }
  return filesRead > 0 ? { flagged, resolved } : null;
}
