/**
 * Drift Sessions entitlement (decision 8): sessions are Pro-only with a one-time
 * 5-session trial. The count lives server-side (survives reinstall / machine
 * hops); this module holds the pure policy plus a LOCAL cache the offline hook
 * reads to decide whether to capture at all. `watch-session` (online) refreshes
 * the cache from the server; the hook never makes a network call.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isPaidPlan, type Plan } from "../auth/plan.js";

export const SESSION_TRIAL_LIMIT = 5;

export type EntitlementReason = "pro" | "trial" | "locked";

export interface SessionEntitlement {
  entitled: boolean;
  reason: EntitlementReason;
  plan: Plan;
  trialUsed: number;
  trialLimit: number;
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
  return join(homedir(), ".vibedrift");
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
    };
  } catch {
    return null;
  }
}

export function writeEntitlementCache(baseDir: string, e: SessionEntitlement): void {
  try {
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    writeFileSync(cachePath(baseDir), JSON.stringify(e), { mode: 0o600 });
  } catch {
    // best-effort; a missing cache fails OPEN (capture), never closed
  }
}

/** The hook's gate: capture unless the cache explicitly says locked. A missing
 *  cache permits capture — watch-session writes the cache before hooks are
 *  useful, and failing open avoids silently dropping a paying user's session. */
export function isCapturePermitted(baseDir: string = entitlementDir()): boolean {
  const cached = readEntitlementCache(baseDir);
  return cached ? cached.entitled : true;
}
