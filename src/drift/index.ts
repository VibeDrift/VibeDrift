import type { AnalysisContext, Finding } from "../core/types.js";
import type { DriftContext, DriftFinding, DriftDetector, DriftCategory } from "./types.js";
import { DRIFT_WEIGHTS } from "./types.js";
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

  // Compute drift-specific scores
  const driftScores = computeDriftScores(allDrift);

  // Convert to standard Finding format for the existing pipeline
  const findings = allDrift.map(driftFindingToFinding);

  return { findings, driftFindings: allDrift, driftScores };
}

function computeDriftScores(findings: DriftFinding[]): DriftScores {
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

  const scores: Record<string, { score: number; maxScore: number; findings: number }> = {};

  for (const cat of categories) {
    const catFindings = findings.filter((f) => f.driftCategory === cat);
    const weight = DRIFT_WEIGHTS[cat];

    if (catFindings.length === 0) {
      scores[cat] = { score: weight, maxScore: weight, findings: 0 };
      continue;
    }

    // Use consistency scores from findings
    // Average consistency score of all findings in this category
    const avgConsistency = catFindings.reduce((sum, f) => sum + f.consistencyScore, 0) / catFindings.length;

    // Scale: consistency 100% = full score, consistency 50% = half score
    // But also penalize by severity: errors reduce score more
    let severityPenalty = 0;
    for (const f of catFindings) {
      if (f.severity === "error") severityPenalty += 3;
      else if (f.severity === "warning") severityPenalty += 1.5;
      else severityPenalty += 0.5;
    }

    // Base score from consistency, reduced by severity penalty
    const rawScore = (avgConsistency / 100) * weight;
    const penalty = Math.min(rawScore, severityPenalty * (weight / 20));
    const score = Math.max(0, Math.round((rawScore - penalty) * 10) / 10);

    scores[cat] = { score, maxScore: weight, findings: catFindings.length };
  }

  // Dual-engine collapse (Phase 0): the composite/grade are NOT computed
  // here anymore. The previous linear `(avgConsistency/100)*weight − penalty`
  // formula was a SECOND scoring engine that disagreed with the authoritative
  // decay-based engine in src/scoring/engine.ts. There is now exactly one
  // composite — the engine's `compositeScore`, which scores every drift-kind
  // finding (these detectors + Code DNA + ML) through one formula. This object
  // is purely the per-drift-category breakdown for report bars.
  // The loop above populates every DriftCategory key, so the cast is safe.
  return scores as unknown as DriftScores;
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
