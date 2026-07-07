/**
 * Import-style consistency detector (directory-scoped).
 *
 * Classifies each JS/TS file's dominant import path style:
 *   - "relative" — uses `./` / `../` paths predominantly
 *   - "alias"    — uses `@/` / `~/` path aliases predominantly
 *
 * Runs the dominance vote **per directory** (L1.5-S1). A directory where
 * 5 files use aliases and 1 uses relative paths is drift within that
 * directory. If `src/routes/` uses aliases while `src/utils/` uses relative
 * paths, neither is flagged because each is internally consistent —
 * different subsystems can legitimately pick different import strategies.
 *
 * Minimum 3 files per directory; dominance ≥ 70%.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, Evidence } from "./types.js";
import { buildDirectoryScopedVote, buildFileAgeMap, buildPatternDistribution, entropyGate, isAnalyzableSource, noConventionFinding, pickIntentHint } from "./utils.js";

type ImportPathStyle = "relative" | "alias";

interface FileImportProfile {
  file: string;
  pathStyle: ImportPathStyle | null;
  evidence: Evidence[];
}

function analyzeImports(file: DriftFile): FileImportProfile | null {
  if (!file.language || !["javascript", "typescript"].includes(file.language)) return null;
  if (!isAnalyzableSource(file.path)) return null;

  const lines = file.content.split("\n");
  let relativeCount = 0;
  let aliasCount = 0;
  const evidence: Evidence[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const importMatch = line.match(/^import\s+(?!type\s)/);
    if (!importMatch) continue;

    const fromMatch = line.match(/from\s+["']([^"']+)["']/);
    if (!fromMatch) continue;
    const importPath = fromMatch[1];

    // Skip node_modules / external packages
    if (!importPath.startsWith(".") && !importPath.startsWith("@/") && !importPath.startsWith("~/")) continue;

    if (importPath.startsWith("./") || importPath.startsWith("../")) {
      relativeCount++;
    } else if (importPath.startsWith("@/") || importPath.startsWith("~/")) {
      aliasCount++;
    }

    if (evidence.length < 3) {
      evidence.push({ line: i + 1, code: line });
    }
  }

  const totalLocalImports = relativeCount + aliasCount;
  if (totalLocalImports < 3) return null;

  // Use the same classification as before: majority wins, with pure-alias
  // classified as alias even if 0 relative.
  const pathStyle: ImportPathStyle =
    aliasCount === 0 ? "relative" :
    relativeCount === 0 ? "alias" :
    relativeCount >= aliasCount ? "relative" : "alias";

  return { file: file.path, pathStyle, evidence };
}

const PATH_STYLE_NAMES: Record<ImportPathStyle, string> = {
  relative: "relative paths (./)",
  alias: "path aliases (@/)",
};

export const importConsistency: DriftDetector = {
  id: "import-consistency",
  name: "Import Style Consistency",
  category: "import_style",

  detect(ctx: DriftContext): DriftFinding[] {
    const fileProfiles: FileImportProfile[] = [];
    for (const file of ctx.files) {
      const p = analyzeImports(file);
      if (p && p.pathStyle) fileProfiles.push(p);
    }
    if (fileProfiles.length < 3) return [];

    const profiles = fileProfiles.map((p) => ({
      file: p.file,
      patterns: [{ pattern: p.pathStyle!, evidence: p.evidence }],
    }));

    // Entropy gate (L1.5-A1). High entropy = no dominant import-path convention.
    // For a self-consistency score that is the FLOOR of consistency, so emit one
    // category-level "no convention" finding whose deviation IS the entropy
    // (guarded by a minimum sample so a tiny split reads as insufficient data,
    // not chaos).
    const projectDist = buildPatternDistribution(profiles);
    const gate = entropyGate(projectDist);
    if (gate.decision === "no_convention") {
      return noConventionFinding({
        detector: "import_style",
        subCategory: "path_style",
        driftCategory: "import_style",
        axisLabel: "import path style",
        totalFiles: profiles.length,
        gate,
        recommendation: "Establish a single import-path convention (alias or relative) and align files to it.",
      });
    }

    const votes = buildDirectoryScopedVote(profiles, PATH_STYLE_NAMES, {
      minGroupSize: 3,
      dominanceThreshold: 0.7,
      fileAges: buildFileAgeMap(ctx),
      seededPattern: pickIntentHint(ctx, "import_style")?.pattern,
    });

    return votes.map((v) => ({
      detector: "import_style",
      subCategory: "path_style",
      driftCategory: "import_style",
      severity: v.deviators.length >= 3 ? "warning" : "info",
      confidence: gate.confidence,
      finding: `Import path style in ${v.directory}/: ${v.dominantCount} files use ${PATH_STYLE_NAMES[v.dominant]}, ${v.deviators.length} deviate`,
      dominantPattern: PATH_STYLE_NAMES[v.dominant],
      dominantCount: v.dominantCount,
      totalRelevantFiles: v.totalFiles,
      consistencyScore: v.consistencyScore,
      deviatingFiles: v.deviators,
      dominantFiles: v.dominantFiles,
      recommendation: `Standardize ${v.directory}/ on ${PATH_STYLE_NAMES[v.dominant]} for consistency.`,
    }));
  },
};
