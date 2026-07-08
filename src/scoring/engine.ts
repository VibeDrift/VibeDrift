import type {
  Finding,
  CategoryScores,
  CategoryScore,
  SupportedLanguage,
  PerFileScore,
  AnalysisContext,
  ScorePercentiles,
} from "../core/types.js";
// Bundled corpus distribution. Imported (not fs-read) so tsup/esbuild inlines
// it into the build. PLACEHOLDER until the corpus build lands: `languages` is
// empty, so `compositeToPercentile` returns null and the renderer shows nothing.
import scorePercentilesArtifact from "../data/score_percentiles.json" with { type: "json" };
import { extractAllFunctions } from "../codedna/function-extractor.js";
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
 *   v4 — decompressed scoring: dominance-ratio magnitude weighting, no per-analyzer cap, no sqrt-LOC dampener, multiplicative/geometric-mean composite; real 0–100 range.
 *   v5 — evidence-weighted clean credit (no-finding categories regress toward the
 *        population prior by LOC); deep-scan dedup-aliasing fix.
 *   v6 — size-fair count-based normalization: structural-similarity / count-based
 *        detectors are normalized by a per-FUNCTION rate (findings ÷ total
 *        functions), not findings ÷ KLOC. Structural similarity scales with
 *        function count, so the old per-KLOC density kept rising with repo size
 *        and unfairly sank large clean repos (e.g. trpc 69.6→81.6, TanStack
 *        62.1→76.4) into the messy range. The rate is size-invariant.
 *   v7 — concentrated reimplementation feeds the composite: panel-confirmed
 *        redundant reimplementation now lowers the score when it is dense (>= a
 *        per-KLOC threshold and a minimum count), re-tagged to a drift-kind
 *        analyzer in computeScores. Sparse reimplementation stays informational.
 *        Deep-scan scores move for repos with concentrated reimplementation;
 *        local / free scores are unchanged.
 *
 * A change here is absorbed silently for users: stored scores are re-aligned
 * where possible and a one-time release-notes notice is shown (see
 * src/core/scoring-notice.ts). Users never see this string.
 */
export const SCORING_VERSION = "v9";

/** The bundled corpus distribution, typed. Placeholder until the corpus build lands. */
export const scorePercentiles = scorePercentilesArtifact as ScorePercentiles;

/**
 * Reimplementation concentration gate (calibrated 2026-06-27 on the 425-repo
 * corpus deep-scan run). Panel-confirmed reimplementation findings feed the
 * Vibe Drift Score ONLY when CONCENTRATED: at least REIMPL_CONCENTRATION_MIN_COUNT
 * findings AND at least REIMPL_CONCENTRATION_DENSITY_MIN per KLOC.
 *
 * Why concentration, not count: across 425 repos, raw reimplementation COUNT did
 * NOT separate elite from messy/AI-generated repos — large elite repos carry a
 * sparse-but-common reimplementation baseline (legacy files, parallel platform
 * impls). DENSITY did: 0 of 249 elite repos reach 1 finding/KLOC, while the
 * concentrated AI-sprawl repos clear it. The gate is deliberately conservative
 * (high precision on "clean"): no elite repo in the calibration set crosses it,
 * so it never penalizes well-structured code. Global threshold for now;
 * per-language refinement waits for a larger dense-tail sample.
 */
export const REIMPL_CONCENTRATION_DENSITY_MIN = 1.0; // panel-confirmed findings per KLOC
export const REIMPL_CONCENTRATION_MIN_COUNT = 3;
const REIMPL_HYGIENE_ID = "ml-reimplementation";
const REIMPL_DRIFT_ID = "ml-reimplementation-concentrated";

/**
 * Re-tag panel-confirmed reimplementation findings to the drift-kind analyzer id
 * when, and only when, they are concentrated (see the gate constants above). When
 * the gate does not fire the findings keep their hygiene id and stay informational.
 * Pure; returns the same array reference when nothing is re-tagged.
 */
export function applyReimplementationConcentrationGate(
  findings: Finding[],
  totalLines: number,
): Finding[] {
  const reimplCount = findings.reduce(
    (n, f) => (f.analyzerId === REIMPL_HYGIENE_ID ? n + 1 : n),
    0,
  );
  if (reimplCount < REIMPL_CONCENTRATION_MIN_COUNT) return findings;
  const kloc = totalLines / 1000;
  if (kloc <= 0) return findings;
  if (reimplCount / kloc < REIMPL_CONCENTRATION_DENSITY_MIN) return findings;
  return findings.map((f) =>
    f.analyzerId === REIMPL_HYGIENE_ID ? { ...f, analyzerId: REIMPL_DRIFT_ID } : f,
  );
}

