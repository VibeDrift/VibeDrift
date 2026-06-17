import type {
  Finding,
  CategoryScores,
  CategoryScore,
  SupportedLanguage,
  PerFileScore,
  AnalysisContext,
} from "../core/types.js";
import {
  CATEGORY_CONFIG,
  ALL_CATEGORIES,
  isCategoryApplicable,
  getApplicableAnalyzerIds,
  getAnalyzerKind,
  type AnalyzerKind,
  type ScoringCategory,
} from "./categories.js";

/**
 * Scoring math version. Bumped when the formula or normalization changes
 * in a way that makes raw `compositeScore` values from different versions
 * incomparable. Cross-version deltas are refused rather than rendered as
 * misleading numeric differences.
 *
 * History:
 *   v1 — pre-0.7.0: raw composite on /80 scale, no normalization.
 *   v2 — 0.7.0+:    composite normalized to /100 at the engine boundary.
 *   v3 — Phase 0:   all 14 drift detectors wired into the composite (was 3),
 *                   single scoring engine (dual-engine collapse). The number
 *                   changes meaningfully, so this is a real methodology bump.
 *
 * A change here is absorbed silently for users: stored scores are re-aligned
 * where possible and a one-time release-notes notice is shown (see
 * src/core/scoring-notice.ts). Users never see this string.
 */
export const SCORING_VERSION = "v3";

const SEVERITY_WEIGHTS = { error: 3, warning: 1.5, info: 0.5 };

const ENTRY_POINT_PATTERNS = [
  /index\.[jt]sx?$/, /main\.[jt]s$/, /app\.[jt]sx?$/, /server\.[jt]s$/,
  /main\.go$/, /main\.py$/, /lib\.rs$/, /mod\.rs$/,
  /\.config\.[jt]s$/, /\.env/,
];

function isEntryPoint(filePath: string): boolean {
  return ENTRY_POINT_PATTERNS.some((p) => p.test(filePath));
}

function computeFileImportanceWeight(filePath: string): number {
  if (isEntryPoint(filePath)) return 1.5;
  return 1.0;
}

function computeCorrelationAmplifier(findings: Finding[]): Map<string, number> {
  const fileAnalyzers = new Map<string, Set<string>>();
  for (const f of findings) {
    for (const loc of f.locations) {
      if (!loc.file) continue;
      if (!fileAnalyzers.has(loc.file)) fileAnalyzers.set(loc.file, new Set());
      fileAnalyzers.get(loc.file)!.add(f.analyzerId);
    }
  }

  const amplifiers = new Map<string, number>();
  for (const [file, analyzers] of fileAnalyzers) {
    const count = analyzers.size;
    amplifiers.set(file, count >= 4 ? 1.5 : count >= 3 ? 1.3 : 1.0);
  }
  return amplifiers;
}

/**
 * Scoring philosophy: the score should HURT when there are real issues.
 *
 * Formula per category (0-20):
 *   1. Sum weighted severity of all findings (error=3, warning=1.5, info=0.5)
 *      × confidence × file importance × correlation amplifier
 *   2. Apply mild project-size adjustment (sqrt scale, not linear divide)
 *   3. Map through exponential decay: score = maxScore × e^(-k × adjustedWeight)
 *      where k is tuned so that ~10 weighted points = ~50% score
 *
 * This means:
 *   - 0 findings → 20/20
 *   - 2-3 warnings → ~17/20
 *   - 5 warnings → ~14/20
 *   - 10 warnings or 3 errors → ~10/20
 *   - 20+ weighted points → <5/20
 */
/**
 * k for the exponential decay: 15 weighted points = 50% score.
 * Exposed at module scope so `estimateScoreAfterFixes` stays in sync.
 */
const K_DECAY = Math.LN2 / 15;

function perFindingRawWeight(
  f: Finding,
  correlationAmplifiers: Map<string, number>,
): number {
  const base = SEVERITY_WEIGHTS[f.severity];
  const confidence = f.confidence ?? 1.0;
  let fileWeight = 1.0;
  let corrWeight = 1.0;
  for (const loc of f.locations) {
    if (loc.file) {
      fileWeight = Math.max(fileWeight, computeFileImportanceWeight(loc.file));
      corrWeight = Math.max(corrWeight, correlationAmplifiers.get(loc.file) ?? 1.0);
    }
  }
  return base * confidence * fileWeight * corrWeight;
}

