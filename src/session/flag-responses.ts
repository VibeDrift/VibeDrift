/**
 * Answers a person queued on the dashboard, delivered into this machine's
 * ledger.
 *
 * This is the one place data flows BACKWARDS. Everywhere else the ledger on
 * this machine is the source of truth and the dashboard holds a projection.
 * Here someone read a parked flag on a screen, made a call, and that call has
 * to reach the agent — in the session that is running if there is one, and as
 * prior context for whichever agent opens the repo next.
 *
 * Three things this deliberately does:
 *
 *   It writes the answer as an ordinary decision event, in the same ledger,
 *   in the same shape the agent's own calls take. There is no second store of
 *   "human decisions" to reconcile later; one flag has one answer history.
 *
 *   It tags that event `via: "human"`, because an untagged one would be read
 *   everywhere downstream as the agent's call. Attributing a person's
 *   judgement to the agent is a lie the dashboard would then repeat.
 *
 *   It acknowledges only AFTER the local write succeeds. A process that dies
 *   between fetching and writing re-reads the same answers next time rather
 *   than dropping them, and a re-delivered answer is harmless: the ledger
 *   append is idempotent per activity id on the way back up.
 *
 * Failure is always silent and total: an agent's turn must never break, or
 * even slow down, because a network call for someone else's answer failed.
 */

import { appendEvent, newActivityId } from "./ledger.js";
import { maskSecrets } from "./mask.js";
import { MAX_REASON_LEN } from "./decision.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent } from "./types.js";

/** One answer as the API hands it over. */
export interface QueuedResponse {
  id: string;
  projectHash: string;
  sessionId: string;
  findingId: string;
  decision: "accept" | "park" | "decline";
  reason?: string | null;
}

const DECISIONS = new Set(["accept", "park", "decline"]);

/** Parse the API's payload, dropping anything that is not usable rather than
 *  writing a half-formed decision into a ledger we cannot un-write. */
export function parseQueued(payload: unknown): QueuedResponse[] {
  const list = (payload as { responses?: unknown })?.responses;
  if (!Array.isArray(list)) return [];
  const out: QueuedResponse[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    const projectHash = typeof r.project_hash === "string" ? r.project_hash : "";
    const sessionId = typeof r.session_id === "string" ? r.session_id : "";
    const findingId = typeof r.finding_id === "string" ? r.finding_id : "";
    const decision = typeof r.decision === "string" ? r.decision : "";
    if (!id || !projectHash || !sessionId || !findingId || !DECISIONS.has(decision)) continue;
    out.push({
      id,
      projectHash,
      sessionId,
      findingId,
      decision: decision as QueuedResponse["decision"],
      reason: typeof r.reason === "string" ? r.reason : null,
    });
  }
  return out;
}

/** The decision event a queued answer becomes. Masked and capped here too:
 *  the text came back over the network, and this is the last point before it
 *  is written to disk. */
export function decisionEventFor(r: QueuedResponse, nowIso: string): SessionEvent {
  return {
    v: SESSIONS_SCHEMA_VERSION,
    sid: r.sessionId,
    aid: newActivityId(),
    ts: nowIso,
    agent: "claude-code",
    projectHash: r.projectHash,
    channel: "mcp",
    type: "decision",
    mode: "passive",
    findingId: r.findingId,
    detail: {
      decision: r.decision,
      reason: maskSecrets(r.reason ?? "").slice(0, MAX_REASON_LEN),
      // Not the agent's call. Everything downstream reads this.
      via: "human",
    },
  };
}

export interface DeliverOptions {
  sessionsDir: string;
  projectHash: string;
  apiUrl: string;
  token: string;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Fetch, write, acknowledge. Returns the answers written, so a caller can put
 * them in front of the agent.
 */
export async function deliverQueuedResponses(opts: DeliverOptions): Promise<QueuedResponse[]> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" };

  let queued: QueuedResponse[];
  try {
    const res = await doFetch(
      `${base}/v1/sessions/flags/pending?project_hash=${encodeURIComponent(opts.projectHash)}`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return [];
    queued = parseQueued(await res.json());
  } catch {
    return [];
  }
  if (queued.length === 0) return [];

  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const written: QueuedResponse[] = [];
  for (const r of queued) {
    try {
      await appendEvent(opts.sessionsDir, r.projectHash, r.sessionId, decisionEventFor(r, nowIso));
      written.push(r);
    } catch {
      // Leave it queued. The next pull tries again.
    }
  }
  if (written.length === 0) return [];

  try {
    await doFetch(`${base}/v1/sessions/flags/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: written.map((r) => r.id) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Written locally but not acknowledged: it arrives again next time and
    // the duplicate is dropped on ingest. Losing it would be the worse bug.
  }
  return written;
}

/**
 * What the agent is told about answers a person gave. One line each, in the
 * agent's own vocabulary, so it can act on them without being told how.
 */
export function responseBriefing(written: readonly QueuedResponse[]): string | null {
  if (written.length === 0) return null;
  const lines = written.map((r) => {
    const reason = (r.reason ?? "").trim();
    const verb =
      r.decision === "accept"
        ? "accepted, so change the code"
        : r.decision === "decline"
          ? "declined, so leave it as written"
          : "parked, so leave it and do not raise it again this session";
    return `- ${r.findingId}: a person ${verb}${reason ? ` — "${reason}"` : ""}`;
  });
  const head =
    written.length === 1
      ? "A person answered a VibeDrift flag in this repo:"
      : `A person answered ${written.length} VibeDrift flags in this repo:`;
  return `${head}\n${lines.join("\n")}`;
}