/**
 * Route-consistency security findings need a minimum peer sample before they
 * move the composite. Below MIN_SECURITY_PEERS relevant routes a single
 * deviator is too large a fraction of too small a sample to trust — the
 * uniform-auth-gap baseline can fire on as few as 2 mutating routes. Such thin
 * findings are re-tagged to a hygiene id so they still RENDER (informational)
 * but never dent the Vibe Drift Score. Findings at or above the floor keep the
 * drift id and score, ramped by groupSampleConfidence up to
 * SAMPLE_FULL_CONFIDENCE (8). Route-independent taint findings (codedna-taint)
 * are unaffected. Pure; returns the same array reference when nothing re-tags.
 */
export const MIN_SECURITY_PEERS = 4;
const SECURITY_DRIFT_ID = "drift-security_posture";
const SECURITY_ADVISORY_ID = "security_posture-advisory";

export function applySecurityMinPeerFloor(findings: Finding[]): Finding[] {
  let changed = false;
  const out = findings.map((f) => {
    if (f.analyzerId !== SECURITY_DRIFT_ID) return f;
    const n = f.driftSignal?.totalRelevantFiles ?? 0;
    if (n >= MIN_SECURITY_PEERS) return f;
    changed = true;
    return { ...f, analyzerId: SECURITY_ADVISORY_ID };
  });
  return changed ? out : findings;
}

// The route-consistency drift finding's `driftCategory`: SECURITY_DRIFT_ID
// (the `Finding.analyzerId`) without the "drift-" prefix. The raw
// `DriftFindingReport` array keeps this category tag but has no `analyzerId`,
// so renderers that read `driftFindings` directly test the floor on this
// instead of on the demoted analyzer id.
const SECURITY_DRIFT_CATEGORY = "security_posture";

/**
 * DriftFinding-report view of the same min-peer floor `applySecurityMinPeerFloor`
 * applies to `Finding`s. Output renderers (HTML, CSV, DOCX) read the raw
 * `result.driftFindings` (`DriftFindingReport[]`), which has no `analyzerId`,
 * so the Finding-level floor never touches it. They use this predicate to
 * exclude below-floor route-consistency security findings from every surface
 * that lists a drift finding, keeping those exports from contradicting the
 * category's N/A. Single source of truth for the below-floor test so the three
 * renderers cannot drift apart from each other or from applySecurityMinPeerFloor.
 */
export function isBelowSecurityPeerFloor(d: {
  driftCategory: string;
  totalRelevantFiles: number;
}): boolean {
  return d.driftCategory === SECURITY_DRIFT_CATEGORY && d.totalRelevantFiles < MIN_SECURITY_PEERS;
}

/**
 * Place a composite Vibe Drift Score on a peer percentile against a bundled
 * corpus of real-world repos in the same language. Pure, local, deterministic,
 * and FREE — only surfacing the result is Pro-gated (see `isPeerGroundedEntitled`).
 *
 * The percentile is the empirical CDF of the language's `scores` array:
 *   percentile = (count of corpus scores <= compositeScore) / n * 100
 * found via binary search (scores are sorted ascending). Higher composite ⇒
 * higher percentile ("lower drift than X% of comparable repos"). Rounded to one
 * decimal.
 *
 * Returns `null` when the corpus has no usable data for the language — i.e. the
 * distribution is undefined, the language is absent, or its cohort is empty.
 * This is the placeholder case: with the shipped empty artifact, every lookup
 * returns `null` and the renderer shows nothing.
 *
 * @param compositeScore the repo's composite Vibe Drift Score (0–100)
 * @param language       the repo's dominant language (corpus cohort key)
 * @param dist           the corpus distribution (defaults to the bundled artifact)
 */
export function compositeToPercentile(
  compositeScore: number,
  language: string,
  dist: ScorePercentiles | undefined = scorePercentiles,
): number | null {
  if (!dist) return null;
  const cohort = dist.languages?.[language];
  if (!cohort || cohort.n <= 0) return null;
  const scores = cohort.scores;
  if (!scores || scores.length === 0) return null;

  // Binary search for the count of scores <= compositeScore (upper bound).
  // `scores` is sorted ascending; `lo` ends as the count of values <= target.
  let lo = 0;
  let hi = scores.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (scores[mid] <= compositeScore) lo = mid + 1;
    else hi = mid;
  }
  const countAtOrBelow = lo;

  const pct = (countAtOrBelow / cohort.n) * 100;
  // Clamp defensively (n should equal scores.length, but never report >100).
  const clamped = Math.max(0, Math.min(100, pct));
  return Math.round(clamped * 10) / 10;
}

