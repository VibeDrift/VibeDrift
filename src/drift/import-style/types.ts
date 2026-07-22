/**
 * Shared contract for the per-language import-style classifiers.
 *
 * Mirrors the `route-extractors/` pattern: one stateless functional module per
 * language behind a common interface, dispatched by a `SupportedLanguage`-keyed
 * table in `import-consistency.ts`. The language-agnostic detector runs one
 * dominance vote per **axis** (see `AxisClassification`), so a file can be
 * consistent on one dimension and drift on another.
 */

import type { DriftFile, Evidence } from "../types.js";

/**
 * One independent dimension of import style for a single file — e.g.
 * `path_style` (relative vs alias), `grouping`, `glob`. The `axis` becomes the
 * finding's `subCategory` and must have an entry in `AXES` (labels.ts).
 */
export interface AxisClassification {
  axis: string;
  /** Canonical pattern key for this file on this axis, e.g. "relative" | "alias". */
  pattern: string;
  evidence: Evidence[];
}

/**
 * A per-language import-style classifier. Stateless — a plain object satisfies
 * it. Returns `[]` when the file has no decidable axis (too few imports, an
 * unanalyzable path, etc.).
 */
export interface ImportStyleClassifier {
  classify(file: DriftFile): AxisClassification[];
}