function computeCategoryScore(
  findings: Finding[],
  maxScore: number,
  totalLines: number,
  applicable: boolean,
  correlationAmplifiers: Map<string, number>,
  mutateImpact: boolean,
): CategoryScore {
  if (!applicable) {
    return { score: 0, maxScore, locked: false, findingCount: 0, applicable: false };
  }

  if (findings.length === 0) {
    return { score: maxScore, maxScore, locked: false, findingCount: 0, applicable: true };
  }

  // First pass: per-finding raw weight, grouped by analyzer.
  // Grouping lets us apply a per-analyzer cap below so one noisy detector
  // (e.g. `complexity` with 80+ findings on a mid-size codebase) can't
  // single-handedly crash its category score past the exponential-decay tail.
  const perFinding: number[] = new Array(findings.length);
  const weightByAnalyzer = new Map<string, number>();
  for (let i = 0; i < findings.length; i++) {
    const w = perFindingRawWeight(findings[i], correlationAmplifiers);
    perFinding[i] = w;
    const id = findings[i].analyzerId;
    weightByAnalyzer.set(id, (weightByAnalyzer.get(id) ?? 0) + w);
  }

  // Per-analyzer cap: any single analyzer can contribute at most
  // `maxScore × 0.6` raw weight to its category. For a 20-point category
  // this is 12 — enough to drop the category to ~35% on its own, but not
  // enough to annihilate it. Previous cap (maxScore / 2) was slightly too
  // forgiving: a dominating analyzer like `complexity` with 80+ findings
  // would leave the category at 50% health even when it clearly warranted
  // a worse grade. 0.6 tightens the forgiveness without returning to the
  // pre-fix collapse behavior.
  const PER_ANALYZER_CAP = maxScore * 0.6;
  let rawWeight = 0;
  const analyzerScaleFactors = new Map<string, number>();
  for (const [id, total] of weightByAnalyzer) {
    const capped = Math.min(total, PER_ANALYZER_CAP);
    rawWeight += capped;
    analyzerScaleFactors.set(id, total > 0 ? capped / total : 1);
  }

  // Project-size adjustment: larger projects tolerate more raw weight.
  // sqrt scale, so a 4K-line project gets 2x tolerance, 20K+ gets 4.5x.
  // Ceiling set to 4.5 — enough to avoid the old clamp-at-3 collapse on
  // large codebases, not so much that "drift is normal at scale" becomes
  // the implicit message.
  const sizeFactor = totalLines > 500 ? Math.sqrt(totalLines / 1000) : 1.0;
  const clampedSizeFactor = Math.max(0.5, Math.min(4.5, sizeFactor));
  const adjustedWeight = rawWeight / clampedSizeFactor;

  // Exponential decay: score = max × e^(-k × weight). k is module-level.
  const factor = Math.exp(-K_DECAY * adjustedWeight);
  const score = Math.round(maxScore * factor * 10) / 10;

  // Second pass: attribute marginal score-gain-if-resolved to each finding.
  // ∂score/∂rawWeight = -maxScore × k × factor / sizeFactor, so the magnitude
  // of score recovery from removing δw of raw weight is:
  //   impact ≈ maxScore × k × factor × δw / sizeFactor
  // This is a first-order linearization — accurate for a single finding,
  // slightly over-estimates for multi-finding removals (sub-additive).
  if (mutateImpact) {
    for (let i = 0; i < findings.length; i++) {
      // Scale each finding's marginal impact by its analyzer's capped share:
      // if an analyzer's total raw weight was capped, its findings had their
      // contribution proportionally reduced, and resolving one of them only
      // recovers the scaled fraction.
      const scale = analyzerScaleFactors.get(findings[i].analyzerId) ?? 1;
      const impact = maxScore * K_DECAY * factor * perFinding[i] * scale / clampedSizeFactor;
      findings[i].consistencyImpact = Math.round(impact * 100) / 100;
    }
  }

  return {
    score: Math.max(0, Math.min(maxScore, score)),
    maxScore,
    locked: false,
    findingCount: findings.length,
    applicable: true,
  };
}

/**
 * Build the per-category score map for a given analyzer kind.
 *
 * The kind gate is applied twice:
 *   (1) When selecting which analyzers are "applicable" for a category
 *       under this kind — a drift-kind computation for `dependencyHealth`
 *       sees zero applicable analyzers and the category is marked
 *       `applicable: false`.
 *   (2) When filtering the input findings — we only score findings whose
 *       `analyzerId` belongs to the selected kind.
 *
 * `mutateImpact` is only honored for the drift track. `consistencyImpact`
 * is a drift-only concept (Fix Plan prioritization targets drift), so the
 * hygiene track is always invoked with `mutateImpact: false`.
 */