/**
 * Decompressed scoring (v4) constants — detector-level damage model.
 *
 * Category health is a noisy-OR over the DETECTORS that fired (not a sum over
 * findings), so a category's score reflects HOW MANY distinct patterns drift
 * and HOW BADLY, never the raw finding count (which scales with codebase size).
 */
/** Damage ceiling a detector contributes at full severity, before deviation. */
const SEVERITY_DAMAGE = { error: 0.7, warning: 0.4, info: 0.12 };
/** A single detector can never remove more than this share of a category. */
const MAX_DETECTOR_DAMAGE = 0.85;
/** Findings-per-KLOC at which a count-based detector reaches ~63% of its deviation ceiling. */
const COUNT_DENSITY_SCALE = 2.0;
/**
 * Size-fair normalization for count-based detectors: the deviating-FUNCTION rate
 * (findings / total functions) at which a detector reaches ~63% of its deviation
 * ceiling. Structural-similarity detectors (codedna) scale with function count,
 * not lines — a raw count/KLOC keeps rising with repo size and unfairly sinks
 * large clean repos. Using the per-function RATE makes the magnitude size-invariant
 * (a 95%-consistent repo scores 95 at 5k or 5M lines). Used when the function count
 * is known; falls back to COUNT_DENSITY_SCALE per-KLOC otherwise.
 */
const COUNT_RATE_SCALE = 0.5;
/**
 * Duplicated-function FRACTION (redundant copies ÷ total functions) at which a
 * grouped-duplicate detector reaches ~63% of its deviation ceiling. Grouped
 * duplicate findings carry `dupGroupSize`, so 32 identical functions register as
 * ~31 redundant copies regardless of how the detector chunked them into findings.
 * This is the volume-sensitive, size-fair duplication magnitude.
 */
const DUP_FRACTION_SCALE = 0.15;
/** A flagged-but-near-consistent dominance finding still registers this faintly. */
const DEVIATION_FLOOR = 0.05;
/**
 * Dominance-vote sample size at which a finding earns full damage weight. Below
 * it, damage is scaled down: a 70% majority over 4 files is weaker statistical
 * evidence of drift than the same share over 40. n-awareness lives here (as a
 * damage weight) rather than as a vote-level cutoff, so it can't fight temporal
 * weighting or explicit threshold overrides. Count-based detectors carry no
 * dominance sample and are unaffected.
 */
const SAMPLE_FULL_CONFIDENCE = 8;
/** Keeps one fully-collapsed category from hard-zeroing the geometric-mean composite. */
const HEALTH_FLOOR = 0.02;

/**
 * Evidence-weighted credit for a category with NO findings. "No drift found" is
 * only strong evidence of cleanliness when there was enough code to find drift
 * in: 50 lines with zero findings says little; 8k lines with zero says a lot.
 * Without this weighting, every category in a tiny repo returns maxScore and the
 * composite floats to ~100 purely because the repo is SMALL — a size confound,
 * not a quality signal (measured: <20-function repos median 100, >500 median 82).
 * A no-finding category earns NO_FINDING_PRIOR of maxScore at zero evidence and
 * rises toward full credit as LOC saturates EVIDENCE_SCALE_LINES, so a tiny clean
 * repo lands near the population mean ("we can't confirm clean") instead of a
 * free perfect score.
 */
// Prior = the elite-corpus mean health (~0.80): a no-finding repo with thin
// evidence regresses toward the POPULATION MEAN ("typical"), not below it, so a
// small clean repo lands near the average rather than either a free 100 (the
// old bug) or an over-corrected penalty beneath larger repos. Refined against
// the full corpus in Wave 2 Step 4.
const NO_FINDING_PRIOR = 0.8;
const EVIDENCE_SCALE_LINES = 2500;

/**
 * Surface-specific drift categories: they only have analyzable input when the
 * repo exercises that surface (security routes/auth; comment/intent signal).
 * With zero findings we cannot distinguish "clean" from "no surface", so on the
 * drift track an empty one is treated as NOT-MEASURED (excluded from the
 * composite) rather than credited a free 20/20 that would mask drift in the
 * categories we did measure. architecturalConsistency and redundancy always
 * have input from code, so they stay measured-clean (20) when empty.
 * (True surface coverage detection per detector is a future refinement.)
 */
