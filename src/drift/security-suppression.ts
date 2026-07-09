/**
 * Denominator-removing suppression for the Security Consistency route vote.
 *
 * A route carrying an inline `// @vibedrift-public` annotation (or the
 * language-appropriate comment variant) is excluded from the auth/validation/
 * rate-limit dominance vote entirely — it never enters the numerator OR the
 * denominator, so the ratio for the remaining routes stays honest.
 *
 * This is deliberately narrow: only the route's OWN registration line and the
 * line immediately above it are checked. Scanning the whole file for the
 * annotation would let one stray comment anywhere silently suppress every
 * route in that file — a real vulnerability could be hidden that way.
 * Under-matching (missing an intended annotation) is the safe failure
 * direction; over-matching (dropping an un-annotated route) is a correctness
 * bug and is guarded against by tests.
 *
 * Every suppression is recorded in `suppressed` and surfaced by the caller
 * (security-consistency.ts) as a cited, counted, INFO-severity hygiene
 * finding — so mass-annotating routes to silence the check leaves a visible
 * audit trail instead of just shrinking the sample silently.
 */

import type { DeviatingFile, DriftCategory, DriftFile, DriftFinding } from "./types.js";
import type { RouteInfo } from "./security-consistency.js";

export interface SuppressionRecord {
  path: string;
  line: number;
  reason: "annotation" | "allowlist";
  source: string;
}

/** JS/TS line comment: `// @vibedrift-public`. */
const LINE_COMMENT_RE = /\/\/\s*@vibedrift-public\b/;
/** JS/TS/CSS-style block comment: `/* @vibedrift-public *\/`. */
const BLOCK_COMMENT_RE = /\/\*\s*@vibedrift-public\b/;
/** Python (and shell-style) comment: `# @vibedrift-public`. */
const HASH_COMMENT_RE = /#\s*@vibedrift-public\b/;

function lineHasAnnotation(line: string | undefined): boolean {
  if (!line) return false;
  return LINE_COMMENT_RE.test(line) || BLOCK_COMMENT_RE.test(line) || HASH_COMMENT_RE.test(line);
}

/**
 * Filters `routes` down to `kept` (fed into every downstream dominance vote
 * and the uniform-auth-gap fallback) plus a `suppressed` audit trail.
 *
 * Only the annotation arm is implemented here (Task 4). Task 5 extends this
 * signature with a trailing config param carrying the glob allowlist arm
 * (`reason: "allowlist"`); this function's `reason` is always `"annotation"`
 * today.
 */
export function applyRouteSuppressions(
  routes: RouteInfo[],
  files: DriftFile[],
): { kept: RouteInfo[]; suppressed: SuppressionRecord[] } {
  const linesByPath = new Map<string, string[]>();
  for (const f of files) {
    linesByPath.set(f.relativePath, f.content.split("\n"));
  }

  const kept: RouteInfo[] = [];
  const suppressed: SuppressionRecord[] = [];

  for (const route of routes) {
    const lines = linesByPath.get(route.file);
    // route.line is 1-based. Its own line is index (route.line - 1); the
    // line immediately above it is index (route.line - 2), which only
    // exists when route.line >= 2.
    const ownLine = lines?.[route.line - 1];
    const precedingLine = route.line - 2 >= 0 ? lines?.[route.line - 2] : undefined;

    if (lineHasAnnotation(ownLine) || lineHasAnnotation(precedingLine)) {
      suppressed.push({
        path: route.file,
        line: route.line,
        reason: "annotation",
        source: "@vibedrift-public",
      });
      continue;
    }
    kept.push(route);
  }

  return { kept, suppressed };
}

/** Marks the audit finding below so `driftFindingToFinding` (src/drift/index.ts)
 *  can route it to the distinct hygiene analyzerId instead of the usual
 *  `drift-security_posture`. Not one of SECURITY_SUBCATEGORIES (types.ts) —
 *  this isn't a dominance-vote sub-convention, it's an audit log entry. */
export const SECURITY_SUPPRESSION_SUBCATEGORY = "Suppression audit";

/** Hygiene-kind analyzerId for the suppression audit finding, registered in
 *  src/scoring/categories.ts securityPosture.analyzers with kind "hygiene" —
 *  so citing an exclusion can never move the Vibe Drift composite. */
export const SECURITY_SUPPRESSION_ANALYZER_ID = "security-suppression";

const SECURITY_POSTURE: DriftCategory = "security_posture";
/** Cap on how many exclusions are spelled out inline in the finding message
 *  (readability); the full list always lands in `deviatingFiles`, which
 *  downstream rendering caps at 15 (driftFindingToFinding), same as every
 *  other detector. The COUNT in the message is always the true total, never
 *  truncated — mass-annotation stays visible even past the cap. */
const MESSAGE_LIST_CAP = 10;

function formatCitation(s: SuppressionRecord): string {
  return `${s.path}:${s.line} (${s.reason}: ${s.source})`;
}

function formatSuppressionList(suppressed: SuppressionRecord[]): string {
  const shown = suppressed.slice(0, MESSAGE_LIST_CAP).map(formatCitation);
  const extra = suppressed.length - shown.length;
  return extra > 0 ? `${shown.join(", ")}, +${extra} more` : shown.join(", ");
}

/**
 * Builds the always-cited, always-counted audit finding for a non-empty
 * `suppressed` list. Emitted by securityConsistency.detect() whenever ANY
 * route was suppressed, independent of whether the dominance vote itself
 * produces a finding — a suppressed route must leave a trail even when the
 * remaining routes are perfectly consistent and nothing else fires.
 *
 * `countBased: true` because this measures a COUNT (how many routes were
 * excluded), not a dominance ratio — there is no "wrong" number of
 * suppressions for the scoring engine to weigh against a peer baseline.
 */
export function buildSuppressionAuditFinding(suppressed: SuppressionRecord[]): DriftFinding {
  const deviatingFiles: DeviatingFile[] = suppressed.map((s) => ({
    path: s.path,
    detectedPattern: `excluded via ${s.reason} (${s.source})`,
    evidence: [{ line: s.line, code: s.source }],
  }));

  return {
    detector: "security_posture",
    subCategory: SECURITY_SUPPRESSION_SUBCATEGORY,
    driftCategory: SECURITY_POSTURE,
    severity: "info",
    confidence: 1,
    countBased: true,
    finding: `${suppressed.length} route(s) excluded from the security consistency check via @vibedrift-public: ${formatSuppressionList(suppressed)}`,
    // Not a real dominance vote (see countBased above): dominantPattern
    // names what's being counted (mirrors phantom-scaffolding's
    // "wired-up exports"), so consistencyScore 100 reads coherently as
    // "100% of the counted items are exclusions" rather than the
    // self-contradictory "no suppression, 100% consistent."
    dominantPattern: "route excluded via @vibedrift-public",
    dominantCount: suppressed.length,
    totalRelevantFiles: suppressed.length,
    consistencyScore: 100,
    deviatingFiles,
    dominantFiles: [],
    recommendation: "Periodically review @vibedrift-public annotations to confirm each excluded route is still intentionally public.",
  };
}
