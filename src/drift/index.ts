import type { AnalysisContext, Finding } from "../core/types.js";
import type { DriftContext, DriftFinding, DriftDetector, DriftCategory } from "./types.js";
import { DRIFT_WEIGHTS } from "./types.js";
import { categoryHealth, isBelowSecurityPeerFloor } from "../scoring/engine.js";
import { architecturalContradiction } from "./architectural-contradiction.js";
import { conventionOscillation } from "./convention-oscillation.js";
import { securityConsistency } from "./security-consistency.js";
import { semanticDuplication } from "./semantic-duplication.js";
import { phantomScaffolding } from "./phantom-scaffolding.js";
import { importConsistency } from "./import-consistency.js";
import { exportConsistency } from "./export-consistency.js";
import { asyncConsistency } from "./async-consistency.js";
import { returnShapeConsistency } from "./return-shape-consistency.js";
import { loggingConsistency } from "./logging-consistency.js";
import { commentStyleConsistency } from "./comment-style-consistency.js";
import { stateManagementConsistency } from "./state-management-consistency.js";
import { testStructureConsistency } from "./test-structure-consistency.js";
import { commitArchaeology } from "./commit-archaeology.js";
import { detectPivotsAcrossFindings } from "./pivot-detector.js";

export function createDriftDetectors(): DriftDetector[] {
  return [
    architecturalContradiction,
    conventionOscillation,
    securityConsistency,
    semanticDuplication,
    phantomScaffolding,
    importConsistency,
    exportConsistency,
    asyncConsistency,
    returnShapeConsistency,
    loggingConsistency,
    commentStyleConsistency,
    stateManagementConsistency,
    testStructureConsistency,
    commitArchaeology,
  ];
}

export function buildDriftContext(ctx: AnalysisContext): DriftContext {
  return {
    files: ctx.files.map((f) => ({
      path: f.relativePath,
      language: f.language,
      content: f.content,
      lineCount: f.lineCount,
      git: f.git ?? null,
    })),
    totalLines: ctx.totalLines,
    dominantLanguage: ctx.dominantLanguage,
    hasGitMetadata: ctx.hasGitMetadata ?? false,
    intentHints: ctx.intentHints ?? [],
  };
}

export interface DriftScores {
  architectural_consistency: { score: number; maxScore: number; findings: number };
  security_posture: { score: number; maxScore: number; findings: number };
  semantic_duplication: { score: number; maxScore: number; findings: number };
  naming_conventions: { score: number; maxScore: number; findings: number };
  phantom_scaffolding: { score: number; maxScore: number; findings: number };
  import_style: { score: number; maxScore: number; findings: number };
  export_style: { score: number; maxScore: number; findings: number };
  async_patterns: { score: number; maxScore: number; findings: number };
  return_shape_consistency: { score: number; maxScore: number; findings: number };
  logging_consistency: { score: number; maxScore: number; findings: number };
  comment_style_consistency: { score: number; maxScore: number; findings: number };
  state_management_consistency: { score: number; maxScore: number; findings: number };
  test_structure_consistency: { score: number; maxScore: number; findings: number };
  // NOTE: no `composite`/`grade` here. The single authoritative composite is
  // the scoring engine's `compositeScore` (src/scoring/engine.ts). This object
  // is purely the per-drift-category breakdown used for report bars. (Phase 0
  // dual-engine collapse — the old linear composite was a second formula.)
}

export function runDriftDetection(ctx: AnalysisContext): {
  findings: Finding[];
  driftFindings: DriftFinding[];
  driftScores: DriftScores;
} {
  const driftCtx = buildDriftContext(ctx);
  const detectors = createDriftDetectors();
  const rawDrift: DriftFinding[] = [];

  for (const detector of detectors) {
    const driftFindings = detector.detect(driftCtx);
    rawDrift.push(...driftFindings);
  }

  // Pivot pass: reclassifies findings where a temporal majority shift
  // makes some "drift" files actually legacy migration candidates.
  // Silent no-op when no git metadata is available.
  const pivotEnriched = detectPivotsAcrossFindings(driftCtx, rawDrift);

  // Intent-divergence pass: when a team-declared pattern (from CLAUDE.md
  // etc.) disagrees with the voted dominant for the same category, stamp
  // the finding with provenance so the UI can surface "you declared X,
  // code does Y." Uses the hint collection from AnalysisContext.
  const allDrift = enrichWithIntentDivergence(driftCtx, pivotEnriched);

  // Convert to standard Finding format FIRST, so the per-category report bars
  // are computed from the SAME detector-level health the scoring engine uses
  // (a faithful decomposition of the composite, not a second formula).
  const findings = allDrift.map(driftFindingToFinding);

  // Per-category report bars — the 13-category breakdown for HTML/CSV/DOCX exports.
  const driftScores = computeDriftScores(findings, ctx.totalLines);

  return { findings, driftFindings: allDrift, driftScores };
}

