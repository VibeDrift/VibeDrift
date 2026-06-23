/**
 * Export-style consistency detector (directory-scoped).
 *
 * Classifies each JS/TS source file's export style:
 *   - "default_export" — file has any `export default` (may also have named)
 *   - "named_only"     — file exports only named symbols
 *
 * Barrel / index files are excluded because they re-export from neighbors
 * and don't reflect the file's own authored style.
 *
 * Runs the dominance vote **per directory** (L1.5-S1). If `src/models/` is
 * consistently `default_export` and `src/utils/` is consistently
 * `named_only`, neither directory is flagged — each is internally
 * consistent. Drift is a file that breaks from its directory peers.
 *
 * Minimum 3 files per directory; dominance ≥ 70%.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, Evidence } from "./types.js";
import { buildDirectoryScopedVote, buildFileAgeMap, buildPatternDistribution, entropyGate, noConventionFinding, pickIntentHint } from "./utils.js";

type ExportStyle = "default_export" | "named_only";

interface FileExportProfile {
  file: string;
  style: ExportStyle;
  evidence: Evidence[];
}

function isSourceFile(path: string): boolean {
  if (/(?:test|spec|mock|fixture|__test__|__mocks__|\.test\.|\.spec\.)/i.test(path)) return false;
  if (/(?:\.config\.|\.d\.ts$|node_modules|dist\/|build\/|index\.)/i.test(path)) return false;
  return true;
}

function analyzeExports(file: DriftFile): FileExportProfile | null {
  if (!file.language || !["javascript", "typescript"].includes(file.language)) return null;
  if (!isSourceFile(file.path)) return null;

  const lines = file.content.split("\n");
  let hasDefaultExport = false;
  let hasNamedExport = false;
  const evidence: Evidence[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (/^export\s+default\b/.test(line) || /\bmodule\.exports\s*=/.test(line)) {
      hasDefaultExport = true;
      if (evidence.length < 2) evidence.push({ line: i + 1, code: line.slice(0, 100) });
    } else if (/^export\s+(?:function|class|const|let|var|interface|type|enum|abstract)\b/.test(line)) {
      hasNamedExport = true;
      if (evidence.length < 2) evidence.push({ line: i + 1, code: line.slice(0, 100) });
    } else if (/^export\s*\{/.test(line)) {
      hasNamedExport = true;
      if (evidence.length < 2) evidence.push({ line: i + 1, code: line.slice(0, 100) });
    }
  }

  if (!hasDefaultExport && !hasNamedExport) return null;
  const style: ExportStyle = hasDefaultExport ? "default_export" : "named_only";
  return { file: file.path, style, evidence };
}

const STYLE_NAMES: Record<ExportStyle, string> = {
  default_export: "default exports",
  named_only: "named exports only",
};

export const exportConsistency: DriftDetector = {
  id: "export-consistency",
  name: "Export Style Consistency",
  category: "export_style",

  detect(ctx: DriftContext): DriftFinding[] {
    const fileProfiles: FileExportProfile[] = [];
    for (const file of ctx.files) {
      const p = analyzeExports(file);
      if (p) fileProfiles.push(p);
    }
    if (fileProfiles.length < 3) return [];

    const profiles = fileProfiles.map((p) => ({
      file: p.file,
      patterns: [{ pattern: p.style, evidence: p.evidence }],
    }));

    // Project-level entropy gate (L1.5-A1). When entropy is high there is NO
    // dominant pattern — for a self-consistency score that is the FLOOR of
    // consistency, so we emit one category-level "no convention" finding whose
    // deviation IS the entropy (see noConventionFinding), guarded by a minimum
    // sample so a tiny split reads as insufficient data, not chaos.
    const projectDist = buildPatternDistribution(profiles);
    const gate = entropyGate(projectDist);
    if (gate.decision === "no_convention") {
      return noConventionFinding({
        detector: "export_style",
        subCategory: "export_style",
        driftCategory: "export_style",
        axisLabel: "export style",
        totalFiles: profiles.length,
        gate,
        recommendation: "Establish a single export convention (prefer named exports for tree-shaking) and align files to it.",
      });
    }

    const votes = buildDirectoryScopedVote(profiles, STYLE_NAMES, {
      minGroupSize: 3,
      dominanceThreshold: 0.7,
      fileAges: buildFileAgeMap(ctx),
      seededPattern: pickIntentHint(ctx, "export_style")?.pattern,
    });

    return votes.map((v) => ({
      detector: "export_style",
      subCategory: "export_style",
      driftCategory: "export_style",
      severity: v.deviators.length >= 3 ? "warning" : "info",
      confidence: gate.confidence,
      finding: `Export style in ${v.directory}/: ${v.dominantCount} files use ${STYLE_NAMES[v.dominant]}, ${v.deviators.length} deviate`,
      dominantPattern: STYLE_NAMES[v.dominant],
      dominantCount: v.dominantCount,
      totalRelevantFiles: v.totalFiles,
      consistencyScore: v.consistencyScore,
      deviatingFiles: v.deviators,
      dominantFiles: v.dominantFiles,
      recommendation: `Standardize ${v.directory}/ on ${STYLE_NAMES[v.dominant]}. ${v.dominant === "named_only" ? "Named exports enable tree-shaking and explicit imports." : "Default exports simplify imports but disable tree-shaking."}`,
    }));
  },
};
