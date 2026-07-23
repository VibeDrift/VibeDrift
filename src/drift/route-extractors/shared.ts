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
// The regex route extractors (used when tree-sitter has no clean parse) match
// route-shaped text line by line. A commented-out registration must NOT become
// a phantom route — it would steal a @vibedrift-public annotation from the real
// route below it (see #64 item 4). JS/TS and Go share C-style comments, so their
// markers live in one place; Python differs (# line comments, """/''' docstrings).
export const C_STYLE_COMMENT_MARKERS = ["//", "/*"] as const; // JS, TS, Go
export const PYTHON_COMMENT_MARKERS = ["#"] as const;

/** True when a source line is a line comment for the given markers. */
export function isCommentLine(line: string, markers: readonly string[]): boolean {
  const trimmed = line.trimStart();
  return markers.some((m) => trimmed.startsWith(m));
}

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
 *  the handler body for validation / error-handling signals. */
export function findHandlerContent(fullContent: string, routePath: string): string {
  const idx = fullContent.indexOf(routePath);
  if (idx === -1) return "";
  return fullContent.slice(Math.max(0, idx - 500), Math.min(fullContent.length, idx + 2000));
}
