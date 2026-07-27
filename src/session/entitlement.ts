/**
 * Drift Sessions entitlement (decision 8): sessions are Pro-only with a one-time
 * 5-session trial. The count lives server-side (survives reinstall / machine
 * hops); this module holds the pure policy plus a LOCAL cache the offline hook
 * reads to decide whether to capture at all. `watch-session` (online) refreshes
 * the cache from the server; the hook never makes a network call.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { vibedriftHome } from "../core/vibedrift-home.js";
import { isPaidPlan, type Plan } from "../auth/plan.js";

export const SESSION_TRIAL_LIMIT = 5;

/** How long a cached entitlement is trusted before the native flush re-asks
 *  the server. Long enough that a busy session adds ~no extra requests, short
 *  enough that a trial burned on another machine lands quickly. */
export const ENTITLEMENT_TTL_MS = 15 * 60_000;

export type EntitlementReason = "pro" | "trial" | "locked";

export interface SessionEntitlement {
  entitled: boolean;
  reason: EntitlementReason;
  plan: Plan;
  trialUsed: number;
  trialLimit: number;
  /** ISO time the server was last asked. Absent on caches written before this
   *  field existed, which counts as stale (see `shouldRefreshEntitlement`). */
  checkedAt?: string;
}

/** Pure policy: Pro/Enterprise always entitled; free entitled while trial remains. */
export function computeEntitlement(
  plan: Plan,
  trialUsed: number,
  trialLimit: number = SESSION_TRIAL_LIMIT,
): SessionEntitlement {
  if (isPaidPlan(plan)) {
    return { entitled: true, reason: "pro", plan, trialUsed, trialLimit };
  }
  const entitled = trialUsed < trialLimit;
  return { entitled, reason: entitled ? "trial" : "locked", plan, trialUsed, trialLimit };
}

function cachePath(baseDir: string): string {
  return join(baseDir, "sessions-entitlement.json");
}

/** Default cache dir is ~/.vibedrift; tests pass an explicit dir. */
export function entitlementDir(): string {
  return vibedriftHome();
}

export function readEntitlementCache(baseDir: string = entitlementDir()): SessionEntitlement | null {
  try {
    const raw = readFileSync(cachePath(baseDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionEntitlement>;
    if (typeof parsed.entitled !== "boolean") return null;
    return {
      entitled: parsed.entitled,
      reason: (parsed.reason as EntitlementReason) ?? (parsed.entitled ? "trial" : "locked"),
      plan: (parsed.plan as Plan) ?? "free",
      trialUsed: typeof parsed.trialUsed === "number" ? parsed.trialUsed : 0,
      trialLimit: typeof parsed.trialLimit === "number" ? parsed.trialLimit : SESSION_TRIAL_LIMIT,
      ...(typeof parsed.checkedAt === "string" ? { checkedAt: parsed.checkedAt } : {}),
    };
  } catch {
    return null;
  }
}

export function writeEntitlementCache(
  baseDir: string,
  e: SessionEntitlement,
  now: () => number = Date.now,
): void {
  try {
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    const stamped: SessionEntitlement = e.checkedAt
      ? e
      : { ...e, checkedAt: new Date(now()).toISOString() };
    writeFileSync(cachePath(baseDir), JSON.stringify(stamped), { mode: 0o600 });
  } catch {
    // best-effort; a missing cache fails OPEN (capture), never closed
  }
}

/**
 * Should the native flush re-ask the server for entitlement?
 *
 * The native path has no `watch-session` to refresh this cache, so the
 * Stop-spawned flush owns it. Policy:
 * - no cache, or a missing/unparseable `checkedAt` -> ask (nothing current);
 * - LOCKED -> always ask, so upgrading to Pro unlocks on the very next turn
 *   rather than after a TTL the user cannot see;
 * - a future `checkedAt` (clock skew, restored backup) -> ask, so a bad stamp
 *   can never pin the cache open forever;
 * - otherwise ask only once the TTL has elapsed.
 */
export function shouldRefreshEntitlement(
  cached: SessionEntitlement | null,
  nowMs: number,
  ttlMs: number = ENTITLEMENT_TTL_MS,
): boolean {
  if (!cached) return true;
  if (!cached.entitled) return true;
  if (!cached.checkedAt) return true;
  const at = Date.parse(cached.checkedAt);
  if (Number.isNaN(at)) return true;
  const age = nowMs - at;
  return age < 0 || age >= ttlMs;
}

/** The hook's gate: capture unless the cache explicitly says locked. A missing
 *  cache permits capture — the flush writes the cache within the first session,
 *  and failing open avoids silently dropping a paying user's session. */
export function isCapturePermitted(baseDir: string = entitlementDir()): boolean {
  const cached = readEntitlementCache(baseDir);
  return cached ? cached.entitled : true;
}

/** The server's answer shape (mirrors `SessionEntitlementResponse`). */
export interface EntitlementFetchResult {
  plan: Plan;
  trial_used: number;
  trial_limit: number;
}

export interface RefreshEntitlementOptions {
  baseDir: string;
  /** Ask the server. Must reject (not resolve) on failure. */
  fetch: () => Promise<EntitlementFetchResult>;
  /** Skip the TTL check and ask regardless (used after a 402). */
  force?: boolean;
  now?: () => number;
  ttlMs?: number;
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Refresh the entitlement cache from the server, TTL-gated.
 *
 * This is the native path's cache owner. `watch-session` refreshes the cache
 * as a side effect of starting up, but the native flow has no watch-session,
 * so without this the cache is never written and `isCapturePermitted` fails
 * open forever — the paywall would never bite.
 *
 * Fail-open throughout: an unreachable server or a malformed answer leaves the
 * existing cache exactly as it was and returns it. A network blip must never
 * lock a paying user out, and it must never silently unlock a spent trial
 * either, which is why nothing is written unless the server actually answered.
 */
export async function refreshEntitlementCache(
  opts: RefreshEntitlementOptions,
): Promise<SessionEntitlement | null> {
  const now = opts.now ?? Date.now;
  const cached = readEntitlementCache(opts.baseDir);
  if (!opts.force && !shouldRefreshEntitlement(cached, now(), opts.ttlMs)) return cached;

  let answer: EntitlementFetchResult;
  try {
    answer = await opts.fetch();
  } catch {
    return cached; // offline / server error: keep what we had
  }
  if (!isFiniteInt(answer?.trial_used) || !isFiniteInt(answer?.trial_limit)) {
    return cached; // malformed: better a stale truth than a fabricated one
  }

  const fresh = computeEntitlement(answer.plan, answer.trial_used, answer.trial_limit);
  writeEntitlementCache(opts.baseDir, fresh, now);
  return readEntitlementCache(opts.baseDir) ?? fresh;
}
