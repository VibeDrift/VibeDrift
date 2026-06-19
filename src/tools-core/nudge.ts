/**
 * The deep-scan nudge — "push, don't pull" — as channel-neutral data.
 *
 * A coding agent (or any caller) runs VibeDrift's tools while it works. When a
 * lot has changed since the user's last AI deep scan, a write-time tool result
 * carries a `nudge` the caller relays as a yes/no offer ("run a deep scan?").
 * The decision lives here, independent of transport; each channel decides how to
 * surface it. On the MCP channel it piggybacks on a call the agent already makes
 * (MCP is request/response, so the server cannot push); a Skill or import channel
 * can surface it however it likes.
 *
 * `decideNudge` is pure and fully testable. `maybeNudge` is the thin stateful
 * glue (reads token + config locally, no network) that channels' finalizers call.
 */
import { resolveToken } from "../auth/resolver.js";
import { readConfig, patchConfig } from "../auth/config.js";
import { formatTimeSince } from "../core/time-format.js";
import type { NudgeHint } from "./result.js";

const DAY = 24 * 60 * 60 * 1000;

/** Quiet for a day after a nudge so it reads as an FYI, not a paywall. */
const COOLDOWN_MS = 1 * DAY;
/** Only speak up once the agent is actually working this session. */
const MIN_SESSION_CALLS = 8;
/** A deep scan older than this is "stale" enough to offer a fresh one. */
const STALE_MS = 3 * DAY;

export interface NudgeState {
  /** Logged in? The nudge leads to a deep scan, which needs auth. */
  signedIn: boolean;
  /** Write-time tool calls so far in THIS session (in-memory). */
  callsThisSession: number;
  /** ISO of the last successful deep scan, or undefined if never. */
  lastDeepScanAt?: string;
  /** ISO of the last time we nudged (cooldown), or undefined. */
  lastNudgedAt?: string;
  nowMs: number;
}

const ACTION =
  "If the user says yes, re-run this check with `deep: true` for an AI-validated pass " +
  "(a fraction of a deep-scan credit). If the deep budget is empty, the result will " +
  "explain how to upgrade or buy a credit pack.";

/** Pure: decide whether to surface a deep-scan nudge for the given state. */
export function decideNudge(s: NudgeState): NudgeHint | null {
  if (!s.signedIn) return null;
  if (s.callsThisSession < MIN_SESSION_CALLS) return null;

  if (s.lastNudgedAt) {
    const sinceNudge = s.nowMs - Date.parse(s.lastNudgedAt);
    if (Number.isFinite(sinceNudge) && sinceNudge < COOLDOWN_MS) return null;
  }

  if (!s.lastDeepScanAt) {
    return {
      type: "deep_scan",
      reason: "never_deep_scanned",
      message:
        "FYI: you have not run an AI deep scan on this repo yet. A deep scan catches " +
        "intent mismatches and semantic duplicates the local checks can only guess at. " +
        "Want to run one?",
      action: ACTION,
    };
  }

  const sinceDeep = s.nowMs - Date.parse(s.lastDeepScanAt);
  if (Number.isFinite(sinceDeep) && sinceDeep >= STALE_MS) {
    return {
      type: "deep_scan",
      reason: "stale_deep_scan",
      message:
        `FYI: your last AI deep scan was ${formatTimeSince(s.lastDeepScanAt, s.nowMs)} and the ` +
        "code has moved since. A fresh deep scan would re-check intent and duplicates across " +
        "what changed. Want to run one?",
      action: ACTION,
    };
  }

  return null;
}

// In-memory, per-session activity counter. Resets when the host process restarts
// (a new editor session) — intentional: "active this session".
let callsThisSession = 0;

/** Test-only: reset the in-memory session counter. */
export function _resetSession(): void {
  callsThisSession = 0;
}

/**
 * Increment the session activity counter, then decide + (if firing) persist the
 * cooldown. Reads token + config locally (no network). Returns `{ nudge }` to
 * spread into a tool's structured result, or `{}`.
 */
export async function maybeNudge(): Promise<{ nudge?: NudgeHint }> {
  callsThisSession += 1;
  const [tok, config] = await Promise.all([resolveToken(), readConfig()]);
  const hint = decideNudge({
    signedIn: !!tok?.token,
    callsThisSession,
    lastDeepScanAt: config.lastDeepScanAt,
    lastNudgedAt: config.lastNudgedAt,
    nowMs: Date.now(),
  });
  if (!hint) return {};
  await patchConfig({ lastNudgedAt: new Date().toISOString() });
  return { nudge: hint };
}