const SURFACE_SPECIFIC_DRIFT_CATEGORIES = new Set<ScoringCategory>([
  "securityPosture",
  "intentClarity",
]);

const ENTRY_POINT_PATTERNS = [
  /index\.[jt]sx?$/, /main\.[jt]s$/, /app\.[jt]sx?$/, /server\.[jt]s$/,
  /main\.go$/, /main\.py$/, /lib\.rs$/, /mod\.rs$/,
  /\.config\.[jt]s$/, /\.env/,
];

function isEntryPoint(filePath: string): boolean {
  return ENTRY_POINT_PATTERNS.some((p) => p.test(filePath));
}

// The score measures drift in the code a project SHIPS. Drift in code that is
// not shipped — machine-generated output, demo/example code, test scaffolding —
// is weighted down (or out) so a clean library is not dragged below a messy app
// by duplication in its examples/ or *.gen.ts files. Calibration (2026-06-24)
// found ~82% of trpc's REAL duplicate groups live in examples/tests/generated,
// not in packages/src — this is the honest lever for that, NOT distrusting the
// (98.7%-precise) duplicate detector. We still ANALYZE and REPORT these files;
// we only weight their drift differently in the composite.
const GENERATED_PATH_RE =
  /(^|\/)(generated|__generated__)\/|\.(generated|gen)\.[A-Za-z0-9]+$|\.pb\.go$|_pb2?\.py$|\.min\.[A-Za-z0-9]+$/;
const FIXTURE_PATH_RE = /(^|\/)(fixtures?|__fixtures__|__mocks__|mocks|snapshots|__snapshots__)\//;
const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[A-Za-z0-9]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const EXAMPLE_PATH_RE = /(^|\/)(examples?|demos?|samples?)\//;

// Not human-authored / not test-relevant code: effectively excluded from the score.
const WEIGHT_NOT_SHIPPED = 0.05;
// Real authored code, but not the shipped product — drift here counts, but less.
const WEIGHT_TEST = 0.35;
const WEIGHT_EXAMPLE = 0.35;

function computeFileImportanceWeight(filePath: string): number {
  if (GENERATED_PATH_RE.test(filePath) || FIXTURE_PATH_RE.test(filePath)) return WEIGHT_NOT_SHIPPED;
  if (TEST_PATH_RE.test(filePath)) return WEIGHT_TEST;
  if (EXAMPLE_PATH_RE.test(filePath)) return WEIGHT_EXAMPLE;
  if (isEntryPoint(filePath)) return 1.5;
  return 1.0;
}

/** Max file-importance over a single finding's locations (default 1.0, no locs). */
function findingMaxWeight(f: Finding): number {
  let w: number | null = null;
  for (const loc of f.locations) {
    if (loc.file) w = w === null ? computeFileImportanceWeight(loc.file) : Math.max(w, computeFileImportanceWeight(loc.file));
  }
  return w ?? 1.0;
}

/**
 * Decompressed scoring (v4) — per-category health via a detector-level
 * noisy-OR. The score has a real 0–100 range and drops sharply on drifting
 * code, but does NOT scale with raw finding count (which scales with codebase
 * size). Findings are grouped by detector; each detector contributes ONE
 * bounded `damage` term; health is the product of `(1 - damage)`:
 *
 *   damage_d = min(MAX_DETECTOR_DAMAGE, severity_d × confidence_d × importance_d × deviation_d)
 *   health   = Π_d (1 - damage_d)          score = maxScore × health
 *
 * where, per detector d (over the findings it produced in this category):
 *   - severity_d   = SEVERITY_DAMAGE[worst severity in the group]
 *   - confidence_d = mean confidence in the group
 *   - importance_d = max file-importance over the group (entry points weigh more)
 *   - deviation_d  = dominance detectors (driftSignal): worst deviation fraction
 *                    (1 - consistencyScore/100) across the group, floored at
 *                    DEVIATION_FLOOR — a RATE, already size-normalized.
 *                  = count-based detectors (codedna / ml / hygiene): a saturating
 *                    density 1 - e^(-(count/KLOC)/COUNT_DENSITY_SCALE), so a
 *                    high-volume detector scales with codebase size, never the
 *                    raw count, and alone can never exceed MAX_DETECTOR_DAMAGE.
 *
 * No per-analyzer cap, no sqrt-LOC dampener, no count-sensitivity: 30 modest
 * findings from one detector damage a category exactly as much as that
 * detector's worst single deviation warrants.
 */

