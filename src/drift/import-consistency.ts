/**
 * Import-style consistency detector (directory-scoped, multi-language).
 *
 * Language-agnostic core: each file is handed to its language's
 * `ImportStyleClassifier` (see `import-style/`), which emits zero or more
 * per-axis classifications. The detector then runs one **dominance vote per
 * axis** — a directory where 5 files use one convention and 1 deviates is drift
 * within that directory, while different subsystems may legitimately differ.
 * A file can be consistent on one axis (e.g. path style) and drift on another
 * (e.g. grouping), so axes are voted independently and each is its own
 * `subCategory`.
 *
 * Per axis: minimum 3 files; dominance ≥ 70%; high project-wide entropy emits a
 * single "no dominant convention" finding instead of per-directory ones.
 */

import type { DriftDetector, DriftContext, DriftFinding, Evidence } from "./types.js";
import type { SupportedLanguage } from "../core/types.js";
import { buildDirectoryScopedVote, buildFileAgeMap, buildPatternDistribution, entropyGate, noConventionFinding, pickIntentHint } from "./utils.js";
import type { ImportStyleClassifier } from "./import-style/types.js";
import { AXES } from "./import-style/labels.js";
import { jsImportClassifier } from "./import-style/js.js";
import { goImportClassifier } from "./import-style/go.js";
import { pythonImportClassifier } from "./import-style/python.js";
import { rustImportClassifier } from "./import-style/rust.js";

// Total Record — every SupportedLanguage has an import-style classifier, so
// adding a language to the union without one is a compile error here (rather
// than silently going un-analyzed). js and ts share one classifier.
const CLASSIFIERS: Record<SupportedLanguage, ImportStyleClassifier> = {
  javascript: jsImportClassifier,
  typescript: jsImportClassifier,
  go: goImportClassifier,
  python: pythonImportClassifier,
  rust: rustImportClassifier,
};

interface AxisProfile {
  file: string;
  patterns: { pattern: string; evidence: Evidence[] }[];
}

export const importConsistency: DriftDetector = {
  id: "import-consistency",
  name: "Import Style Consistency",
  category: "import_style",

  detect(ctx: DriftContext): DriftFinding[] {
    // Classify every file across whatever axes its language decides, bucketed by axis.
    const byAxis = new Map<string, AxisProfile[]>();
    for (const file of ctx.files) {
      if (!file.language || !(file.language in CLASSIFIERS)) continue;
      const classifier = CLASSIFIERS[file.language as SupportedLanguage];
      for (const c of classifier.classify(file)) {
        const list = byAxis.get(c.axis) ?? [];
        list.push({ file: file.relativePath, patterns: [{ pattern: c.pattern, evidence: c.evidence }] });
        byAxis.set(c.axis, list);
      }
    }

    const findings: DriftFinding[] = [];
    const fileAges = buildFileAgeMap(ctx);
    const seededPattern = pickIntentHint(ctx, "import_style")?.pattern;

    for (const [axis, profiles] of byAxis) {
      if (profiles.length < 3) continue;
      const meta = AXES[axis];
      if (!meta) continue; // defensive: a classifier emitted an axis with no metadata

      // Entropy gate: high project-wide entropy means no dominant convention,
      // so emit one category-level finding whose deviation IS the entropy
      // (guarded by a minimum sample inside noConventionFinding).
      const gate = entropyGate(buildPatternDistribution(profiles));
      if (gate.decision === "no_convention") {
        findings.push(...noConventionFinding({
          detector: "import_style",
          subCategory: meta.subCategory,
          driftCategory: "import_style",
          axisLabel: meta.axisLabel,
          totalFiles: profiles.length,
          gate,
          recommendation: meta.noConventionRecommendation,
        }));
        continue;
      }

      const votes = buildDirectoryScopedVote(profiles, meta.patternNames, {
        minGroupSize: 3,
        dominanceThreshold: 0.7,
        fileAges,
        seededPattern,
      });

      for (const v of votes) {
        findings.push({
          detector: "import_style",
          subCategory: meta.subCategory,
          driftCategory: "import_style",
          severity: v.deviators.length >= 3 ? "warning" : "info",
          confidence: gate.confidence,
          finding: `${meta.headline} in ${v.directory}/: ${v.dominantCount} files use ${meta.patternNames[v.dominant]}, ${v.deviators.length} deviate`,
          dominantPattern: meta.patternNames[v.dominant],
          dominantCount: v.dominantCount,
          totalRelevantFiles: v.totalFiles,
          consistencyScore: v.consistencyScore,
          deviatingFiles: v.deviators,
          dominantFiles: v.dominantFiles,
          recommendation: `Standardize ${v.directory}/ on ${meta.patternNames[v.dominant]} for consistency.`,
        });
      }
    }

    return findings;
  },
};
