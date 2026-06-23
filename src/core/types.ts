import type { Tree, Node as SyntaxNode } from "web-tree-sitter";

export type { Tree, SyntaxNode };

export interface SourceFile {
  path: string;
  relativePath: string;
  language: SupportedLanguage | null;
  content: string;
  lineCount: number;
  tree?: Tree;
  /**
   * Git-derived temporal metadata. Populated by `collectGitMetadata`
   * during discovery; null on non-git directories or when git isn't
   * available. Drives recency-weighted dominance voting + pivot
   * detection. All scoring paths must tolerate null (graceful fallback
   * means "treat as neutral, 90-day age").
   */
  git?: FileGitMetadata | null;
}

export interface FileGitMetadata {
  /** Days since the file's most recent commit. 0 if HEAD just touched it. */
  lastModifiedDaysAgo: number;
  /** Distinct author emails who've committed to this file. */
  uniqueAuthors: number;
  /** Commits touching this file in the last 90 days. */
  commitCount90d: number;
  /** Commits ever touching this file. */
  commitCountTotal: number;
  /**
   * True when every commit to this file landed within a single 6-hour
   * window — a classic "AI wrote this in one sitting and nobody came
   * back to edit it" signal. Undefined when there are <2 commits.
   */
  singleSession?: boolean;
  /** Email of the first author to commit this file. Undefined when history is empty. */
  initialAuthorEmail?: string;
  /**
   * Shannon entropy of commit-count-by-author distribution. Range [0, log₂(k)]
   * where k is the number of distinct authors. 0 means "one author wrote
   * everything," higher values mean diverse authorship.
   */
  authorDiversity?: number;
  /**
   * Median gap (in hours) between consecutive commits on this file.
   * Undefined when there are <2 commits. Useful signal: files with a
   * tight median (e.g. <1h) were likely authored in one burst; files
   * with a long median were cultivated over time.
   */
  medianCommitIntervalHours?: number;
}

export type SupportedLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "go"
  | "rust";

export interface AnalysisContext {
  rootDir: string;
  files: SourceFile[];
  packageJson: PackageJson | null;
  goMod: GoMod | null;
  cargoToml: CargoToml | null;
  requirementsTxt: string[] | null;
  envExample: Map<string, string> | null;
  totalLines: number;
  languageBreakdown: Map<SupportedLanguage, { files: number; lines: number }>;
  dominantLanguage: SupportedLanguage | null;
  /**
   * True when the scan root is a git repository and metadata was
   * successfully collected. `files[].git` is populated in this case.
   * False when .git is missing, git CLI unavailable, or collection
   * timed out — temporal weighting silently no-ops.
   */
  hasGitMetadata?: boolean;
  /**
   * Team-declared conventions parsed from CLAUDE.md / AGENTS.md /
   * .cursorrules in the scan root. When a hint matches a detector's
   * category + pattern, it seeds the dominance vote (1.5× weight
   * boost to that pattern). A hint that conflicts with the voted
   * dominant also emits an `intent_divergence` finding — the team
   * declared X, the code does Y.
   *
   * Empty array when no intent files exist or nothing parseable was
   * found — hint-seeded voting silently no-ops.
   */
  intentHints?: import("../intent/types.js").IntentHint[];
}

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages: string[] };
  scripts?: Record<string, string>;
}

export interface GoMod {
  module: string;
  goVersion?: string;
  require: { path: string; version: string }[];
}

export interface CargoToml {
  name?: string;
  dependencies: Record<string, string>;
}

/**
 * The deep-scan tier's hero deliverable, synthesized server-side by
 * /v1/coherence (paid-only). A ranked audit of how internally consistent the
 * codebase is against ITS OWN dominant patterns — not external best-practice.
 */
export interface CoherenceIssue {
  rank: number;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  pattern: string; // the repo's own pattern this issue breaks
  locations: string[];
  why: string;
  fix: string;
}

export interface CoherenceReport {
  coherenceGrade: string; // A–F
  coherenceScore: number; // 0–100
  verdict: string;
  rankedIssues: CoherenceIssue[];
  strengths: string[];
}