/** Worst (max) severity damage across a detector group's findings. */
function groupSeverityDamage(findings: Finding[]): number {
  let worst = 0;
  for (const f of findings) worst = Math.max(worst, SEVERITY_DAMAGE[f.severity]);
  return worst;
}

/** Mean confidence across a detector group's findings (default 1.0). */
function groupConfidence(findings: Finding[]): number {
  if (findings.length === 0) return 1.0;
  let sum = 0;
  for (const f of findings) sum += f.confidence ?? 1.0;
  return sum / findings.length;
}

/**
 * Max file-importance across a detector group's findings' locations. Default 1.0
 * only when the group has NO file locations — otherwise it is the true max over
 * the group's files, so a detector that fires ONLY in de-weighted code (tests,
 * examples, generated) is itself de-weighted. (Not floored at 1.0: that floor
 * would make down-weighting a no-op.)
 */
function groupImportance(findings: Finding[]): number {
  let imp: number | null = null;
  for (const f of findings) {
    for (const loc of f.locations) {
      if (loc.file) {
        const w = computeFileImportanceWeight(loc.file);
        imp = imp === null ? w : Math.max(imp, w);
      }
    }
  }
  return imp ?? 1.0;
}

/**
 * Representative deviation for a detector group:
 *  - dominance (every finding carries driftSignal): the worst deviation
 *    fraction in the group (already a size-normalized rate), floored.
 *  - count-based: a saturating density of finding count per KLOC, so volume
 *    scales with codebase size rather than raw count.
 */
function groupDeviation(
  findings: Finding[],
  useDriftMagnitude: boolean,
  klocCount: number,
  functionCount: number,
): number {
  const isDominance = useDriftMagnitude && findings.every((f) => f.driftSignal);
  if (isDominance) {
    let worst = 0;
    for (const f of findings) {
      worst = Math.max(worst, 1 - (f.driftSignal!.consistencyScore ?? 100) / 100);
    }
    // A genuinely-consistent finding (consistencyScore 100 → deviation 0) is NOT
    // drift and must contribute zero damage — do not floor it. The DEVIATION_FLOOR
    // only applies once there is some real deviation to register faintly.
    if (worst <= 0) return 0;
    return Math.max(DEVIATION_FLOOR, Math.min(1, worst));
  }
  // Grouped exact/near-duplicate detectors carry `dupGroupSize`: score by the
  // DUPLICATED-FUNCTION FRACTION (Σ redundant copies ÷ total functions), which is
  // size-fair AND volume-sensitive — 32 identical functions register as ~31
  // redundant copies no matter how they were chunked into findings.
  if (functionCount > 0 && findings.some((f) => (f.dupGroupSize ?? 0) > 1)) {
    // Each duplicate group's redundant copies are weighted by WHERE the group
    // lives (findingMaxWeight): duplication in shipped src counts full, in
    // examples/tests less, in generated code ~0. Importance is therefore baked
    // in PER-GROUP here (the detector-level groupImportance MAX would otherwise
    // let one src dup pull the whole detector to full weight). detectorDamage
    // skips groupImportance for dup detectors so this is not double-counted.
    let redundant = 0;
    for (const f of findings) {
      if ((f.dupGroupSize ?? 0) > 1) redundant += (f.dupGroupSize! - 1) * findingMaxWeight(f);
    }
    const dupFraction = redundant / functionCount;
    return 1 - Math.exp(-dupFraction / DUP_FRACTION_SCALE);
  }
  // Other count-based detectors (codedna structural similarity, ml, hygiene) scale
  // with FUNCTION COUNT, not lines. Normalize as a size-fair per-function rate when
  // the function count is known so structural similarity that grows with scale
  // doesn't sink large clean repos; fall back to per-KLOC density when it isn't.
  if (functionCount > 0) {
    const rate = findings.length / functionCount;
    return 1 - Math.exp(-rate / COUNT_RATE_SCALE);
  }
  const density = findings.length / klocCount;
  return 1 - Math.exp(-density / COUNT_DENSITY_SCALE);
}

/**
 * Sample-size confidence for a dominance group: full weight once the dominance
 * vote saw at least SAMPLE_FULL_CONFIDENCE relevant files, scaled down below
 * that. Count-based findings carry no dominance sample (no driftSignal), so
 * they return a neutral 1.0 and are unaffected.
 */