function computeDriftScores(findings: Finding[], totalLines: number): DriftScores {
  const categories: DriftCategory[] = [
    "architectural_consistency",
    "security_posture",
    "semantic_duplication",
    "naming_conventions",
    "phantom_scaffolding",
    "import_style",
    "export_style",
    "async_patterns",
    "return_shape_consistency",
    "logging_consistency",
    "comment_style_consistency",
    "state_management_consistency",
    "test_structure_consistency",
  ];

  const klocCount = Math.max(1, totalLines / 1000);
  const scores: Record<string, { score: number; maxScore: number; findings: number }> = {};

  for (const cat of categories) {
    const weight = DRIFT_WEIGHTS[cat];
    // Each per-category bar is computed with the SAME detector-level noisy-OR
    // health the scoring engine uses for the composite (categoryHealth). A
    // drift category maps to one detector (`drift-<cat>`), so its bar is that
    // detector's health × its display weight — a faithful decomposition of the
    // composite (the 5-bucket health is the product of its detectors' (1-damage),
    // and each bar shows one of those (1-damage) components). No second formula.
    const catFindings = findings.filter((f) => f.analyzerId === `drift-${cat}`);
    const health = categoryHealth(catFindings, true, klocCount);
    scores[cat] = {
      score: Math.round(weight * health * 10) / 10,
      maxScore: weight,
      findings: catFindings.length,
    };
  }

  // The loop populates every DriftCategory key, so the cast is safe.
  return scores as unknown as DriftScores;
}

/**
 * The DRIFT representation that RENDERING should read: the raw drift findings
 * minus the below-floor route-consistency security findings, plus the
 * per-category `driftScores` breakdown recomputed from that same scored set.
 *
 * A route-consistency security finding whose peer sample is below
 * MIN_SECURITY_PEERS is demoted to an advisory hygiene finding on the `Finding`
 * track (see `applySecurityMinPeerFloor`), so the category scores N/A. Every
 * consumer that reads the raw `driftFindings` (the findings library, codebase
 * intent, the coherence heatmap, pattern consensus, CSV/DOCX drift sections,
 * context.md, the deep-scan coherence input) must therefore NOT see it, or it
 * would contradict that N/A. Excluding it here, at ONE source point, keeps them
 * all consistent without a gate in each widget. Recomputing `driftScores` from
 * the scored set (rather than filtering the raw breakdown) is what makes
 * `driftScores.security_posture` match the listed drift findings even in the
 * multi-sub-check case (e.g. auth voted over 5 mutating routes stays scored
 * while validation voted over 2 is below floor).
 *
 * The finding still surfaces as advisory via `result.findings` (hygiene-kind),
 * so a small insecure repo is never silent. The RAW `driftFindings` produced by
 * `runDriftDetection` are intentionally left untouched for the baseline
 * (`assembleBaseline`) and the scan-over-scan diff, which track the raw drift
 * representation for continuity.
 */
export function scoredDriftView(
  driftFindings: DriftFinding[],
  totalLines: number,
): { driftFindings: DriftFinding[]; driftScores: DriftScores } {
  const scored = driftFindings.filter((d) => !isBelowSecurityPeerFloor(d));
  const driftScores = computeDriftScores(scored.map(driftFindingToFinding), totalLines);
  return { driftFindings: scored, driftScores };
}

/**
 * Layer intent-divergence provenance onto findings. For each category
 * that has a hint, compare the hint's declared pattern label against
 * the finding's voted dominantPattern label. When they disagree, attach
 * an `intentDivergence` metadata block so downstream UI can cite the
 * declaration source. No-op when no hints exist.
 */