export interface ScanResult {
  context: AnalysisContext;
  findings: Finding[];
  driftFindings: DriftFindingReport[];
  driftScores: any;
  /**
   * Scan-over-scan diff against the previous saved scan. Populated when
   * history exists and `--no-compare` was not set. Present but all-empty
   * when the previous scan was too old to compare (pre-digest schema).
   */
  diff?: import("../output/history-diff.js").DiffResult;
  /**
   * Result of the passive npm-registry update check. Populated when
   * network is enabled AND telemetry is not disabled. Null on any
   * failure (offline, registry error, timeout). Renderers show a dim
   * notice only when `outdated === true`.
   */
  updateCheck?: import("./update-check.js").UpdateCheckResult | null;
  /**
   * Per-category drift scores. Only drift-kind findings (dominance-based
   * detectors, Code DNA, ML) contribute here. Hygiene findings — generic
   * complexity, dead-code, OWASP regex checks, etc. — are scored
   * separately under `hygieneScores` / `hygieneScore` and do NOT affect
   * the Vibe Drift Score composite.
   */
  scores: CategoryScores;
  /** Drift-only composite, 0..maxCompositeScore (typically 0..100). */
  compositeScore: number;
  maxCompositeScore: number;
  /**
   * Parallel per-category scores for hygiene-kind findings. Same shape
   * and formula as `scores`, but fed exclusively by findings whose
   * analyzer is tagged `kind: "hygiene"`. Rendered in a separate pane.
   */
  hygieneScores: CategoryScores;
  /** Hygiene composite, 0..maxHygieneScore. Independent of Vibe Drift Score. */
  hygieneScore: number;
  maxHygieneScore: number;
  teaseMessages: string[];
  deepInsights: DeepInsight[];
  scanTimeMs: number;
  previousScan?: ScanResult;
  perFileScores: Map<string, PerFileScore>;
  codeDnaResult?: any; // CodeDnaResult from ../codedna/types
  aiSummary?: { summary: string; highlights: string[] };
  /** Deep-scan hero report (paid-only; null for free/local scans). */
  coherenceReport?: CoherenceReport;
  /**
   * Stable identifier of the scoring math used to produce these scores.
   * Cross-version deltas are refused at the engine layer — when this differs
   * from a previously saved scan's `scoringVersion`, delta arrows are
   * suppressed SILENTLY and a one-time "scoring refined" notice (linking
   * release notes) is shown instead (src/core/scoring-notice.ts). Users never
   * see this string. Persisted into history.ts + uploaded so the cloud can
   * backfill stored scores by version.
   */
  scoringVersion?: string;
  /**
   * Set to `"scoring-version-mismatch"` when a previous scan was loaded but
   * came from a different `scoringVersion`. Drives SILENT suppression of the
   * per-category delta arrows and the diff banner (no user-facing banner —
   * the one-time scoring-refined notice explains the change).
   */
  previousScoresMismatch?: string;
}

export interface DriftFindingReport {
  detector: string;
  subCategory?: string;
  driftCategory: string;
  severity: "info" | "warning" | "error";
  confidence: number;
  finding: string;
  dominantPattern: string;
  dominantCount: number;
  totalRelevantFiles: number;
  consistencyScore: number;
  deviatingFiles: { path: string; detectedPattern: string; evidence: { line: number; code: string }[] }[];
  dominantFiles?: string[];
  recommendation: string;
}

export interface PerFileScore {
  file: string;
  findings: Finding[];
  score: number;
  maxScore: number;
}

export interface CategoryScores {
  architecturalConsistency: CategoryScore;
  redundancy: CategoryScore;
  dependencyHealth: CategoryScore;
  securityPosture: CategoryScore;
  intentClarity: CategoryScore;
}

export interface CategoryScore {
  score: number;
  maxScore: number;
  locked: boolean;
  findingCount: number;
  applicable: boolean;
  delta?: number; // change from previous scan
}

