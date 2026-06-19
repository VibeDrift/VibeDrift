/**
 * Plan-tier predicate. Single source of truth for paid-only feature gates.
 *
 * Fix prompts (the copy-ready, peer-grounded fix for each finding) are a paid
 * feature; findings, scores, and dominant patterns stay free on every plan. The
 * client gates the local fix-prompt surfaces on this; the `/v1/fix-prompts` route
 * is the authoritative server-side backstop (require_paid).
 */
export type Plan = "free" | "pro" | "scale";

export function isPaidPlan(plan?: Plan | null): boolean {
  return plan === "pro" || plan === "scale";
}
