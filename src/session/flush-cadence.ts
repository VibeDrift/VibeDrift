/**
 * When a session may spawn its next flush.
 *
 * The Stop hook ships a turn's events when the turn ENDS. That is the whole
 * cadence today, and on a long turn it is not a cadence at all: measured on a
 * real working session, batches reached the dashboard 14 to 25 minutes apart,
 * each one complete but late. Everything downstream inherits that lag — the
 * live tape, the "is this session still running" reading, the coverage
 * numbers a reader is watching while the agent works.
 *
 * So the edit path asks this module whether enough time has passed, and if it
 * has, spawns the same detached flush the Stop hook spawns. Nothing else
 * changes: same child, same durable offsets, same idempotent ingest, same
 * fail-open posture.
 *
 * Why a marker FILE rather than process memory: every hook invocation is a
 * fresh process. There is nowhere else to remember when the last flush went
 * out. The file holds nothing but its own mtime.
 *
 * It lives beside the session's scope index, under the WORKSPACE's directory
 * and named for the session, because that is already where per-session state
 * goes (`<sessionId>.scopes.json`). The sessions root holds project
 * directories and nothing else; a stray file there is something every reader
 * of that directory then has to know to skip.
 *
 * Keying it on the workspace rather than the edited repo is what makes it one
 * flush per session: a session spanning a workspace writes several ledgers
 * and the child drains all of them in one run (flush-targets.ts), so a
 * per-repo cadence would spawn N children for one turn's work.
 *
 * Every function here fails OPEN in the direction of doing less: an
 * unreadable marker means "not due", so a broken filesystem degrades to the
 * behaviour that shipped before this existed rather than to a spawn storm.
 */

import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeSegment } from "./ledger.js";

/**
 * How long a session may go without shipping what it has.
 *
 * 60 seconds is chosen against the dashboard's own clock, not out of the air:
 * it polls a live session every 10 seconds and calls a session live for 15
 * minutes after its last event. A minute keeps the tape inside the poll's
 * resolution and a long turn far inside the live window, at a cost of about
 * one short-lived child per minute of continuous editing.
 */
export const MID_TURN_FLUSH_MS = 60_000;

/** The marker's path, beside that session's scope index. */
export function flushMarkerPath(sessionsDir: string, workspaceHash: string, sessionId: string): string {
  return join(sessionsDir, safeSegment(workspaceHash), `${safeSegment(sessionId)}.flush`);
}

/**
 * True when this session has not flushed within `everyMs`.
 *
 * A missing marker reads as due: the first edit of a session ships what the
 * session start already recorded, which is what makes a session appear on the
 * dashboard while it is still running rather than after it ends.
 */
export function dueForFlush(
  sessionsDir: string,
  workspaceHash: string,
  sessionId: string,
  now: number,
  everyMs: number = MID_TURN_FLUSH_MS,
): boolean {
  try {
    const at = statSync(flushMarkerPath(sessionsDir, workspaceHash, sessionId)).mtimeMs;
    // A marker stamped in the future (clock change, restored backup) would
    // otherwise suppress flushing until the clock caught up.
    if (at > now) return true;
    return now - at >= everyMs;
  } catch (err) {
    // ENOENT is the first-edit case and means due. Anything else is a
    // filesystem we should not be spawning children on top of.
    return (err as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

/**
 * Record that a flush was just spawned. Call it on the spawn, not on the
 * child's success: the child owns its own retries through durable offsets,
 * and a failing upload must not turn into a child every single edit.
 */
export function markFlushed(
  sessionsDir: string,
  workspaceHash: string,
  sessionId: string,
  now: number,
): void {
  const path = flushMarkerPath(sessionsDir, workspaceHash, sessionId);
  const at = new Date(now);
  try {
    utimesSync(path, at, at);
  } catch {
    try {
      writeFileSync(path, "");
      utimesSync(path, at, at);
    } catch {
      // Unwritable sessions dir: the caller keeps its old behaviour (flush at
      // the end of the turn) rather than failing the hook.
    }
  }
}
