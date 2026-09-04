/**
 * Shared helpers for the per-language route extractors: comment-line skipping
 * for the regex fallbacks, file-level middleware inheritance, handler-body
 * lookup, and the canonical mutating-method set. Extracted from
 * `security-consistency.ts` so each per-language module reuses one definition.
 */

import { SECURITY_AST } from "../security-ast.js";
import type { FileMiddleware } from "./types.js";

// Canonical mutating set (upper-cased), shared with the in-loop classifier via
// SECURITY_AST.MUTATING so batch and in-loop can never disagree. Includes ALL
// (Express .all() handles every verb) so an unauthed .all() route is not
// silently excluded from the auth vote.
export const MUTATION_METHODS = [...SECURITY_AST.MUTATING].map((m) => m.toUpperCase());

// ─── Regex-fallback comment skipping ─────────────────────────────────
// Comment-line detection is shared with the import-style classifiers, so it
// lives in comment-markers.ts (single source of truth) and is re-exported here
// — the per-language route extractors keep importing it from ./shared.js.
export { C_STYLE_COMMENT_MARKERS, PYTHON_COMMENT_MARKERS, isCommentLine, pythonNonCodeLines } from "../comment-markers.js";

// ─── Phase 2: inheritance resolution ─────────────────────────────────
// A route's effective protection is its per-route middleware UNION the
// file-level middleware detected for its file.
export function inheritedAuth(perRoute: boolean, fileMw: FileMiddleware | undefined): boolean {
  return perRoute || (fileMw?.hasAuth ?? false);
}
export function inheritedValidation(perRoute: boolean, fileMw: FileMiddleware | undefined): boolean {
  return perRoute || (fileMw?.hasValidation ?? false);
}
export function inheritedRateLimit(perRoute: boolean, fileMw: FileMiddleware | undefined): boolean {
  return perRoute || (fileMw?.hasRateLimit ?? false);
}

/** A window of source around a route path, used by the regex fallbacks to sniff
 *  the handler body for validation / error-handling signals.
 *
 *  `routeLine` (0-based, the line the route was matched on) anchors the window to
 *  THIS registration. Without it the window came from the FIRST textual
 *  occurrence of the path anywhere in the file, so a path named in a leading
 *  comment, an OpenAPI/docs string, or a route table read its window from there;
 *  and `GET /x` + `POST /x` — different routes, same path string — always shared
 *  one window, giving both the first one's signals. Callers that know the line
 *  should always pass it; the whole-file search is kept only as the fallback for
 *  callers that do not. */
export function findHandlerContent(fullContent: string, routePath: string, routeLine?: number): string {
  let idx: number;
  if (routeLine !== undefined) {
    let lineStart = 0;
    for (let n = 0; n < routeLine; n++) {
      const nl = fullContent.indexOf("\n", lineStart);
      if (nl === -1) { lineStart = fullContent.length; break; }
      lineStart = nl + 1;
    }
    // The path as it appears at or after this route's own line; if it is not
    // found (an unusual quoting), the line start itself still anchors the window.
    const at = fullContent.indexOf(routePath, lineStart);
    idx = at === -1 ? lineStart : at;
  } else {
    idx = fullContent.indexOf(routePath);
    if (idx === -1) return "";
  }
  return fullContent.slice(Math.max(0, idx - 500), Math.min(fullContent.length, idx + 2000));
}
