/**
 * Per-session intent state: the task anchors captured from prompts plus the
 * scope-drift bookkeeping, persisted next to the ledger so the stateless hook
 * processes (prompt in one invocation, edits in later ones) share it. All I/O
 * is fail-open — a lost or corrupt file degrades to "no intent captured", never
 * an error.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeSegment } from "./ledger.js";
import type { Anchors } from "./anchors.js";

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

export async function writeIntentState(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
  state: IntentState,
): Promise<void> {
  try {
    await mkdir(join(sessionsDir, safeSegment(projectHash)), { recursive: true, mode: 0o700 });
    await writeFile(statePath(sessionsDir, projectHash, sessionId), JSON.stringify(state), { mode: 0o600 });
  } catch {
    // best-effort; losing intent state degrades scope detection, never fails the hook
  }
}
