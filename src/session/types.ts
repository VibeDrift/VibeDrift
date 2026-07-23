/**
 * Drift Sessions event schema v1.
 *
 * One SessionEvent per JSONL line in ~/.vibedrift/sessions/<project-hash>/<session-id>.jsonl.
 * The ledger is append-only: outcomes are recorded by appending recheck/resolve
 * events, never by rewriting earlier lines.
 */

export type SessionEventType =
  | "session_start"
  | "user_prompt"
  | "intent_lock"
  | "edit"
  | "command"
  | "flag"
  | "mcp_ask"
  | "mcp_verdict"
  | "recheck"
  | "resolve"
  | "hold"
  | "decision"
  | "session_end";

export interface SessionEventDetail {
  file?: string;
  promptText?: string;
  toolName?: string;
  diffstat?: string;
  category?: string;
  dominant?: string;
  observed?: string;
  similarTo?: string;
  similarity?: number;
  truncated?: boolean;
  /** set on the experimental scope-drift signal (Phase 3) */
  experimental?: boolean;
  /** the task's target files, carried on the intent_lock event (Phase 3 coverage) */
  anchorFiles?: string[];
  /** the agent's own call on a flag, carried on a `decision` event. ACCEPT =
   *  agree & will fix; PARK = defer to a human reviewer; DECLINE = judge the flag
   *  wrong / not needed. Orthogonal to `outcome` (a stated intent, not a verified
   *  resolution). */
  decision?: "accept" | "park" | "decline";
  /** the agent's one-line reasoning for `decision`, masked + capped before write. */
  reason?: string;
}

export interface SessionEvent {
  v: 1;
  /** Agent session id, from the hook payload. */
  sid: string;
  /** Unique activity id for this event. */
  aid: string;
  /** ISO-8601 timestamp. */
  ts: string;
  agent: "claude-code";
  projectHash: string;
  /** Which side of the conversation produced the event. */
  channel: "hook" | "mcp";
  type: SessionEventType;
  /** Advisory vs interception. Phase 1 is passive-only. */
  mode: "passive" | "blocking";
  /** Present on flag/recheck/resolve/hold events (DF-<n>). */
  findingId?: string;
  detail: SessionEventDetail;
  /** The exact advisory message delivered into the agent's context, if any. */
  msgToAgent?: string;
  outcome?: "resolved" | "open" | "held" | null;
}

export const SESSIONS_SCHEMA_VERSION = 1 as const;
