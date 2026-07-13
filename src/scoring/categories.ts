import type { SupportedLanguage } from "../core/types.js";

export type ScoringCategory =
  | "architecturalConsistency"
  | "redundancy"
  | "dependencyHealth"
  | "securityPosture"
  | "intentClarity";

/**
 * VibeDrift measures DRIFT — deviation from the codebase's own dominant
 * pattern. Not every signal we collect is a drift signal:
 *   - "drift" kind: the analyzer/detector produces findings that are
 *     grounded in a dominance baseline, similarity signal, taint flow,
 *     or learned pattern. Cross-file consistency language.
 *   - "hygiene" kind: the analyzer produces generic findings without a
 *     repo baseline (classic linter territory — empty catches, high
 *     cyclomatic, dead code, generic OWASP rules, outdated deps).
 *
 * Only drift-kind findings feed the Vibe Drift Score composite. Hygiene
 * findings still render (users want them) but they live in their own
 * pane and a separate parallel score, so the composite stays true to the
 * product identity in CLAUDE.md.
 */
export type AnalyzerKind = "drift" | "hygiene";

export interface AnalyzerMeta {
  id: string;
  applicableLanguages: SupportedLanguage[] | "all";
  kind: AnalyzerKind;
}

export interface CategoryConfig {
  name: string;
  maxScore: number;
  analyzers: AnalyzerMeta[];
}

export const CATEGORY_CONFIG: Record<ScoringCategory, CategoryConfig> = {
  architecturalConsistency: {
    name: "Architectural Consistency",
    maxScore: 20,
    analyzers: [
      // Dominance-based: entropy-gated convention voting
      { id: "naming", applicableLanguages: "all", kind: "drift" },
      // Cross-file consistency: ESM vs CJS mixing with context awareness
      { id: "imports", applicableLanguages: ["javascript", "typescript"], kind: "drift" },
      // Generic: empty catches, unhandled async — not dominance-based
      { id: "error-handling", applicableLanguages: ["javascript", "typescript"], kind: "hygiene" },
      // Generic language idiom checks
      { id: "language-specific", applicableLanguages: "all", kind: "hygiene" },
      // Cross-file drift detectors. analyzerId is `drift-<driftCategory>`
      // (see driftFindingToFinding in src/drift/index.ts). All structural-
      // convention drift categories roll up into Architectural Consistency.
      // commit-archaeology emits driftCategory `architectural_consistency`,
      // so it flows in here too (no separate id needed).
      { id: "drift-architectural_consistency", applicableLanguages: "all", kind: "drift" },
      { id: "drift-naming_conventions", applicableLanguages: "all", kind: "drift" },
      { id: "drift-async_patterns", applicableLanguages: ["javascript", "typescript", "python", "rust"], kind: "drift" },
      { id: "drift-import_style", applicableLanguages: "all", kind: "drift" },
      { id: "drift-export_style", applicableLanguages: ["javascript", "typescript"], kind: "drift" },
      { id: "drift-return_shape_consistency", applicableLanguages: "all", kind: "drift" },
      { id: "drift-logging_consistency", applicableLanguages: "all", kind: "drift" },
      { id: "drift-state_management_consistency", applicableLanguages: "all", kind: "drift" },
      { id: "drift-test_structure_consistency", applicableLanguages: "all", kind: "drift" },
      // Code DNA
      { id: "codedna-pattern", applicableLanguages: "all", kind: "drift" },
      { id: "codedna-deviation", applicableLanguages: "all", kind: "drift" },
      // ML
      { id: "ml-anomaly", applicableLanguages: "all", kind: "drift" },
    ],
  },
  redundancy: {
    name: "Redundancy",
    maxScore: 20,
    analyzers: [
      // Static regex-based duplicate detection — no dominance, just "these look alike"
      { id: "duplicates", applicableLanguages: "all", kind: "hygiene" },
      // Generic TODO clustering
      { id: "todo-density", applicableLanguages: "all", kind: "hygiene" },
      // Generic unused-export detection
      { id: "dead-code", applicableLanguages: "all", kind: "hygiene" },
      // Cross-file drift: semantic duplication + phantom (unused) scaffolding
      { id: "drift-semantic_duplication", applicableLanguages: "all", kind: "drift" },
      { id: "drift-phantom_scaffolding", applicableLanguages: "all", kind: "drift" },
      // Code DNA (AST-normalized fingerprint + opseq — real drift signal)
      { id: "codedna-fingerprint", applicableLanguages: "all", kind: "drift" },
      { id: "codedna-opseq", applicableLanguages: "all", kind: "drift" },
      // ML embeddings
      { id: "ml-duplicate", applicableLanguages: "all", kind: "drift" },
      // Panel-confirmed redundant reimplementation. Hygiene by default (renders
      // in its own pane, does NOT feed the composite) because raw reimplementation
      // COUNT does not separate clean from messy code — large clean repos carry a
      // sparse baseline. When reimplementation is CONCENTRATED, computeScores
      // re-tags the findings to the drift-kind id below so they feed the composite
      // (see applyReimplementationConcentrationGate, calibrated 2026-06-27: 0/249
      // elite repos cross the bar). The split is the lever the geometric-mean
      // composite needs to express "show but don't score" vs "score".
      { id: "ml-reimplementation", applicableLanguages: "all", kind: "hygiene" },
      { id: "ml-reimplementation-concentrated", applicableLanguages: "all", kind: "drift" },
    ],
  },
  dependencyHealth: {
    name: "Dependency Health",
    maxScore: 20,
    analyzers: [
      { id: "dependencies", applicableLanguages: "all", kind: "hygiene" },
      { id: "config-drift", applicableLanguages: "all", kind: "hygiene" },
    ],
  },
  securityPosture: {
    name: "Security Consistency",
    maxScore: 20,
    analyzers: [
      // Generic OWASP regex checks
      { id: "security", applicableLanguages: "all", kind: "hygiene" },
      // Absolute-floor subset of the OWASP regex checks (private-key,
      // aws-key, hardcoded-api-key, hardcoded-token, go-tls-skip-verify),
      // emitted under a distinct id (see security.ts) so a high-precision
      // badge can be rendered separately. Hygiene-kind: never dents the
      // Vibe Drift composite, same as its parent "security" analyzer.
      { id: "security-floor", applicableLanguages: "all", kind: "hygiene" },
      // Cross-file auth/validation/rate-limiting consistency — real drift
      // (analyzerId `drift-security_posture`, from driftCategory).
      { id: "drift-security_posture", applicableLanguages: "all", kind: "drift" },
      // Route-consistency findings with too few peer routes to score
      // (see applySecurityMinPeerFloor). Advisory: renders on the hygiene
      // track, never touches the drift composite.
      { id: "security_posture-advisory", applicableLanguages: "all", kind: "hygiene" },
      // Suppression audit trail: cites every route excluded from the vote via
      // `// @vibedrift-public` (see security-suppression.ts). Hygiene-kind so
      // an exclusion is always visible but never moves the composite — the
      // anti-abuse property is "counted and cited," not "silently ignored."
      { id: "security-suppression", applicableLanguages: "all", kind: "hygiene" },
      // Code DNA taint analysis
      { id: "codedna-taint", applicableLanguages: "all", kind: "drift" },
    ],
  },
  intentClarity: {
    name: "Intent Clarity",
    maxScore: 20,
    analyzers: [
      // Generic clarity metrics
      { id: "intent-clarity", applicableLanguages: "all", kind: "hygiene" },
      // Generic cyclomatic complexity
      { id: "complexity", applicableLanguages: "all", kind: "hygiene" },
      // Placeholder returns / NotImplementedError in production code.
      // Added 0.6.4 after the /v1/analyze stub slipped through review.
      { id: "implementation-gap", applicableLanguages: "all", kind: "hygiene" },
      // Cross-file comment-style drift (driftCategory comment_style_consistency)
      { id: "drift-comment_style_consistency", applicableLanguages: "all", kind: "drift" },
      // ML intent-mismatch — function name vs body semantic alignment
      { id: "ml-intent", applicableLanguages: "all", kind: "drift" },
    ],
  },
};

