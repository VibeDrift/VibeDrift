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

import { appendEvent, newActivityId, readSessionEvents, sessionFilePath } from "./ledger.js";
import { maskSecrets } from "./mask.js";
import { MAX_REASON_LEN } from "./decision.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent, SessionEventDetail } from "./types.js";

/** One answer as the API hands it over. */
export interface QueuedResponse {
  id: string;
  projectHash: string;
  sessionId: string;
  findingId: string;
  decision: "accept" | "park" | "decline";
  reason?: string | null;
}

/**
 * What the flag itself said, read back from this machine's own ledger.
 *
 * The answer that arrives from the API names a finding by id, and a finding
 * id is only unique WITHIN a sitting: the first flag of every session is
 * DF-1. So "DF-1 was accepted" handed to an agent whose own DF-1 is a
 * different flag in a different file is worse than useless, because the
 * agent will confidently change the wrong code.
 *
 * The fix does not need a bigger API payload. The flag is already described
 * in the ledger this same function is about to write into, under the exact
 * (project, session, finding) the answer names, with the REAL file path
 * rather than the pseudonymised hash the cloud projection holds. So the
 * briefing is assembled locally, and nothing further leaves the machine.
 */
export interface FlagContext {
  /** The repo-relative file the flag was raised on. */
  file?: string;
  /** One phrase saying what drifted, in the tape's vocabulary. */
  what?: string;
}

/** A queued answer, once written, with whatever the local ledger knows about
 *  the flag it answers. */
export interface AnsweredFlag extends QueuedResponse {
  flag?: FlagContext;
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

/**
 * One phrase for what a flag said, from the ledger's own structured fields.
 *
 * Built from `detail` rather than reused from the advisory text the agent
 * originally saw, for two reasons: the advisory ends with an instruction to
 * record a call, which is exactly wrong to repeat about a flag that has just
 * been answered; and a flag that was recorded but never messaged (one
 * advisory per edit, the rest stay silent) carries no advisory text at all,
 * while every flag carries its detail.
 */
export function describeFlag(d: SessionEventDetail): string | undefined {
  if (d.category === "redundancy") {
    const target = d.similarTo ?? "code this project already has";
    const sim = typeof d.similarity === "number" ? ` (${d.similarity.toFixed(2)} similar)` : "";
    return `duplicates ${target}${sim}`;
  }
  if (d.dominant || d.observed) {
    const what = d.category ?? "drift";
    return `${what}: this project uses ${d.dominant ?? "an unrecorded pattern"}, that change used ${d.observed ?? "another"}`;
  }
  return d.category;
}

/** The flag a finding id names, from events already in hand. The LAST match
 *  wins: a finding id is reused across sittings, and within one sitting the
 *  most recent raise is the one an answer given today refers to. */
export function flagContextFrom(
  events: readonly SessionEvent[],
  findingId: string,
): FlagContext | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "flag" || ev.findingId !== findingId) continue;
    const d = ev.detail ?? {};
    const ctx: FlagContext = {};
    if (d.file) ctx.file = d.file;
    const what = describeFlag(d);
    if (what) ctx.what = what;
    return ctx.file || ctx.what ? ctx : undefined;
  }
  return undefined;
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
export async function deliverQueuedResponses(opts: DeliverOptions): Promise<AnsweredFlag[]> {
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
  // One read per sitting, not per answer: several answers usually come from
  // the same session, and this runs on an agent's hook path.
  const ledgers = new Map<string, SessionEvent[]>();
  const eventsFor = async (projectHash: string, sessionId: string): Promise<SessionEvent[]> => {
    const key = `${projectHash}/${sessionId}`;
    const hit = ledgers.get(key);
    if (hit) return hit;
    const evs = await readSessionEvents(sessionFilePath(opts.sessionsDir, projectHash, sessionId));
    ledgers.set(key, evs);
    return evs;
  };

  const written: AnsweredFlag[] = [];
  for (const r of queued) {
    try {
      // Read the flag BEFORE appending, so the lookup never sees the
      // decision we are about to write.
      const flag = flagContextFrom(await eventsFor(r.projectHash, r.sessionId), r.findingId);
      await appendEvent(opts.sessionsDir, r.projectHash, r.sessionId, decisionEventFor(r, nowIso));
      written.push(flag ? { ...r, flag } : r);
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
 * What the agent is told about answers a person gave.
 *
 * Every line names the FILE the flag was raised on, never the finding id
 * alone. An id is unique only within a sitting, so "DF-1 was accepted" read
 * by an agent whose own DF-1 is a different flag is an instruction to change
 * the wrong code. Where this machine's ledger no longer describes the flag,
 * the sitting is named instead, which is at least unambiguous.
 */
export function responseBriefing(written: readonly AnsweredFlag[]): string | null {
  if (written.length === 0) return null;
  const lines = written.map((r) => {
    const reason = (r.reason ?? "").trim();
    const verb =
      r.decision === "accept"
        ? "accepted, so change the code"
        : r.decision === "decline"
          ? "declined, so leave it as written"
          : "parked, so leave it and do not raise it again this session";
    const where = r.flag?.file
      ? ` in ${r.flag.file}`
      : ` (raised in session ${r.sessionId.slice(0, 8)}, not this one)`;
    const what = r.flag?.what ? ` The flag said: ${r.flag.what}.` : "";
    return `- ${r.findingId}${where}: a person ${verb}${reason ? ` — "${reason}"` : ""}.${what}`;
  });
  const head =
    written.length === 1
      ? "A person answered a VibeDrift flag in this repo:"
      : `A person answered ${written.length} VibeDrift flags in this repo:`;
  return `${head}\n${lines.join("\n")}`;
}