function computeScoresForKind(
  findings: Finding[],
  totalLines: number,
  projectLanguages: SupportedLanguage[],
  correlationAmplifiers: Map<string, number>,
  kind: AnalyzerKind,
  mutateImpact: boolean,
  previousScores: CategoryScores | undefined,
  previousScoresApplicable: boolean,
): { scores: CategoryScores; compositeScore: number; maxCompositeScore: number } {
  const findingsByCategory = new Map<ScoringCategory, Finding[]>();
  for (const cat of ALL_CATEGORIES) {
    const applicableIds = getApplicableAnalyzerIds(cat, projectLanguages, kind);
    findingsByCategory.set(
      cat,
      findings.filter(
        (f) => applicableIds.includes(f.analyzerId) && getAnalyzerKind(f.analyzerId) === kind,
      ),
    );
  }

  const categoryScores: Record<string, CategoryScore> = {};

  for (const cat of ALL_CATEGORIES) {
    const config = CATEGORY_CONFIG[cat];
    const applicable = isCategoryApplicable(cat, projectLanguages, kind);
    const catFindings = findingsByCategory.get(cat) ?? [];

    const score = computeCategoryScore(
      catFindings,
      config.maxScore,
      totalLines,
      applicable,
      correlationAmplifiers,
      mutateImpact,
    );

    // Delta is only meaningful when the previous scores were computed under
    // the same SCORING_VERSION. Cross-version deltas are silently skipped; the
    // `previousScoresMismatch` field drives silent suppression downstream and
    // the one-time scoring-refined notice explains the change to the user.
    if (previousScores && previousScoresApplicable) {
      const prev = previousScores[cat];
      if (prev && prev.applicable) {
        score.delta = Math.round((score.score - prev.score) * 10) / 10;
      }
    }

    categoryScores[cat] = score;
  }

  const scores = categoryScores as unknown as CategoryScores;

  let compositeScore = 0;
  let maxCompositeScore = 0;
  for (const cat of ALL_CATEGORIES) {
    const s = scores[cat];
    if (s.applicable) {
      compositeScore += s.score;
      maxCompositeScore += s.maxScore;
    }
  }

  // Drag penalty is drift-identity-specific: architectural and redundancy
  // are the load-bearing drift categories. Hygiene has no equivalent
  // load-bearing notion — every hygiene category is equally "generic
  // codebase hygiene" — so drag only applies to drift.
  if (kind === "drift") {
    const DRAG_CATEGORIES: ScoringCategory[] = ["architecturalConsistency", "redundancy"];
    const DRAG_THRESHOLD = 0.50; // below 50% health triggers drag
    const DRAG_MAX_PENALTY = 0.10; // up to 10% composite penalty per category

    for (const cat of DRAG_CATEGORIES) {
      const s = scores[cat];
      if (!s.applicable || s.maxScore === 0) continue;
      const healthPct = s.score / s.maxScore;
      if (healthPct < DRAG_THRESHOLD) {
        const penaltyFraction = (DRAG_THRESHOLD - healthPct) / DRAG_THRESHOLD;
        const penalty = DRAG_MAX_PENALTY * penaltyFraction * maxCompositeScore;
        compositeScore -= penalty;
      }
    }
  }

  compositeScore = Math.max(0, Math.round(compositeScore * 10) / 10);

  // Normalize the composite to a 0-100 scale for presentation. Internal
  // scoring math uses 4 applicable drift categories × 20 = 80 (or 5 × 20
  // = 100 for hygiene). Users expect "score out of 100" by convention,
  // so we collapse both tracks onto /100 here. Per-category scores stay
  // /20 (the bars under the hero) — only the headline is normalized.
  // Grades read from the percentage anyway (A ≥ 90, B ≥ 75, …) so they
  // come out identical to the pre-normalization values.
  if (maxCompositeScore > 0 && maxCompositeScore !== 100) {
    compositeScore = Math.round((compositeScore / maxCompositeScore) * 1000) / 10;
    maxCompositeScore = 100;
  }

  return { scores, compositeScore, maxCompositeScore };
}

