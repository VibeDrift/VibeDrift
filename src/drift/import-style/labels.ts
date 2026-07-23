/**
 * Per-axis copy + pattern labels. Each `AxisClassification.axis` a classifier
 * emits must have an entry here; the detector uses it to build finding text.
 */

export interface AxisMeta {
  /** subCategory on the finding. */
  subCategory: string;
  /** Capitalized phrase for the per-directory finding, e.g. "Import path style". */
  headline: string;
  /** Lowercase phrase for the no-convention finding's `axisLabel`, e.g. "import path style". */
  axisLabel: string;
  /** Canonical pattern key → human label. */
  patternNames: Record<string, string>;
  /** Recommendation shown on the high-entropy "no dominant convention" finding. */
  noConventionRecommendation: string;
}

export const AXES = {
  // JS/TS relative-vs-alias path style (the original import-consistency axis).
  path_style: {
    subCategory: "path_style",
    headline: "Import path style",
    axisLabel: "import path style",
    patternNames: { relative: "relative paths (./)", alias: "path aliases (@/)" },
    noConventionRecommendation: "Establish a single import-path convention (alias or relative) and align files to it.",
  },
  // Go: are stdlib and external imports separated into blank-line groups?
  go_grouping: {
    subCategory: "go_grouping",
    headline: "Go import grouping",
    axisLabel: "Go import grouping",
    patternNames: { grouped: "grouped imports (blank-line separated)", flat: "a single flat import block" },
    noConventionRecommendation: "Pick one import-grouping convention (grouped or flat) and apply it across the package (gofmt/goimports group stdlib separately).",
  },
  // Go: are imports sorted within each group (gofmt order) or not?
  go_ordering: {
    subCategory: "go_ordering",
    headline: "Go import ordering",
    axisLabel: "Go import ordering",
    patternNames: { ordered: "sorted imports (gofmt order)", unordered: "unsorted imports" },
    noConventionRecommendation: "Run gofmt/goimports so imports are sorted within each group.",
  },
  // Python: intra-package imports written absolute (from pkg.mod) vs relative (from .mod).
  py_path_style: {
    subCategory: "py_path_style",
    headline: "Python import path style",
    axisLabel: "Python import path style",
    patternNames: { absolute: "absolute imports (from pkg.mod)", relative: "relative imports (from .mod)" },
    noConventionRecommendation: "Pick absolute or relative intra-package imports and apply it consistently (PEP 328).",
  },
  // Rust: glob `use …::*` vs explicit `use` paths.
  rust_glob: {
    subCategory: "rust_glob",
    headline: "Rust glob imports",
    axisLabel: "Rust glob imports",
    patternNames: { glob: "glob imports (use …::*)", explicit: "explicit use paths" },
    noConventionRecommendation: "Prefer explicit `use` paths over globs (`use …::*`) consistently across the crate.",
  },
  // Python: `from x import *` vs explicit names.
  py_wildcard: {
    subCategory: "py_wildcard",
    headline: "Python wildcard imports",
    axisLabel: "Python wildcard imports",
    patternNames: { wildcard: "wildcard imports (import *)", explicit: "explicit name imports" },
    noConventionRecommendation: "Prefer explicit names over `from x import *` consistently.",
  },
  // Rust: intra-crate refs written absolute (use crate::) vs relative (use super::/self::).
  rust_use_path: {
    subCategory: "rust_use_path",
    headline: "Rust intra-crate use path",
    axisLabel: "Rust intra-crate use path",
    patternNames: { crate: "absolute (use crate::)", relative: "relative (use super::/self::)" },
    noConventionRecommendation: "Pick absolute (`crate::`) or relative (`super::`/`self::`) intra-crate paths and apply it consistently.",
  },
  // Rust: are uses grouped by origin (std / external / internal) with blank lines, or flat?
  rust_grouping: {
    subCategory: "rust_grouping",
    headline: "Rust use grouping",
    axisLabel: "Rust use grouping",
    patternNames: { grouped: "grouped uses (std/external/crate blank-line separated)", flat: "a single flat use block" },
    noConventionRecommendation: "Pick one use-grouping convention (grouped by origin or flat) and apply it consistently.",
  },
} satisfies Record<string, AxisMeta>;

/**
 * The set of known axes. Classifiers type `AxisClassification.axis` as this
 * union, so emitting an axis with no metadata here is a compile error rather
 * than a silently-dropped classification.
 */
export type Axis = keyof typeof AXES;

/**
 * The valid pattern keys for a given axis, derived from that axis's
 * `patternNames` in {@link AXES} (the single source of truth). Lets
 * `AxisClassification` tie `pattern` to `axis`, so e.g. a `go_grouping`
 * classification can only carry `"grouped"` or `"flat"`.
 */
export type PatternOf<A extends Axis> = keyof (typeof AXES)[A]["patternNames"] & string;
