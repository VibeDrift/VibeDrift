/**
 * Which projects a turn's flush should drain.
 *
 * The flush used to take exactly one project hash — the repo the turn ended in
 * — so a session that edits several repos (a workspace checkout, a monorepo of
 * submodules, two git worktrees of the same repo) uploaded one of them and left
 * the rest on disk indefinitely. Nothing was lost locally, but the dashboard
 * showed a fraction of the work and gave no sign that the rest existed.
 *
 * This module answers "what else is waiting?" without any network or state
 * change: it lists the project directories under the sessions dir, compares
 * each ledger's size against the durable upload offset, and orders the result.
 *
 * `pending` is an UPPER BOUND, not a byte count: offsets are indexes into the
 * utf8-decoded content (see upload-state.ts) while sizes are bytes, so a ledger
 * holding multibyte characters reports a few pending bytes when it is in fact
 * fully uploaded. That asymmetry is the safe one — an extra drained-empty pass
 * costs one directory read, while under-reporting would strand events, which is
 * exactly the bug this fixes.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { UploadStateStore } from "./upload-state.js";
import { safeSegment } from "./ledger.js";

/** Projects beyond this session's own that one turn may drain. The rest wait
 *  for the next turn: a first run after a long offline stretch should not fan
 *  out over every repo on the machine inside one hook's budget. */
export const MAX_CATCH_UP_TARGETS = 8;

export interface FlushCandidate {
  projectHash: string;
  /** Upper bound on unsent content, in bytes. Zero means nothing is waiting. */
  pending: number;
  /** This session wrote into that project (its ledger file is there). */
  inSession: boolean;
  /** Newest ledger mtime, used to prefer recent work when catching up. */
  touchedAt: number;
}

/**
 * Drain order: the turn's own project first (it also owns the entitlement
 * refresh and the file-name settle, both of which must run even with nothing
 * queued), then the other repos THIS session touched, then everyone else with
 * a backlog, newest first and capped.
 *
 * Pure so the ordering is testable without a filesystem.
 */
export function orderFlushTargets(
  candidates: readonly FlushCandidate[],
  currentHash?: string,
  maxCatchUp: number = MAX_CATCH_UP_TARGETS,
): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const take = (hash: string) => {
    if (seen.has(hash)) return;
    seen.add(hash);
    order.push(hash);
  };

  if (currentHash) take(currentHash);

  const waiting = candidates.filter((c) => c.pending > 0 && c.projectHash !== currentHash);
  // Deterministic: mtime descending, then hash, so two machines with the same
  // ledgers pick the same order and a tie never depends on readdir order.
  const byRecency = (a: FlushCandidate, b: FlushCandidate) =>
    b.touchedAt - a.touchedAt || (a.projectHash < b.projectHash ? -1 : 1);

  for (const c of waiting.filter((c) => c.inSession).sort(byRecency)) take(c.projectHash);

  let catchUp = 0;
  for (const c of waiting.filter((c) => !c.inSession).sort(byRecency)) {
    if (catchUp >= maxCatchUp) break;
    catchUp += 1;
    take(c.projectHash);
  }

  return order;
}

/**
 * Read the sessions dir and describe every project that has a ledger.
 * Never throws: an unreadable directory contributes nothing, which degrades to
 * today's single-project behaviour rather than failing the turn.
 */
export async function collectFlushCandidates(
  sessionsDir: string,
  sessionId?: string,
): Promise<FlushCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const sessionFile = sessionId ? `${safeSegment(sessionId)}.jsonl` : null;
  const out: FlushCandidate[] = [];

  for (const projectHash of entries) {
    const dir = join(sessionsDir, projectHash);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue; // not a directory, or unreadable
    }
    if (files.length === 0) continue;

    const state = new UploadStateStore(sessionsDir, projectHash);
    await state.load();

    let pending = 0;
    let touchedAt = 0;
    for (const file of files) {
      try {
        const info = await stat(join(dir, file));
        pending += Math.max(0, info.size - state.get(file));
        touchedAt = Math.max(touchedAt, info.mtimeMs);
      } catch {
        // a ledger that vanished mid-scan simply contributes nothing
      }
    }

    out.push({
      projectHash,
      pending,
      inSession: sessionFile ? files.includes(sessionFile) : false,
      touchedAt,
    });
  }

  return out;
}