function groupSampleConfidence(findings: Finding[]): number {
  let maxN = 0;
  for (const f of findings) {
    if (f.driftSignal) maxN = Math.max(maxN, f.driftSignal.totalRelevantFiles);
  }
  if (maxN <= 0) return 1;
  return Math.min(1, maxN / SAMPLE_FULL_CONFIDENCE);
}

/** Bounded per-detector damage term for the category noisy-OR. */
function detectorDamage(
  findings: Finding[],
  useDriftMagnitude: boolean,
  klocCount: number,
  functionCount: number,
): number {
  // Dup detectors bake per-group file-importance into their deviation
  // (findingMaxWeight); applying groupImportance again would double-count, so use
  // a neutral 1.0 for them. All other detectors weight at the detector level.
  const isDupDetector = findings.some((f) => (f.dupGroupSize ?? 0) > 1);
  const importance = isDupDetector ? 1.0 : groupImportance(findings);
  const damage =
    groupSeverityDamage(findings) *
    groupConfidence(findings) *
    importance *
    groupDeviation(findings, useDriftMagnitude, klocCount, functionCount) *
    groupSampleConfidence(findings);
  return Math.min(MAX_DETECTOR_DAMAGE, Math.max(0, damage));
}

/**
 * Category health as the noisy-OR over the detectors that fired:
 * `health = Π_d (1 - damage_d)`, on a 0–1 scale. Grouping by detector means
 * a category's score depends on how many distinct patterns drift and how
 * badly — not on the raw number of findings (which scales with codebase size).
 */
export function categoryHealth(
  findings: Finding[],
  useDriftMagnitude: boolean,
  klocCount: number,
  functionCount = 0,
): number {
  const byDetector = new Map<string, Finding[]>();
  for (const f of findings) {
    const g = byDetector.get(f.analyzerId);
    if (g) g.push(f);
    else byDetector.set(f.analyzerId, [f]);
  }
  let survival = 1;
  for (const [, group] of byDetector) {
    survival *= 1 - detectorDamage(group, useDriftMagnitude, klocCount, functionCount);
  }
  return Math.max(0, Math.min(1, survival));
}

