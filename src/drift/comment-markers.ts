/**
 * Shared comment-line detection for the regex/line-based fallback paths across
 * drift detectors (security route extraction, import-style classification).
 *
 * These fallbacks match source text line by line, so a commented-out line must
 * not be mistaken for real code — e.g. a commented route becoming a phantom
 * that steals a `@vibedrift-public` annotation (#64 item 4), or a commented
 * import path being counted as a real import. JS/TS and Go share C-style
 * comments; Python differs (`#` line comments).
 */

/** Line-comment markers for C-style languages (JS, TS, Go). */
export const C_STYLE_COMMENT_MARKERS = ["//", "/*"] as const;
/** Line-comment markers for Python. */
export const PYTHON_COMMENT_MARKERS = ["#"] as const;

/** True when a source line is a line comment for any of the given markers. */
export function isCommentLine(line: string, markers: readonly string[]): boolean {
  const trimmed = line.trimStart();
  return markers.some((m) => trimmed.startsWith(m));
}
