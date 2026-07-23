/**
 * Small helpers shared by the per-language import-style classifiers — mirrors
 * `route-extractors/shared.ts`. Kept deliberately thin: language-specific
 * collection stays in each classifier; only the genuinely identical mechanics
 * (tree-usability gate, evidence cap, binary-majority tie-break) live here.
 */

import type { Tree } from "../../core/types.js";
import type { DriftFile, Evidence } from "../types.js";

/** Max evidence snippets attached to a single classification. */
export const EVIDENCE_LIMIT = 3;

/**
 * The file's parse tree when it's usable — present and error-free — otherwise
 * `null`, which is every classifier's signal to fall back to line/regex
 * scanning. Centralizes the `file.tree && !rootNode.hasError` check (and drops
 * the `file.tree!` non-null assertions at call sites).
 */
export function cleanTree(file: DriftFile): Tree | null {
  return file.tree && !file.tree.rootNode.hasError ? file.tree : null;
}

/** Cap an evidence list at {@link EVIDENCE_LIMIT}. */
export function capEvidence(evidence: Evidence[]): Evidence[] {
  return evidence.slice(0, EVIDENCE_LIMIT);
}

/**
 * Winner of a two-way count where a file with only one side present classifies
 * as that side, and a tie breaks to the first (`a`) label. This is the shared
 * shape behind path_style (relative/alias), py_path_style (relative/absolute),
 * and rust_use_path (crate/relative).
 */
export function binaryMajority<A extends string, B extends string>(
  a: number,
  aLabel: A,
  b: number,
  bLabel: B,
): A | B {
  if (b === 0) return aLabel;
  if (a === 0) return bLabel;
  return a >= b ? aLabel : bLabel;
}