export const ALL_CATEGORIES = Object.keys(CATEGORY_CONFIG) as ScoringCategory[];

/** Drift categories that actually have a drift detector. Dependency Health has
 * only hygiene analyzers (no drift detector) so it is never a drift dimension —
 * excluded from the drift score DISPLAY + scope note. It still scores on the
 * Hygiene track. If a dependency-drift detector is ever added, it reappears
 * automatically. */
export const DRIFT_DISPLAY_CATEGORIES = ALL_CATEGORIES.filter((c) =>
  CATEGORY_CONFIG[c].analyzers.some((a) => a.kind === "drift"),
);

/**
 * Lookup the kind of an analyzer ID.
 *
 * Defaults to "hygiene" for unknown IDs — safe default because hygiene
 * findings don't contaminate the drift composite. A new drift-kind
 * analyzer must be registered in CATEGORY_CONFIG above to count.
 */
const ANALYZER_KIND_INDEX: Map<string, AnalyzerKind> = (() => {
  const map = new Map<string, AnalyzerKind>();
  for (const cat of ALL_CATEGORIES) {
    for (const a of CATEGORY_CONFIG[cat].analyzers) {
      map.set(a.id, a.kind);
    }
  }
  return map;
})();

export function getAnalyzerKind(analyzerId: string): AnalyzerKind {
  return ANALYZER_KIND_INDEX.get(analyzerId) ?? "hygiene";
}

export function getApplicableAnalyzerIds(
  category: ScoringCategory,
  projectLanguages: SupportedLanguage[],
  kind?: AnalyzerKind,
): string[] {
  return CATEGORY_CONFIG[category].analyzers
    .filter((a) => {
      if (kind !== undefined && a.kind !== kind) return false;
      if (a.applicableLanguages === "all") return true;
      return a.applicableLanguages.some((l) => projectLanguages.includes(l));
    })
    .map((a) => a.id);
}

export function isCategoryApplicable(
  category: ScoringCategory,
  projectLanguages: SupportedLanguage[],
  kind?: AnalyzerKind,
): boolean {
  return getApplicableAnalyzerIds(category, projectLanguages, kind).length > 0;
}
