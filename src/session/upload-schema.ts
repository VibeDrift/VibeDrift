/**
 * Drift Sessions derived-only upload schema (Phase 5). The ONE invariant: what
 * leaves the machine is a derived PROJECTION — findings, scores, outcomes,
 * metadata — never a prompt, a line of code, a free-text advisory, or a file
 * path. That invariant is enforced BY CONSTRUCTION here: `toUploadEvent` builds a
 * fresh `UploadEvent` from an explicit allow-list of fields; it never spreads the
 * ledger event, so a field that isn't named below cannot leak. `upload-schema.test.ts`
 * proves, per event kind, that no banned field survives the mapping.
 *
 * File paths are carried only as `sha256(projectHash + relPath)[:16]` — a
 * per-repo grouping PSEUDONYM, not an irreversible hash. Salting by the repo hash
 * keeps files group-able within a project while defeating a global relpath
 * rainbow table (an unsalted 64-bit path hash is trivially reversed for a known
 * repo layout). Label fields (category/dominant/observed) are a bounded detector
 * vocabulary and are additionally secret-masked as defense in depth.
 *
 * The two free-text fields a team may find worth sharing — the decision REASON
 * and the derived intent LABEL — ship only under explicit team opt-in (the
 * code-egress boundary) and are secret-masked + capped even then. Note: opt-in
 * relaxes the path guarantee for these two fields only — the agent's own reason
 * text may reference a path, so the guarantee there is "secret-masked + capped,"
 * not "no path." Default (opt-in off): conclusions leave, analysis stays local.
 */

import { createHash } from "node:crypto";
import { extractAnchors } from "./anchors.js";
import { maskSecrets } from "./mask.js";
import { MAX_REASON_LEN } from "./decision.js";
import type { SessionEvent, SessionEventType } from "./types.js";

export const UPLOAD_SCHEMA_VERSION = 1 as const;
const MAX_LABEL = 120;
const MAX_TASK_LABEL = 200;

export type UploadEventType =
  | "session_start"
  | "edit"
  | "flag"
  | "resolve"
  | "hold"
  | "mcp_ask"
  | "mcp_verdict"
  | "intent_lock"
  | "decision"
  | "session_end";

/** The wire shape. Every optional field is a derived label, a number, an id, or
 *  a hash — never raw text, code, or a path. `reason`/`taskLabel` are the only
 *  free-text fields and are team-opt-in + masked. */
export interface UploadEvent {
  v: typeof UPLOAD_SCHEMA_VERSION;
  sessionId: string;
  activityId: string;
  ts: string;
  agent: "claude-code";
  projectHash: string;
  type: UploadEventType;
  /** sha256(relPath)[:16] — group by file without revealing the path. */
  fileHash?: string;
  category?: string;
  /** pattern LABELS only (e.g. "async/await" vs ".then() chains"), never code. */
  dominant?: string;
  observed?: string;
  similarity?: number;
  findingId?: string;
  outcome?: "resolved" | "open" | "held";
  mode?: "passive" | "blocking";
  experimental?: boolean;
  /** the +N line count only, never the diff. */
  diffLines?: number;
  decision?: "accept" | "park" | "decline";
  /** count of task target files, never the paths. */
  taskFileCount?: number;
  // ---- team-opt-in free text (masked); absent by default ----
  reason?: string;
  taskLabel?: string;
}

export interface UploadMapOptions {
  /** Explicit team opt-in to ship the two derived free-text fields (decision
   *  reasoning + intent label). Off by default — the code-egress boundary. */
  teamIntentOptIn?: boolean;
}

const UPLOADABLE = new Set<SessionEventType>([
  "session_start",
  "edit",
  "flag",
  "resolve",
  "hold",
  "mcp_ask",
  "mcp_verdict",
  "intent_lock",
  "decision",
  "session_end",
]);

/** A per-repo grouping pseudonym for a path: salted by the project hash so the
 *  same file groups within a repo but a global path rainbow table can't reverse
 *  it. NUL separator so `a`+`bc` and `ab`+`c` never collide. */
