/**
 * Per-session intent state: the task anchors captured from prompts plus the
 * scope-drift bookkeeping, persisted next to the ledger so the stateless hook
 * processes (prompt in one invocation, edits in later ones) share it. All I/O
 * is fail-open — a lost or corrupt file degrades to "no intent captured", never
 * an error.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { safeSegment } from "./ledger.js";
import { mergeAnchors, type Anchors } from "./anchors.js";
import { writeFileAtomic } from "./atomic-write.js";

export interface IntentState {
  anchors: Anchors;
  locked: boolean;
  task: string;
  unrelatedEdits: number;
  /** files already scope-flagged this session, so we do not re-flag them */
  scopeFlagged: string[];
}

export function emptyIntentState(): IntentState {
  return { anchors: { files: [], symbols: [], tokens: [] }, locked: false, task: "", unrelatedEdits: 0, scopeFlagged: [] };
}

function statePath(sessionsDir: string, projectHash: string, sessionId: string): string {
  return join(sessionsDir, safeSegment(projectHash), `${safeSegment(sessionId)}.intent.json`);
}

export async function readIntentState(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
): Promise<IntentState> {
  try {
    const raw = await readFile(statePath(sessionsDir, projectHash, sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<IntentState>;
    const base = emptyIntentState();
    return {
      anchors: {
        files: parsed.anchors?.files ?? base.anchors.files,
        symbols: parsed.anchors?.symbols ?? base.anchors.symbols,
        tokens: parsed.anchors?.tokens ?? base.anchors.tokens,
      },
      locked: parsed.locked ?? base.locked,
      task: parsed.task ?? base.task,
      unrelatedEdits: typeof parsed.unrelatedEdits === "number" ? parsed.unrelatedEdits : base.unrelatedEdits,
      scopeFlagged: Array.isArray(parsed.scopeFlagged) ? parsed.scopeFlagged : base.scopeFlagged,
    };
  } catch {
    return emptyIntentState();
  }
}

/** Merge two intent snapshots (this write's local state and whatever is
 *  currently on disk) so a concurrent hook subprocess for the same session
 *  never loses the other's progress to a blind overwrite (the same
 *  read-merge-write upload-state.ts's `commit()` uses, for the same reason).
 *  Anchors union (mergeAnchors, already used for the same purpose in
 *  scope.ts); `locked` prefers true, since intent, once locked, must never
 *  un-lock from a stale read; the task label follows whichever side actually
 *  holds the lock; counters take the max, since both are monotonically
 *  incremented per edit and never legitimately decrease. */
export function mergeIntentState(local: IntentState, onDisk: IntentState): IntentState {
  const locked = local.locked || onDisk.locked;
  const task = local.locked ? local.task : onDisk.locked ? onDisk.task : local.task || onDisk.task;
  return {
    anchors: mergeAnchors(local.anchors, onDisk.anchors),
    locked,
    task,
    unrelatedEdits: Math.max(local.unrelatedEdits, onDisk.unrelatedEdits),
    scopeFlagged: [...new Set([...local.scopeFlagged, ...onDisk.scopeFlagged])],
  };
}

export async function writeIntentState(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
  state: IntentState,
): Promise<void> {
  try {
    // Read-merge-write: re-read whatever is on disk right now and merge
    // rather than blindly overwrite, so a concurrent hook subprocess's
    // anchors, lock, or counters for this same session are never lost.
    const onDisk = await readIntentState(sessionsDir, projectHash, sessionId);
    const merged = mergeIntentState(state, onDisk);
    await writeFileAtomic(statePath(sessionsDir, projectHash, sessionId), JSON.stringify(merged), { mode: 0o600 });
  } catch {
    // best-effort; losing intent state degrades scope detection, never fails the hook
  }
}