export function computeScores(
  findings: Finding[],
  totalLines: number,
  ctx?: AnalysisContext,
  previousScores?: CategoryScores,
  options: {
    mutateImpact?: boolean;
    previousHygieneScores?: CategoryScores;
    /**
     * SCORING_VERSION of the previous-scan scores being passed in. When
     * this is undefined or does not equal the current SCORING_VERSION,
     * cross-version delta computation is refused (deltas would be in
     * different units). Result envelope's `previousScoresMismatch` field
     * is set to `"scoring-version-mismatch"`, which silently suppresses delta
     * arrows; the one-time scoring-refined notice explains the change.
     */
    previousScoringVersion?: string;
  } = {},
): {
  scores: CategoryScores;
  compositeScore: number;
  maxCompositeScore: number;
  hygieneScores: CategoryScores;
  hygieneScore: number;
  maxHygieneScore: number;
  perFileScores: Map<string, PerFileScore>;
  /** Stable identifier of the scoring math used to produce this result. */
  scoringVersion: string;
  /**
   * Set to `"scoring-version-mismatch"` when `previousScores` was supplied
   * but came from a different `SCORING_VERSION`. In that case no `delta`
   * fields are populated and the renderer should show a "rescore to
   * compare" message rather than a numeric delta. Undefined when no
   * previous scores were passed, or when the versions match.
   */
  previousScoresMismatch?: string;
} {
  const mutateImpact = options.mutateImpact ?? true;
  const previousScoringVersion = options.previousScoringVersion;
  const versionsMatch = previousScoringVersion === SCORING_VERSION;
  const hasPreviousScores = previousScores != null || options.previousHygieneScores != null;
  const previousScoresMismatch = hasPreviousScores && !versionsMatch
    ? "scoring-version-mismatch"
    : undefined;
  const projectLanguages: SupportedLanguage[] = ctx
    ? [...ctx.languageBreakdown.keys()]
    : ["javascript", "typescript"];

  // Correlation amplifier uses the full finding set regardless of kind —
  // if a file has both a drift finding and a hygiene finding, the file is
  // genuinely "hot" and each finding gets a bump. This is a deliberate
  // cross-kind signal: multiple independent flags on the same file is a
  // real correlation whether the flags are drift or hygiene.
  const correlationAmplifiers = computeCorrelationAmplifier(findings);

  // Drift track: populates consistencyImpact on drift findings when
  // mutateImpact is true. Composite is the Vibe Drift Score.
  const drift = computeScoresForKind(
    findings,
    totalLines,
    projectLanguages,
    correlationAmplifiers,
    "drift",
    mutateImpact,
    previousScores,
    versionsMatch,
  );

  // Hygiene track: parallel scoring, never mutates consistencyImpact
  // (Fix Plan prioritizes drift; hygiene has its own pane).
  const hygiene = computeScoresForKind(
    findings,
    totalLines,
    projectLanguages,
    correlationAmplifiers,
    "hygiene",
    false,
    options.previousHygieneScores,
    versionsMatch,
  );

  const perFileScores = computePerFileScores(findings, ctx);

  return {
    scores: drift.scores,
    compositeScore: drift.compositeScore,
    maxCompositeScore: drift.maxCompositeScore,
    hygieneScores: hygiene.scores,
    hygieneScore: hygiene.compositeScore,
    maxHygieneScore: hygiene.maxCompositeScore,
    perFileScores,
    scoringVersion: SCORING_VERSION,
    previousScoresMismatch,
  };
}

/**
 * "What if I fix these?" — recompute the composite score as if the given
 * findings were resolved. Non-linear because the exponential decay is
 * sub-additive: summing per-finding `consistencyImpact` over-estimates the
 * true gain. This helper does a real recompute on the filtered set.
 *
 * Does NOT mutate `consistencyImpact` on any finding (the input set's
 * impact values were computed under the original weight context; recomputing
 * them here would be misleading when displayed alongside "what-if" totals).
 *
 * Drift-track only. Hygiene is not part of the Vibe Drift Score, so the
 * Fix Plan projection does not model hygiene removals.
 */
export function estimateScoreAfterFixes(
  allFindings: Finding[],
  findingsToFix: Iterable<Finding>,
  totalLines: number,
  ctx?: AnalysisContext,
): { compositeScore: number; maxCompositeScore: number; scores: CategoryScores } {
  const fixSet = new Set(findingsToFix);
  const remaining = allFindings.filter((f) => !fixSet.has(f));
  const { compositeScore, maxCompositeScore, scores } = computeScores(
    remaining,
    totalLines,
    ctx,
    undefined,
    { mutateImpact: false },
  );
  return { compositeScore, maxCompositeScore, scores };
}

function computePerFileScores(
  findings: Finding[],
  ctx?: AnalysisContext,
): Map<string, PerFileScore> {
  const perFile = new Map<string, PerFileScore>();
  if (!ctx) return perFile;

  for (const file of ctx.files) {
    perFile.set(file.relativePath, {
      file: file.relativePath,
      findings: [],
      score: 100,
      maxScore: 100,
    });
  }

  for (const finding of findings) {
    // Deduplicate: add each finding to a file only once, even if it has
    // multiple locations pointing to the same file
    const seenFiles = new Set<string>();
    for (const loc of finding.locations) {
      if (!loc.file || seenFiles.has(loc.file)) continue;
      seenFiles.add(loc.file);
      const entry = perFile.get(loc.file);
      if (entry) entry.findings.push(finding);
    }
  }

  for (const [, entry] of perFile) {
    if (entry.findings.length === 0) continue;
    let penalty = 0;
    for (const f of entry.findings) {
      penalty += SEVERITY_WEIGHTS[f.severity] * (f.confidence ?? 1.0);
    }
    // Exponential decay per file too
    const k = Math.LN2 / 5; // 5 weighted points = 50 score
    entry.score = Math.max(0, Math.round(100 * Math.exp(-k * penalty)));
  }

  return perFile;
}
