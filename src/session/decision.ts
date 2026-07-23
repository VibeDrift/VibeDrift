/**
 * Per-flag decision capture (respond_to_flag): record the agent's own call on a
 * VibeDrift flag — accept / park / decline — with a one-line reason, appended to
 * the session ledger as a `decision` event.
 *
 * A decision is ORTHOGONAL to an outcome: "the agent accepted DF-3" is a stated
 * intent, not a verified resolution. Accepting a flag does NOT mark it resolved;
 * only the finding-scoped re-check (src/session/outcomes.ts) does. We record both
 * and never conflate them.
 *
 * Correlation mirrors the MCP tee: no session id is available, so we find the
 * repo's recently-active ledgers and record against one that raised the finding.
 * Per-session `DF-<n>` ids are not globally unique, so when two concurrent
 * same-repo sessions both minted the id, we prefer the ledger where it is still
 * open + undecided; a truly ambiguous collision (both open) falls back to the
 * newest and is an accepted best-effort limit. Fail-open — never throws; the
 * worst case is a soft "not recorded" the agent can act on.
 */

import { join } from "node:path";
import { projectHash, canonicalizeRoot } from "../core/baseline.js";
import { appendEvent, newActivityId, readSessionEvents, safeSegment, sessionFilePath } from "./ledger.js";
import { listActiveSessions } from "./mcp-tee.js";
import { maskSecrets } from "./mask.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent } from "./types.js";

export const MAX_REASON_LEN = 2000;
export const DECISIONS = ["accept", "park", "decline"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface RecordDecisionOptions {
  sessionsDir: string;
  rootDir: string;
  findingId: string;
  decision: Decision;
  reason: string;
  now?: () => number;
}

export type RecordDecisionResult =
  | { ok: true; sid: string; findingId: string; decision: Decision }
  | { ok: false; code: "no_active_session" }
  | { ok: false; code: "unknown_finding"; knownFindings: string[] }
  | { ok: false; code: "bad_decision" }
  | { ok: false; code: "record_failed" };

/** Non-experimental raised flag ids in a ledger's events (the ids an agent could
 *  legitimately respond to). */
function raisedFindingIds(events: SessionEvent[]): string[] {
  const ids: string[] = [];
  for (const e of events) {
    if (e.type === "flag" && e.findingId && !e.detail.experimental && !ids.includes(e.findingId)) {
      ids.push(e.findingId);
    }
  }
  return ids;
}

/** Is `id` still awaiting a response in this ledger — raised, not yet
 *  resolved/held, and no decision recorded? Used to prefer the right ledger when
 *  two concurrent same-repo sessions each minted the same per-session `DF-<n>`. */
function isOpenUndecided(events: SessionEvent[], id: string): boolean {
  let state: "open" | "resolved" | "held" = "open";
  let decided = false;
  for (const e of events) {
    if (e.findingId !== id) continue;
    if (e.type === "flag") {
      if (e.outcome === "resolved") state = "resolved";
      else if (e.outcome === "held" || e.mode === "blocking") state = "held";
    } else if (e.type === "resolve") state = "resolved";
    else if (e.type === "hold") state = "held";
    else if (e.type === "decision") decided = true;
  }
  return state === "open" && !decided;
}

export async function recordFlagDecision(opts: RecordDecisionOptions): Promise<RecordDecisionResult> {
  if (!(DECISIONS as readonly string[]).includes(opts.decision)) {
    return { ok: false, code: "bad_decision" };
  }

  try {
    const now = (opts.now ?? Date.now)();
    const hash = projectHash(canonicalizeRoot(opts.rootDir));
    const dir = join(opts.sessionsDir, safeSegment(hash));
    const sessions = await listActiveSessions(dir, now);
    if (sessions.length === 0) return { ok: false, code: "no_active_session" };

    // Per-session `DF-<n>` ids are NOT globally unique, so two concurrent same-repo
    // sessions can each mint a `DF-1`. Scan all active ledgers (newest-first),
    // collect every one that raised this id, and prefer the ledger where the
    // finding is still open + undecided (the one genuinely awaiting a response);
    // fall back to the newest match. The union of raised ids across ledgers is the
    // hint returned when nothing matches.
    const knownUnion = new Set<string>();
    const matches: Array<{ sid: string; open: boolean }> = [];
    for (const s of sessions) {
      const events = await readSessionEvents(sessionFilePath(opts.sessionsDir, hash, s.sid));
      const ids = raisedFindingIds(events);
      for (const id of ids) knownUnion.add(id);
      if (ids.includes(opts.findingId)) {
        matches.push({ sid: s.sid, open: isOpenUndecided(events, opts.findingId) });
      }
    }
    if (matches.length === 0) {
      return { ok: false, code: "unknown_finding", knownFindings: [...knownUnion] };
    }
    // `matches` preserves the newest-first order, so the first open match is the
    // newest open one, and matches[0] is the newest overall.
    const target = (matches.find((m) => m.open) ?? matches[0]).sid;

    const reason = maskSecrets(opts.reason ?? "").slice(0, MAX_REASON_LEN);
    const event: SessionEvent = {
      v: SESSIONS_SCHEMA_VERSION,
      sid: target,
      aid: newActivityId(),
      ts: new Date().toISOString(),
      agent: "claude-code",
      projectHash: hash,
      channel: "mcp",
      type: "decision",
      mode: "passive",
      findingId: opts.findingId,
      detail: { decision: opts.decision, reason },
    };
    await appendEvent(opts.sessionsDir, hash, target, event);
    return { ok: true, sid: target, findingId: opts.findingId, decision: opts.decision };
  } catch {
    // fail-open: a decision we couldn't record is a soft miss, never a thrown
    // error. `record_failed` (not `no_active_session`) so the agent-facing copy
    // doesn't falsely claim there was no session when a write actually failed.
    return { ok: false, code: "record_failed" };
  }
}