function hashPath(projectHash: string, relPath: string): string {
  return createHash("sha256").update(`${projectHash}\0${relPath}`).digest("hex").slice(0, 16);
}

/** Parse "+38" / "+5 -2" → 38; anything else → undefined. Never the diff text. */
function parseDiffLines(diffstat: string | undefined): number | undefined {
  if (!diffstat) return undefined;
  const m = /\+(\d+)/.exec(diffstat);
  return m ? Number(m[1]) : undefined;
}

/** A bounded detector-vocabulary label: secret-masked (defense in depth against a
 *  future producer) and capped. Real labels ("async/await", ".then() chains")
 *  are untouched by the masker. */
function label(s: string | undefined, cap = MAX_LABEL): string | undefined {
  if (!s) return undefined;
  return maskSecrets(s).slice(0, cap);
}

/**
 * Map a ledger event to its derived upload projection, or null if the event kind
 * is not uploaded at all (command, recheck). Builds a fresh object from an
 * allow-list — banned fields (promptText, body, msgToAgent, file/similarTo paths)
 * have no landing spot and cannot leak.
 */
export function toUploadEvent(ev: SessionEvent, opts: UploadMapOptions = {}): UploadEvent | null {
  if (!ev || !UPLOADABLE.has(ev.type)) return null;
  const d = ev.detail ?? {};
  const u: UploadEvent = {
    v: UPLOAD_SCHEMA_VERSION,
    sessionId: ev.sid,
    activityId: ev.aid,
    ts: ev.ts,
    agent: ev.agent,
    projectHash: ev.projectHash,
    type: ev.type as UploadEventType,
  };

  switch (ev.type) {
    case "edit": {
      if (d.file) u.fileHash = hashPath(ev.projectHash, d.file);
      const n = parseDiffLines(d.diffstat);
      if (n !== undefined) u.diffLines = n;
      break;
    }
    case "flag": {
      if (d.file) u.fileHash = hashPath(ev.projectHash, d.file);
      u.category = label(d.category);
      u.dominant = label(d.dominant);
      u.observed = label(d.observed);
      if (typeof d.similarity === "number") u.similarity = d.similarity;
      if (ev.findingId) u.findingId = ev.findingId;
      if (ev.mode) u.mode = ev.mode;
      if (d.experimental) u.experimental = true;
      if (ev.outcome === "resolved" || ev.outcome === "held" || ev.outcome === "open") u.outcome = ev.outcome;
      break;
    }
    case "resolve":
    case "hold": {
      if (ev.findingId) u.findingId = ev.findingId;
      if (d.file) u.fileHash = hashPath(ev.projectHash, d.file);
      u.outcome = ev.type === "resolve" ? "resolved" : "held";
      break;
    }
    case "mcp_verdict": {
      // a bounded derived verdict label ("in line", "1 drift", "no match"); the
      // MCP ASK text carries a path, so mcp_ask ships ids+type only (below).
      u.observed = label(d.observed);
      break;
    }
    case "decision": {
      if (ev.findingId) u.findingId = ev.findingId;
      if (d.decision === "accept" || d.decision === "park" || d.decision === "decline") u.decision = d.decision;
      if (opts.teamIntentOptIn && d.reason) u.reason = maskSecrets(d.reason).slice(0, MAX_REASON_LEN);
      break;
    }
    case "intent_lock": {
      // the COUNT of task files (never the paths); an intent LABEL derived from
      // anchor tokens/symbols (never the prompt's sentence) only under team opt-in.
      if (d.anchorFiles) u.taskFileCount = d.anchorFiles.length;
      if (opts.teamIntentOptIn && d.promptText) {
        // mask BEFORE tokenizing so a keyed secret is caught while its `key=`
        // shape is still intact, then again after (belt and suspenders).
        const a = extractAnchors(maskSecrets(d.promptText));
        const derived = [...a.symbols, ...a.tokens].slice(0, 12).join(" ").trim();
        if (derived) u.taskLabel = maskSecrets(derived).slice(0, MAX_TASK_LABEL);
      }
      break;
    }
    // session_start, session_end, mcp_ask: ids + type only.
    default:
      break;
  }
  return u;
}
