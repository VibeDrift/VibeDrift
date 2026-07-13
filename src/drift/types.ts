import type { Finding, FileGitMetadata } from "../core/types.js";
import type { ProjectConfig } from "../core/project-config.js";
import type { Tree } from "web-tree-sitter";

export interface DriftDetector {
  id: string;
  name: string;
  category: DriftCategory;
  detect(ctx: DriftContext): DriftFinding[];
}

export type DriftCategory =
  | "architectural_consistency"
  | "security_posture"
  | "semantic_duplication"
  | "naming_conventions"
  | "phantom_scaffolding"
  | "import_style"
  | "export_style"
  | "async_patterns"
  | "return_shape_consistency"
  | "logging_consistency"
  | "comment_style_consistency"
  | "state_management_consistency"
  | "test_structure_consistency";

export const DRIFT_WEIGHTS: Record<DriftCategory, number> = {
  architectural_consistency: 16,
  security_posture: 14,
  semantic_duplication: 14,
  naming_conventions: 12,
  phantom_scaffolding: 12,
  import_style: 12,
  export_style: 10,
  async_patterns: 10,
  return_shape_consistency: 12,
  logging_consistency: 8,
  comment_style_consistency: 5,
  state_management_consistency: 10,
  test_structure_consistency: 6,
};

export interface DriftContext {
  files: DriftFile[];
  totalLines: number;
  dominantLanguage: string | null;
  /** True when git history is available — enables recency weighting + pivot detection. */
  hasGitMetadata?: boolean;
  /**
   * Team-declared convention hints parsed from CLAUDE.md / AGENTS.md /
   * .cursorrules. Empty array when nothing was found. When populated,
   * matching hints bias dominance votes and can trigger standalone
   * intent-divergence findings when code ignores a declaration.
   */
  intentHints?: import("../intent/types.js").IntentHint[];
  /**
   * Carried over from `AnalysisContext.projectConfig` by `buildDriftContext`.
   * Consumed today by the Security Consistency detector's config glob
   * allowlist (`security.allowlist`); undefined whenever the caller built
   * its `AnalysisContext` without loading a project config (e.g. the
   * MCP/baseline path), in which case that arm no-ops.
   */
  projectConfig?: ProjectConfig;
}

export interface DriftFile {
  relativePath: string;
  language: string | null;
  content: string;
  lineCount: number;
  /** Pre-parsed tree-sitter tree (populated by parseFiles before detection).
   *  Absent when the language is unsupported or parsing failed — detectors
   *  must fall back to regex on `content`. */
  tree?: Tree;
  /** Populated when hasGitMetadata is true; null for files not in history. */
  git?: FileGitMetadata | null;
}

/**
 * Classification per deviating file. Temporal analysis converts what
 * would have been a flat `deviatingFiles` list into a three-way split:
 *
 *   - `drift`   — deviates from the recent majority AND the legacy majority
 *                 (genuinely off on its own; highest fix priority)
 *   - `legacy`  — aligns with an older majority but diverges from the
 *                 recent one (migration candidate, not drift)
 *   - `aligned` — follows the recent majority (not emitted as a finding;
 *                 here only for completeness in pivot-aware reporting)
 */
export type DeviationClassification = "drift" | "legacy" | "aligned";

export interface Evidence {
  line: number;
  code: string;
}

export interface DeviatingFile {
  path: string;
  detectedPattern: string;
  evidence: Evidence[];
  /**
   * Temporal classification from pivot-aware analysis. Absent when
   * no git metadata is available (falls back to treating as `drift`
   * for rendering). Populated by `classifyDeviations` after voting.
   */
  classification?: DeviationClassification;
}

/**
 * Emitted when a drift category shows a clear temporal pivot — the
 * recent-dominant pattern differs from the legacy-dominant pattern,
 * both with high consistency. Signals the codebase is directionally
 * migrating, and files on the old pattern are legacy, not drift.
 */
export interface PivotDetection {
  fromPattern: string;
  toPattern: string;
  recentConsistencyScore: number; // 0-100
  legacyConsistencyScore: number; // 0-100
  recentFileCount: number;
  legacyFileCount: number;
}

export interface DriftFinding {
  detector: string;
  subCategory?: string;
  driftCategory: DriftCategory;
  severity: "info" | "warning" | "error";
  confidence: number;
  finding: string;
  dominantPattern: string;
  dominantCount: number;
  totalRelevantFiles: number;
  consistencyScore: number; // 0-100: (dominant/total)*100
  /**
   * True for detectors that measure a COUNT phenomenon (duplicate pairs, dead
   * exports) rather than a dominance vote. These have no real
   * dominantCount/totalRelevantFiles peer ratio, so the scoring engine must
   * NOT treat `consistencyScore` as a deviation rate. When set, the engine
   * routes the finding through its count-based density branch (size-normalized
   * per KLOC) instead of the dominance branch. `consistencyScore` may still be
   * carried for the report bars, but it does not drive the composite.
   */
  countBased?: boolean;
  deviatingFiles: DeviatingFile[];
  /**
   * Up to 3 files that exemplify the dominant pattern — used by fix-prompt
   * generation ("see also userService.ts:12, productService.ts:8") and by
   * the deep-scan tier to extract reference implementations. Sorted
   * alphabetically for stable output across re-scans. Optional for
   * backward compat; detectors that can produce it should.
   */
  dominantFiles?: string[];
  /** Present when a temporal pivot was detected for this category. */
  pivot?: PivotDetection;
  /** Files aligned with the old dominant but not the new — migration targets. */
  legacyFiles?: DeviatingFile[];
  /**
   * Present when a team-declared intent hint disagreed with the voted
   * dominant pattern. Downstream renderers use this to show a "declared
   * X, code does Y" banner and cite the declaration source.
   */
  intentDivergence?: {
    declaredPattern: string;
    declaredLabel: string;
    source: string;
    line: number;
    text: string;
  };
  recommendation: string;
}

/**
 * Canonical labels for the three security sub-conventions the route-consistency
 * detector votes on. Single source of truth so the detector's emitted
 * `subCategory` and the baseline sub-vote lookup (get_dominant_pattern) can
 * never drift apart.
 */
export const SECURITY_SUBCATEGORIES = {
  auth: "Auth middleware",
  validation: "Input validation",
  rateLimit: "Rate limiting",
} as const;
