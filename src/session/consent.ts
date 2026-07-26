/**
 * Consent receipts (local-only v1): an append-only `consent.log` JSONL file
 * recording every activation answer — enable, decline, dir grant, budget
 * expiry — with when and through which surface it happened.
 *
 * Per-repo receipts live under `sessions/<hash>/consent.log`; machine-level
 * receipts (dir grants) live at the VibeDrift home root. `.log` keeps them
 * structurally outside the uploadable event stream (the uploader follows
 * `.jsonl` only), so a receipt can never leave the machine by construction.
 *
 * Best-effort: a receipt write failure must never block the answer itself —
 * callers get `false` back and surface a warning instead.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CONSENT_LOG = "consent.log";

export interface ConsentReceipt {
  v: 1;
  /** ISO timestamp of the answer. */
  at: string;
  action: "enable" | "decline" | "dir-grant";
  /** Which surface recorded it (AnswerSurface from the activation store). */
  surface: string;
  projectHash?: string;
  /** Canonicalized repo root (enable/decline receipts). */
  rootDir?: string;
  /** Canonicalized granted directory (dir-grant receipts). */
  grantPath?: string;
}

/** Append one receipt line to `<dir>/consent.log`. Returns false on failure. */
export function appendConsentReceipt(dir: string, receipt: ConsentReceipt): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, CONSENT_LOG), JSON.stringify(receipt) + "\n", { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
