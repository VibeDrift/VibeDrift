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
import type { Tree } from "../core/types.js";

export interface SuppressionRecord {
  path: string;
  line: number;
  reason: "annotation" | "allowlist";
  source: string;
}

/** The annotation token itself, matched only INSIDE a real comment (never a
 *  string literal) via the AST/textual comment-awareness below. */
const ANNOTATION_RE = /@vibedrift-public\b/;

/**
 * Comment markers per language family. Python (and shell-style) uses `#`;
 * the C family (JS/TS/Go/Rust) uses `//` and `/*`. Applying the wrong marker
 * across languages is a false-positive source (Finding 2): a leading `#` in a
 * JS/TS file is not a comment at all, so it must never suppress a JS/TS route.
 * Unknown/absent languages default to the C family (the common case for the
 * regex-fallback path, which only runs when no parse tree is available).
 */
function commentMarkersFor(language: string | null | undefined): string[] {
  if (language === "python") return ["#"];
  return ["//", "/*"];
}

/**
 * Blank out string-literal spans so an annotation living INSIDE a string
 * (`const s = "see // @vibedrift-public"`) can never be mistaken for a real
 * comment (Finding 2). Handles double, single, and backtick quotes with
 * escapes. Only closed spans are stripped: an unterminated quote is left in
 * place, which at worst leaves a rare, malformed line looking comment-like —
 * acceptable because the AST path (which is exact) handles every parseable
 * file, and this textual path is the conservative fallback only.
 */
function stripStringLiterals(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** The comment portion of a line (everything from the earliest comment marker
 *  onward), or null when the line carries no comment marker for its language. */
function commentPortion(line: string, markers: string[]): string | null {
  let earliest = -1;
  for (const m of markers) {
    const idx = line.indexOf(m);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  return earliest === -1 ? null : line.slice(earliest);
}

/** Regex-fallback (no parse tree): does this line carry the annotation inside a
 *  real comment for its language? String literals are stripped first so a
 *  quoted `// @vibedrift-public` never counts, and the marker set is chosen per
 *  language so a `#` never matches a JS/TS line. */
function lineHasAnnotationTextual(line: string | undefined, language: string | null | undefined): boolean {
  if (!line) return false;
  const comment = commentPortion(stripStringLiterals(line), commentMarkersFor(language));
  return comment !== null && ANNOTATION_RE.test(comment);
}

/** AST path: 0-based rows on which a `comment` NODE containing the annotation
 *  STARTS. Sourcing from comment nodes structurally excludes string literals
 *  and cross-language marker confusion (Finding 2). */
function annotationCommentRows(tree: Tree): Set<number> {
  const rows = new Set<number>();
  for (const c of tree.rootNode.descendantsOfType("comment")) {
    if (!c) continue;
    if (ANNOTATION_RE.test(c.text)) rows.add(c.startPosition.row);
  }
  return rows;
}

/**
 * Filters `routes` down to `kept` (fed into every downstream dominance vote
 * and the uniform-auth-gap fallback) plus a `suppressed` audit trail.
 *
 * An annotation binds to a route in exactly two ways:
 *   (a) it is a comment on the route's OWN registration line (trailing or
 *       full-line), or
 *   (b) it is a STANDALONE comment on the line immediately above the route,
 *       where "standalone" means that preceding line is NOT itself another
 *       route's own registration line.
 *
 * Case (b)'s guard is the fix for the over-suppression bug (Finding 1): a
 * trailing `// @vibedrift-public` on route N's own line also sits on the line
 * immediately above route N+1 when they are consecutive. Without the guard,
 * that trailing comment binds to BOTH N (correct) and N+1 (wrong), silently
 * dropping an un-annotated route from the vote and hiding its auth drift. We
 * reject the preceding-line match whenever the preceding line is some route's
 * own registration line — that annotation belongs to that route, not this one.
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
  const filesByPath = new Map<string, DriftFile>();
  for (const f of files) filesByPath.set(f.relativePath, f);

  // Every route's OWN 1-based registration line, keyed `file:line`. Used to
  // reject a preceding-line annotation that is really the PREVIOUS route's
  // trailing comment (Finding 1).
  const ownLineKeys = new Set<string>();
  for (const r of routes) ownLineKeys.add(`${r.file}:${r.line}`);

  // Per-file resolver: "does an annotation comment start on 0-based row X?"
  // AST (comment nodes) when a tree is present, string-stripped textual check
  // otherwise. Cached per file so we parse the comment set at most once.
  const rowResolvers = new Map<string, (row: number) => boolean>();
  function resolverFor(file: DriftFile): (row: number) => boolean {
    const cached = rowResolvers.get(file.relativePath);
    if (cached) return cached;
    let resolver: (row: number) => boolean;
    if (file.tree) {
      const rows = annotationCommentRows(file.tree);
      resolver = (row) => rows.has(row);
    } else {
      const lines = file.content.split("\n");
      resolver = (row) => lineHasAnnotationTextual(lines[row], file.language);
    }
    rowResolvers.set(file.relativePath, resolver);
    return resolver;
  }

  const kept: RouteInfo[] = [];
  const suppressed: SuppressionRecord[] = [];

  for (const route of routes) {
    const file = filesByPath.get(route.file);
    if (!file) {
      // Can't resolve the file's content/tree — keep the route (safe default:
      // under-matching an annotation never hides a vulnerability).
      kept.push(route);
      continue;
    }

    const hasAnnotationOnRow = resolverFor(file);
    // route.line is 1-based; the 0-based own row is (route.line - 1), the
    // preceding row is (route.line - 2).
    const ownRow = route.line - 1;
    const precRow = route.line - 2;

    const ownMatch = ownRow >= 0 && hasAnnotationOnRow(ownRow);
    // Preceding-line match only when that line is a standalone annotation, not
    // the previous route's own registration line (Finding 1). `route.line - 1`
    // is the preceding line's 1-based number.
    const precMatch =
      precRow >= 0 &&
      !ownLineKeys.has(`${route.file}:${route.line - 1}`) &&
      hasAnnotationOnRow(precRow);

    if (ownMatch || precMatch) {
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
