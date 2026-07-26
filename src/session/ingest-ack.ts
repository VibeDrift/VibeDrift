/**
 * Ingest positive-ack contract (client half). Frozen wire shape v1:
 *
 *   200 { accepted, results: [{ activityId, status, code? }], trial_used?, trial_limit? }
 *   402 { detail, trial_used, trial_limit }   -> whole batch entitlement-locked
 *
 * Statuses: "accepted" | "duplicate" advance the commit watermark;
 * "rejected" is PERMANENT (malformed/banned-field) — logged, then treated as
 * committable so one bad event can never wedge a file's watermark forever;
 * "held" is TRANSIENT (unknown_type version-skew, session_locked, db_error) —
 * the event stays pending, nothing past it commits, the uploader retries.
 *
 * Legacy servers return only { accepted }: the whole batch commits when
 * accepted covers the batch; anything less holds everything (we cannot know
 * WHICH events landed, and re-sends are safe under idempotency). A post that
 * resolves with NO body at all (test seams, ancient callers) counts as a full
 * accept — resolution was the only success signal that path ever had.
 */

import type { UploadEvent } from "./upload-schema.js";

export type IngestResultStatus = "accepted" | "duplicate" | "rejected" | "held";

export interface IngestAck {
  accepted: number;
  results?: Array<{ activityId: string; status: IngestResultStatus; code?: string }>;
  trial_used?: number;
  trial_limit?: number;
}

/** An upload event tagged with its ledger source for durable-offset commits. */
export interface TaggedUpload {
  event: UploadEvent;
  /** Ledger file basename the event came from. */
  file: string;
  /** String offset just past this event's line in the utf8-decoded ledger. */
  endOffset: number;
}

export interface AckReconciliation {
  /** Per source file: highest CONTIGUOUS offset safe to persist. */
  commitUpTo: Map<string, number>;
  /** Events that must stay pending (held / unacknowledged). */
  held: TaggedUpload[];
  /** activityIds permanently rejected by the server (logged by the caller). */
  rejectedIds: string[];
}

const COMMITTABLE: ReadonlySet<IngestResultStatus> = new Set(["accepted", "duplicate", "rejected"]);

/**
 * Fold a batch's server ack into per-file contiguous commit offsets.
 * `sent` must be in ledger order per file (the follower guarantees it).
 */
export function reconcileAck(sent: TaggedUpload[], ack: IngestAck | undefined | null): AckReconciliation {
  const out: AckReconciliation = { commitUpTo: new Map(), held: [], rejectedIds: [] };
  if (sent.length === 0) return out;

  // Legacy shape: no per-event results. All-or-nothing.
  if (!ack || !Array.isArray(ack.results)) {
    if (!ack || ack.accepted >= sent.length) {
      for (const t of sent) out.commitUpTo.set(t.file, Math.max(out.commitUpTo.get(t.file) ?? 0, t.endOffset));
    } else {
      out.held.push(...sent);
    }
    return out;
  }

  const byId = new Map(ack.results.map((r) => [r.activityId, r]));
  // Contiguity is per source file: a held/unknown event blocks later events of
  // ITS file only (other files' prefixes commit independently).
  const blocked = new Set<string>();
  for (const t of sent) {
    if (blocked.has(t.file)) {
      out.held.push(t);
      continue;
    }
    const r = byId.get(t.event.activityId);
    if (r && COMMITTABLE.has(r.status)) {
      if (r.status === "rejected") out.rejectedIds.push(t.event.activityId);
      out.commitUpTo.set(t.file, Math.max(out.commitUpTo.get(t.file) ?? 0, t.endOffset));
    } else {
      // held, or missing from results: stop this file's watermark here.
      blocked.add(t.file);
      out.held.push(t);
    }
  }
  return out;
}

/** True when the error is the whole-batch entitlement lock (HTTP 402). */
export function isIngestLocked(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && "status" in err && (err as { status?: unknown }).status === 402,
  );
}