export interface Finding {
  analyzerId: string;
  severity: "info" | "warning" | "error";
  confidence: number; // 0.0-1.0
  message: string;
  locations: FileLocation[];
  tags: string[];
  /**
   * Expected gain in the owning category's score (0–20 scale) if this
   * finding were resolved. First-order linearization around the current
   * weight — accurate for single-finding removals, an upper bound when
   * multiple findings from the same category are summed (actual gain is
   * sub-additive because the score formula is a decaying exponential).
   * Populated by `computeScores`; absent on raw pre-scored findings.
   */
  consistencyImpact?: number;
  /**
   * Drift signal carried over from the originating DriftFinding so the
   * scoring engine can weight a finding by HOW inconsistent its category
   * is (the dominance ratio) rather than merely whether a detector fired.
   * The deviation fraction (`1 - consistencyScore/100`) is the share of
   * relevant files that drift from the dominant pattern. Absent on
   * non-drift (static-analyzer) findings. Populated by
   * `driftFindingToFinding`; consumed by the scoring engine's per-finding
   * magnitude weight.
   */
  driftSignal?: {
    /** 0-100: (dominantCount / totalRelevantFiles) * 100. */
    consistencyScore: number;
    /** Number of files matching the dominant pattern. */
    dominantCount: number;
    /** Total files relevant to this drift category. */
    totalRelevantFiles: number;
  };
  /**
   * Structured context that downstream renderers (HTML, terminal, fix-
   * prompt template) use to build the Copy-as-AI-context block and
   * reference the peer baseline this finding deviates from. Populated
   * by `driftFindingToFinding` for drift-category findings.
   */
  metadata?: {
    dominantPattern?: string;
    dominantFiles?: string[];
    recommendation?: string;
    /** Deep-scan-synthesized prose describing how peers implement the dominant pattern. */
    fixPromptProse?: string;
    /**
     * When a temporal pivot was detected for this finding's category,
     * the UI can surface `fromPattern → toPattern` context and split
     * the legacy-aligned files into their own section (not treated as
     * true drift). Undefined when no pivot was detected.
     */
    pivot?: {
      fromPattern: string;
      toPattern: string;
      recentConsistencyScore: number;
      legacyConsistencyScore: number;
      recentFileCount: number;
      legacyFileCount: number;
    };
    /** File paths aligned with the pre-pivot pattern — migration candidates. */
    legacyFiles?: string[];
    /**
     * Present when a team-declared intent hint (from CLAUDE.md etc.)
     * disagreed with the voted dominant pattern. UI surfaces this as
     * "you declared X, the code does Y" with a link to the source file.
     */
    intentDivergence?: {
      declaredPattern: string;
      declaredLabel: string;
      source: string;
      line: number;
      text: string;
    };
    /**
     * When `locations` was truncated to a representative subset to keep
     * the finding from blowing up on huge duplicate groups, this is the
     * total number of group members. The dashboard / report can show
     * "showing 20 of N" with the original total. Set only by emitters
     * that aggregate over many group members (currently
     * `codedna-fingerprint`). Does not affect scoring — scoring uses
     * one severity × confidence per finding regardless of locations
     * count.
     */
    truncatedLocations?: number;
  };
}

export interface FileLocation {
  file: string;
  line?: number;
  column?: number;
  snippet?: string;
}

export interface DeepInsight {
  category: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "error";
  relatedFiles: string[];
  recommendation?: string;
}

export interface ScanOptions {
  json?: boolean;
  failOnScore?: number;
  format?: "terminal" | "json" | "html" | "csv" | "docx";
  output?: string;
  verbose?: boolean;
  codedna?: boolean;
  /** Enable AI-powered deep analysis. Requires `vibedrift login` (token from config/env). */
  deep?: boolean;
  /** Override the VibeDrift API base URL (developer/staging only). */
  apiUrl?: string;
  /** Glob patterns to include (intersection with discovery). */
  include?: string[];
  /** Glob patterns to exclude (subtracted from discovery). */
  exclude?: string[];
  /**
   * Override the auto-detected project name shown in the dashboard.
   * When omitted, the CLI autodetects from package.json / Cargo.toml /
   * go.mod / pyproject.toml, falling back to basename(rootDir).
   */
  projectName?: string;
  /** Anonymize the project name (uses privXXXXXXXXXXXX instead of the real name). */
  private?: boolean;
  /** Disable the per-analyzer findings cache. Default true (cache enabled). */
  cache?: boolean;
  /** Write .vibedrift/context.md + fix-plan.md + patterns.json into the project tree. */
  writeContext?: boolean;
  /** Skip ALL network calls — no scan log, no beacon, no deep, no fix-prompt synthesis. */
  localOnly?: boolean;
  /**
   * Explicitly enable (true) or disable (false) the scan-over-scan diff
   * banner. Undefined means "auto": diff when prior history exists.
   */
  compare?: boolean;
  /** Diff against a specific saved scan id (overrides default --compare target). */
  since?: string;
  /**
   * Scope the scan to files changed in git. `true` = uncommitted changes vs
   * HEAD; a string = changed vs that ref/branch (e.g. "main"). Most valuable
   * with --deep: deep-scan only what you changed (a paid, fast PR-gate flow).
   */
  diff?: string | boolean;
}