function enrichWithIntentDivergence(
  ctx: DriftContext,
  findings: DriftFinding[],
): DriftFinding[] {
  const hints = ctx.intentHints ?? [];
  if (hints.length === 0) return findings;

  // Index hints by (category, label) so we can look up the right
  // declaration for each finding in O(1).
  const byCategory = new Map<string, typeof hints[number]>();
  for (const h of hints) {
    const existing = byCategory.get(h.category);
    if (!existing || h.confidence > existing.confidence) {
      byCategory.set(h.category, h);
    }
  }

  return findings.map((f) => {
    const hint = byCategory.get(f.driftCategory);
    if (!hint) return f;
    // If the finding's voted dominant matches the declared label, no
    // divergence. Case-insensitive comparison because pattern labels
    // come from human-friendly name maps that sometimes differ in case.
    const dominantLabel = (f.dominantPattern ?? "").toLowerCase();
    const declaredLabel = hint.label.toLowerCase();
    if (dominantLabel === declaredLabel) return f;
    // If the finding's dominant isn't even in the same "family" as the
    // declared pattern (different category), we can't claim divergence
    // — but since we filter by category above, we're safe here.
    return {
      ...f,
      intentDivergence: {
        declaredPattern: hint.pattern,
        declaredLabel: hint.label,
        source: hint.source,
        line: hint.line,
        text: hint.text,
      },
    };
  });
}

/**
 * Mirror the single authoritative composite (the scoring engine's
 * `compositeScore`) onto the drift breakdown for the uploaded payload. The
 * dashboard reads `result_json.driftScores.composite` (queries.ts /
 * intent-drift.ts), so the field must exist and EQUAL the headline — it is
 * never independently recomputed. This is the one place the mirror happens
 * (Phase 0 dual-engine collapse). Returns a new object; does not mutate input.
 */
export function attachEngineComposite(
  breakdown: DriftScores,
  compositeScore: number,
): DriftScores & { composite: number } {
  return { ...breakdown, composite: compositeScore };
}

export function driftFindingToFinding(d: DriftFinding): Finding {
  return {
    // analyzerId is keyed off the typed `driftCategory` enum — NOT the
    // freeform `detector` string — so it always matches a registered id in
    // scoring/categories.ts. Using `detector` (which detectors set
    // inconsistently: some to the category, some to the detector id) was the
    // root of the wiring bug that excluded 11 of 14 detectors from the score.
    analyzerId: `drift-${d.driftCategory}`,
    severity: d.severity,
    confidence: d.confidence,
    message: `DRIFT: ${d.finding}`,
    // Carry the dominance ratio so the scoring engine can weight by HOW
    // inconsistent this category is (deviation fraction = 1 - consistencyScore/100),
    // not merely whether this detector fired. Previously dropped here (the
    // single most drift-relevant computed quantity never reached scoring).
    //
    // EXCEPT for count-based detectors (phantom scaffolding, semantic duplication):
    // they have no real dominance ratio, so we omit driftSignal and let the engine
    // size-normalize them through its count-based density branch instead of reading
    // a fabricated consistencyScore as a deviation rate.
    ...(d.countBased
      ? {}
      : {
          driftSignal: {
            consistencyScore: d.consistencyScore,
            dominantCount: d.dominantCount,
            totalRelevantFiles: d.totalRelevantFiles,
          },
        }),
    locations: d.deviatingFiles.slice(0, 15).map((df) => ({
      file: df.path,
      line: df.evidence[0]?.line,
      snippet: df.evidence[0]?.code ?? df.detectedPattern,
    })),
    tags: [
      "drift",
      d.driftCategory,
      "cross-file",
      ...(d.pivot ? ["temporal-pivot"] : []),
      ...(d.intentDivergence ? ["intent-divergence"] : []),
    ],
    metadata: {
      dominantPattern: d.dominantPattern,
      dominantFiles: d.dominantFiles ?? [],
      recommendation: d.recommendation,
      ...(d.pivot ? { pivot: d.pivot } : {}),
      ...(d.legacyFiles && d.legacyFiles.length > 0
        ? { legacyFiles: d.legacyFiles.map((f) => f.path) }
        : {}),
      ...(d.intentDivergence ? { intentDivergence: d.intentDivergence } : {}),
    },
  };
}
