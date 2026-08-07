/**
 * Helpers shared verbatim by the per-language security-AST analyzers
 * (`security-ast-{go,rust,python}.ts`). Each was a byte-identical copy in two or
 * three of those files; extracting them here means they cannot silently diverge
 * — a real hazard in the NEVER-FALSE-BLESS layer. Language-specific helpers
 * (node-type skip lists, function-def node kinds, string-literal decoding)
 * deliberately stay in their own files.
 */

import type { SyntaxNode } from "../core/types.js";

/**
 * Lowercase segments of an identifier, split on underscore/non-alphanumeric AND
 * CamelCase boundaries (digits stay attached to their run):
 *   "get_author_stats" → [get, author, stats]; "JWTBearer" → [jwt, bearer];
 *   "OAuth2PasswordBearer" → [o, auth2, password, bearer].
 * Whole-segment matching makes substring blessing structurally impossible.
 */
export function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0);
}

/**
 * True when `node` or any ancestor BELOW `source_file` carries a parse error — a
 * per-construct surgical skip, never a whole-file fallback. Error recovery can
 * swallow a later valid registration into a broken call's argument list as a
 * clean-looking nested node; extracting from that garbage context could
 * attribute a route to the wrong receiver/scope. Stopping below `source_file`
 * means a file-level error in a SIBLING construct does not suppress clean ones.
 */
export function inErroredContext(node: SyntaxNode): boolean {
  let cur: SyntaxNode | null = node;
  while (cur && cur.type !== "source_file") {
    if (cur.hasError) return true;
    cur = cur.parent;
  }
  return false;
}

/** Non-null named children of a node (or [] when the node is absent). */
export function namedChildrenOf(n: SyntaxNode | null | undefined): SyntaxNode[] {
  return n ? n.namedChildren.filter((c): c is SyntaxNode => c !== null) : [];
}
