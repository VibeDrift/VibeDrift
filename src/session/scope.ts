/**
 * Scope-drift signal (Phase 3, experimental, deterministic, free): does an edit
 * relate to anything the task asked for? Conservative by design — flags only the
 * SECOND-and-later unrelated edit, and each file at most once, so a genuinely
 * new subtask (one file) never trips it. Labeled experimental until calibrated
 * on real ledgers.
 */

import { extractAnchors, mergeAnchors, editRelatesToAnchors, taskSummary } from "./anchors.js";
import { readIntentState, writeIntentState } from "./intent-state.js";
import { newActivityId } from "./ledger.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent } from "./types.js";

/** Merge a prompt's anchors into session state; emit an intent_lock on the first. */
export async function processPrompt(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
  promptText: string,
): Promise<SessionEvent | null> {
  const task = taskSummary(promptText);
  const state = await readIntentState(sessionsDir, projectHash, sessionId);
  const filesBefore = state.anchors.files.length;
  state.anchors = mergeAnchors(state.anchors, extractAnchors(promptText));

  // Lock on the first prompt that actually says something (an empty/whitespace
  // prompt must not lock intent with a blank task label).
  const firstLock = !state.locked && task.length > 0;
  if (firstLock) {
    state.locked = true;
    state.task = task;
  }
  const filesGrew = state.locked && state.anchors.files.length > filesBefore;
  await writeIntentState(sessionsDir, projectHash, sessionId, state);

  if (!firstLock && !filesGrew) return null;
  return {
    v: SESSIONS_SCHEMA_VERSION,
    sid: sessionId,
    aid: newActivityId(),
    ts: new Date().toISOString(),
    agent: "claude-code",
    projectHash,
    channel: "hook",
    type: "intent_lock",
    mode: "passive",
    // full current anchor files on every emit, so coverage sees the whole task
    detail: { promptText: state.task, anchorFiles: state.anchors.files, observed: firstLock ? "" : "expanded" },
  };
}

export interface ScopeResult {
  flag: SessionEvent | null;
  fyi: string | null;
}

export async function checkScope(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
  relFile: string,
  body: string,
): Promise<ScopeResult> {
  const state = await readIntentState(sessionsDir, projectHash, sessionId);
  if (!state.locked) return { flag: null, fyi: null };
  if (editRelatesToAnchors(relFile, body, state.anchors)) return { flag: null, fyi: null };
  if (state.scopeFlagged.includes(relFile)) return { flag: null, fyi: null };

  state.unrelatedEdits += 1;
  // Conservative: only the 2nd+ unrelated edit is flaggable.
  const flaggable = state.unrelatedEdits >= 2;
  if (flaggable) state.scopeFlagged.push(relFile);
  await writeIntentState(sessionsDir, projectHash, sessionId, state);
  if (!flaggable) return { flag: null, fyi: null };

  const flag: SessionEvent = {
    v: SESSIONS_SCHEMA_VERSION,
    sid: sessionId,
    aid: newActivityId(),
    ts: new Date().toISOString(),
    agent: "claude-code",
    projectHash,
    channel: "hook",
    type: "flag",
    mode: "passive",
    findingId: `DF-scope-${state.unrelatedEdits}`,
    detail: { file: relFile, category: "scope", observed: "edit unrelated to the task", experimental: true },
    outcome: null,
  };
  const fyi = `[vibedrift] ${relFile} looks unrelated to this task (${state.task}) — experimental scope check, verify it belongs here.`;
  return { flag, fyi };
}
