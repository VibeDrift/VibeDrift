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
import type { Axis, PatternOf } from "./labels.js";

/**
 * One independent dimension of import style for a single file — e.g.
 * `path_style` (relative vs alias), `grouping`, `glob`. A distributive union
 * over {@link Axis}: `pattern` is tied to `axis` via {@link PatternOf}, so a
 * classifier can only pair an axis with one of *its* pattern keys (a mismatch
 * is a compile error, not an `undefined` label at runtime). `axis` becomes the
 * finding's `subCategory`.
 */
export type AxisClassification = {
  [A in Axis]: { axis: A; pattern: PatternOf<A>; evidence: Evidence[] };
}[Axis];

/**
 * A per-language import-style classifier. Stateless — a plain object satisfies
 * it. Returns `[]` when the file has no decidable axis (too few imports, an
 * unanalyzable path, etc.).
 */
export interface ImportStyleClassifier {
  classify(file: DriftFile): AxisClassification[];
}