function computeCategoryScore(
  findings: Finding[],
  maxScore: number,
  totalLines: number,
  applicable: boolean,
  mutateImpact: boolean,
  useDriftMagnitude: boolean,
  treatEmptyAsNotMeasured: boolean,
  functionCount: number,
): CategoryScore {
  if (!applicable) {
    return { score: 0, maxScore, locked: false, findingCount: 0, applicable: false };
  }

  if (findings.length === 0) {
    // A surface-specific category with no findings is "not measured" (no
    // evidence of the surface), not "perfectly clean" — exclude it from the
    // composite rather than crediting a free maxScore.
    if (treatEmptyAsNotMeasured) {
      return { score: 0, maxScore, locked: false, findingCount: 0, applicable: false };
    }
    // Evidence-weighted clean credit (see NO_FINDING_PRIOR): "no drift found"
    // regresses toward the population prior when there was little code to find
    // drift in, so a tiny repo no longer earns a free maxScore it lacked the
    // evidence to justify. Large clean repos (high LOC) still earn ~maxScore.
    const evidence = 1 - Math.exp(-Math.max(0, totalLines) / EVIDENCE_SCALE_LINES);
    const frac = NO_FINDING_PRIOR + (1 - NO_FINDING_PRIOR) * evidence;
    const score = Math.round(maxScore * frac * 10) / 10;
    return { score, maxScore, locked: false, findingCount: 0, applicable: true };
  }

  const klocCount = Math.max(1, totalLines / 1000);
  const health = categoryHealth(findings, useDriftMagnitude, klocCount, functionCount);
  const score = Math.round(maxScore * health * 10) / 10;

  // Marginal consistencyImpact: the score gain from removing finding i alone.
  // Exact — recompute the category SCORE with that finding removed and diff.
  // O(n²) per category, but findings-per-category is small.
  //
  // Removing the LAST finding does NOT restore the full maxScore: an emptied
  // category routes through the evidence-weighted clean-credit path (it earns
  // NO_FINDING_PRIOR..1 of maxScore by LOC, not a free 1.0). The marginal impact
  // must use that same empty-category score, otherwise per-finding impacts
  // over-state the achievable gain and become inconsistent with the cumulative
  // Fix-Plan projection (which is a real recompute through this same path).
  if (mutateImpact) {
    const evidence = 1 - Math.exp(-Math.max(0, totalLines) / EVIDENCE_SCALE_LINES);
    const emptyFrac = NO_FINDING_PRIOR + (1 - NO_FINDING_PRIOR) * evidence;
    for (let i = 0; i < findings.length; i++) {
      const without = findings.slice(0, i).concat(findings.slice(i + 1));
      const fracWithout =
        without.length === 0
          ? emptyFrac
          : categoryHealth(without, useDriftMagnitude, klocCount, functionCount);
      const impact = maxScore * (fracWithout - health);
      findings[i].consistencyImpact = Math.round(Math.max(0, impact) * 100) / 100;
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
  kind: AnalyzerKind,
  mutateImpact: boolean,
  previousScores: CategoryScores | undefined,
  previousScoresApplicable: boolean,
  functionCount: number,
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
      mutateImpact,
      kind === "drift",
      kind === "drift" && SURFACE_SPECIFIC_DRIFT_CATEGORIES.has(cat),
      functionCount,
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

  // Composite is the GEOMETRIC MEAN of per-category health (score/maxScore)
  // over applicable categories, scaled to /100. Multiplicative (not additive)
  // so one fully-collapsed category drags the headline down hard — there is no
  // additive floor near 75 anymore. Each category's health is floored at
  // HEALTH_FLOOR so a single zero category can't hard-zero the whole composite
  // (it still collapses it, but the other categories remain legible).
  //
  // Computed via logs for numerical stability:
  //   composite = 100 × exp( (Σ ln(max(HEALTH_FLOOR, health))) / appCount )
  let logSum = 0;
  let appCount = 0;
  for (const cat of ALL_CATEGORIES) {
    const s = scores[cat];
    if (!s.applicable) continue;
    appCount++;
    const health = s.maxScore > 0 ? s.score / s.maxScore : 0;
    const clamped = Math.max(0, Math.min(1, health));
    logSum += Math.log(Math.max(HEALTH_FLOOR, clamped));
  }

  let compositeScore: number;
  if (appCount === 0) {
    compositeScore = 100;
  } else {
    compositeScore = 100 * Math.exp(logSum / appCount);
  }
  compositeScore = Math.max(0, Math.min(100, Math.round(compositeScore * 10) / 10));

  // Composite is always on a /100 scale (geometric mean of healths × 100).
  const maxCompositeScore = 100;

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
  /**
   * Peer percentile of `compositeScore` against the bundled corpus for the
   * repo's dominant language. `null` when there is no dominant language or no
   * corpus data for it (the current placeholder-artifact case). Pure/local/free;
   * the Pro gate is applied at render time, not here.
   */
  percentile: number | null;
  /** Dominant language used for the percentile lookup, if any. */
  peerLanguage?: string;
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
  // Panel-confirmed reimplementation feeds the composite only when concentrated
  // (see applyReimplementationConcentrationGate). Sparse reimplementation keeps
  // its hygiene id and stays informational. Applied here so the gate sees the
  // full finding set together with totalLines.
  findings = applyReimplementationConcentrationGate(findings, totalLines);

  // Route-consistency findings with too few peer routes to trust are demoted to
  // an advisory hygiene id here (see applySecurityMinPeerFloor) so they render
  // but do not move the composite. Applied after the reimplementation gate so
  // both re-tags see the full finding set.
  findings = applySecurityMinPeerFloor(findings);

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

  // Total function count drives size-fair normalization of count-based detectors
  // (structural-similarity findings scale with functions, not lines). Reuse a
  // pre-computed ctx.functionCount when the pipeline supplied one; otherwise
  // derive it once here. 0 → engine falls back to per-KLOC density.
  const functionCount = ctx
    ? (ctx.functionCount ?? extractAllFunctions(ctx.files).length)
    : 0;

  // Drift track: populates consistencyImpact on drift findings when
  // mutateImpact is true. Composite is the Vibe Drift Score.
  const drift = computeScoresForKind(
    findings,
    totalLines,
    projectLanguages,
    "drift",
    mutateImpact,
    previousScores,
    versionsMatch,
    functionCount,
  );

  // Hygiene track: parallel scoring, never mutates consistencyImpact
  // (Fix Plan prioritizes drift; hygiene has its own pane).
  const hygiene = computeScoresForKind(
    findings,
    totalLines,
    projectLanguages,
    "hygiene",
    false,
    options.previousHygieneScores,
    versionsMatch,
    functionCount,
  );

  const perFileScores = computePerFileScores(findings, ctx);

  // Peer percentile — pure/local/free ECDF lookup against the bundled corpus.
  // Keyed on the repo's dominant language; null when there's no dominant
  // language or no corpus cohort for it (the current placeholder artifact).
  const peerLanguage = ctx?.dominantLanguage ?? undefined;
  const percentile = peerLanguage
    ? compositeToPercentile(drift.compositeScore, peerLanguage)
    : null;

  return {
    scores: drift.scores,
    compositeScore: drift.compositeScore,
    maxCompositeScore: drift.maxCompositeScore,
    hygieneScores: hygiene.scores,
    hygieneScore: hygiene.compositeScore,
    maxHygieneScore: hygiene.maxCompositeScore,
    perFileScores,
    percentile,
    peerLanguage,
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
 *
 * Returns BOTH the projected composite and `consistencyGain` — the cumulative
 * gain in the SAME consistency-point unit as each finding's `consistencyImpact`
 * (the sum of per-category point gains). These are different scales:
 *   - `compositeScore` is the geometric mean of category healths × 100, so its
 *     delta is amplified when drift spans several categories and is NOT directly
 *     comparable to the per-item impacts (it can come out larger than their sum).
 *   - `consistencyGain` is summed per-category category-point gains, the natural
 *     cumulative analog of `consistencyImpact`. It is provably in
 *     `[max(individual), Σ individual]`: within a category the noisy-OR is
 *     sub-additive (removing all together gains ≤ summing each removal), and
 *     across categories the gains add independently. The Fix Plan displays this
 *     value for "if all N close: +Npts consistency", so the number and the
 *     "sub-additive" wording stay internally consistent.
 */
export function estimateScoreAfterFixes(
  allFindings: Finding[],
  findingsToFix: Iterable<Finding>,
  totalLines: number,
  ctx?: AnalysisContext,
): {
  compositeScore: number;
  maxCompositeScore: number;
  scores: CategoryScores;
  /**
   * Cumulative projected consistency-point gain from removing the fix set,
   * summed across categories in the same unit as `Finding.consistencyImpact`.
   * Always in `[max(individual impact), Σ(individual impacts)]` — genuinely
   * sub-additive and monotonic. Use THIS (not the composite delta) when
   * displaying a "+Npts consistency" total alongside per-item impacts.
   */
  consistencyGain: number;
} {
  const fixSet = new Set(findingsToFix);
  const remaining = allFindings.filter((f) => !fixSet.has(f));

  // Baseline category scores over the full finding set (drift track), so the
  // per-category point gain is measured against the same context the per-finding
  // consistencyImpact values were computed in.
  const before = computeScores(allFindings, totalLines, ctx, undefined, {
    mutateImpact: false,
  });
  const { compositeScore, maxCompositeScore, scores } = computeScores(
    remaining,
    totalLines,
    ctx,
    undefined,
    { mutateImpact: false },
  );

  // Cumulative gain in consistency-point units: Σ over categories of the
  // (non-negative) category-score gain. A category that was not measured (or
  // becomes not-measured) contributes nothing. This is the cumulative analog of
  // consistencyImpact and stays within [max(individual), Σ(individual)].
  let consistencyGain = 0;
  for (const cat of ALL_CATEGORIES) {
    const b = before.scores[cat];
    const a = scores[cat];
    if (!b?.applicable || !a?.applicable) continue;
    const gain = a.score - b.score;
    if (gain > 0) consistencyGain += gain;
  }
  consistencyGain = Math.round(consistencyGain * 100) / 100;

  return { compositeScore, maxCompositeScore, scores, consistencyGain };
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
    // Per-file score uses the same detector-level noisy-OR as the category
    // score, scoped to this file's findings: health = Π over detectors of
    // (1 - damage). The file appears in each detector's findings, so it IS the
    // deviator on that axis — its per-detector deviation is full (1.0), bounded
    // by MAX_DETECTOR_DAMAGE so one finding can't zero the file. This keeps
    // per-file scores on the same 0-100 scale and meaning as the headline.
    const byDetector = new Map<string, Finding[]>();
    for (const f of entry.findings) {
      const g = byDetector.get(f.analyzerId);
      if (g) g.push(f);
      else byDetector.set(f.analyzerId, [f]);
    }
    let survival = 1;
    for (const [, group] of byDetector) {
      const damage = Math.min(
        MAX_DETECTOR_DAMAGE,
        groupSeverityDamage(group) * groupConfidence(group) * groupImportance(group),
      );
      survival *= 1 - damage;
    }
    entry.score = Math.max(0, Math.round(100 * survival));
  }

  return perFile;
}
