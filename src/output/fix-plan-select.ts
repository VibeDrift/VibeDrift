/**
 * Shared Fix Plan selection.
 *
 * The Fix Plan across every renderer (terminal, HTML, context markdown) is
 * framed as "highest-impact drifts to re-align first", and each item shows its
 * gain to one decimal place (`+X.Xpts consistency`). consistencyImpact is
 * stored to two decimals, so a finding with impact in 0.01–0.04 passed the old
 * `> 0` filter yet rendered as `+0.0pts` — telling the user to fix something
 * for no visible gain. That was the second half of the bandcamp-player-extension
 * complaint (items self-scored at zero impact presented as top priorities).
 *
 * We require impact >= FIX_PLAN_MIN_IMPACT so every listed item shows a
 * visibly non-zero gain (>= +0.1pts at one-decimal display).
 */
import type { Finding } from "../core/types.js";

/** Minimum consistency impact for a finding to qualify for the Fix Plan. At
 * one-decimal display this is the smallest value that does not render as
 * `+0.0pts`. */
export const FIX_PLAN_MIN_IMPACT = 0.05;

/** True when re-aligning this finding yields a visible (>= +0.1pts) gain. */
export function hasMeaningfulImpact(f: Finding): boolean {
  return (f.consistencyImpact ?? 0) >= FIX_PLAN_MIN_IMPACT;
}

/** Fix Plan candidates: meaningful-impact findings, sorted by descending
 * impact, capped at `limit`. */
export function selectFixPlanFindings(findings: Finding[], limit: number): Finding[] {
  return [...findings]
    .filter(hasMeaningfulImpact)
    .sort((a, b) => (b.consistencyImpact ?? 0) - (a.consistencyImpact ?? 0))
    .slice(0, limit);
}
