/**
 * Async-pattern consistency detector (directory-scoped).
 *
 * Classifies each JS/TS file's dominant async style:
 *   - "async_await"   — >70% of async ops use `await`
 *   - "then_chains"   — >70% use `.then()` promise chains
 *   - "mixed"         — neither dominates
 *
 * Then runs a dominance vote **per directory** (L1.5-S1). A file is flagged
 * only when its directory peers disagree with it — e.g. 4 handlers in
 * `src/handlers/` all use async/await and 1 uses `.then()` chains. Legacy
 * `src/legacy/*.ts` using `.then()` chains while new code uses async/await
 * is *not* flagged because each directory is internally consistent — that
 * would have been a false-positive under the old global vote.
 *
 * Minimum 3 files per directory before we vote; dominance ≥ 70% required.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, Evidence } from "./types.js";
import { buildDirectoryScopedVote, buildFileAgeMap, buildPatternDistribution, entropyGate, isAnalyzableSource, noConventionFinding, pickIntentHint } from "./utils.js";
import { asyncCounts, classifyAsyncStyle, ASYNC_STYLE_NAMES as STYLE_NAMES, type AsyncStyle } from "./async-style.js";

interface FileAsyncProfile {
  file: string;
  style: AsyncStyle;
  awaitCount: number;
  thenCount: number;
  evidence: Evidence[];
}

function analyzeAsync(file: DriftFile): FileAsyncProfile | null {
  if (!file.language || !["javascript", "typescript"].includes(file.language)) return null;
  if (!isAnalyzableSource(file.relativePath)) return null;

  // Counting + classification live in the shared async-style module so the
  // detector and the MCP validate_change tool agree on the vocabulary. Evidence
  // (line numbers) is collected here with the same matching rules.
  const { awaitCount, thenCount } = asyncCounts(file.content);
  const style = classifyAsyncStyle(file.content);
  if (style === null) return null; // < 2 async ops — too little signal

  const lines = file.content.split("\n");
  const evidence: Evidence[] = [];
  for (let i = 0; i < lines.length && evidence.length < 3; i++) {
    const line = lines[i];
    const t = line.trim();
    const isAwait = /\bawait\s+/.test(line) && !t.startsWith("//") && !t.startsWith("*");
    const isThen =
      /\.\s*then\s*\(/.test(line) && !t.startsWith("//") && !t.startsWith("*") && !/type\s|interface\s/.test(line);
    if (isAwait || isThen) evidence.push({ line: i + 1, code: t.slice(0, 100) });
  }

  return { file: file.relativePath, style, awaitCount, thenCount, evidence };
}

export const asyncConsistency: DriftDetector = {
  id: "async-consistency",
  name: "Async Pattern Consistency",
  category: "async_patterns",

  detect(ctx: DriftContext): DriftFinding[] {
    const fileProfiles: FileAsyncProfile[] = [];
    for (const file of ctx.files) {
      const p = analyzeAsync(file);
      if (p) fileProfiles.push(p);
    }
    if (fileProfiles.length < 3) return [];

    const profiles = fileProfiles.map((p) => ({
      file: p.file,
      patterns: [{ pattern: p.style, evidence: p.evidence }],
    }));

    // Entropy gate (L1.5-A1). High entropy = no dominant async convention. For a
    // self-consistency score that is the FLOOR of consistency, so emit one
    // category-level "no convention" finding whose deviation IS the entropy
    // (guarded by a minimum sample so a tiny split reads as insufficient data,
    // not chaos).
    const projectDist = buildPatternDistribution(profiles);
    const gate = entropyGate(projectDist);
    if (gate.decision === "no_convention") {
      return noConventionFinding({
        detector: "async_patterns",
        subCategory: "async_style",
        driftCategory: "async_patterns",
        axisLabel: "async style",
        totalFiles: profiles.length,
        gate,
        recommendation: "Standardize on async/await (or .then chains) across the codebase and align files to it.",
      });
    }

    const votes = buildDirectoryScopedVote(profiles, STYLE_NAMES, {
      minGroupSize: 3,
      dominanceThreshold: 0.7,
      fileAges: buildFileAgeMap(ctx),
      seededPattern: pickIntentHint(ctx, "async_patterns")?.pattern,
    });

    return votes.map((v) => ({
      detector: "async_patterns",
      subCategory: "async_style",
      driftCategory: "async_patterns",
      severity: v.deviators.length >= 3 ? "warning" : "info",
      confidence: gate.confidence,
      finding: `Async style in ${v.directory}/: ${v.dominantCount} files use ${STYLE_NAMES[v.dominant]}, ${v.deviators.length} deviate`,
      dominantPattern: STYLE_NAMES[v.dominant],
      dominantCount: v.dominantCount,
      totalRelevantFiles: v.totalFiles,
      consistencyScore: v.consistencyScore,
      deviatingFiles: v.deviators,
      dominantFiles: v.dominantFiles,
      recommendation: `Standardize ${v.directory}/ on ${STYLE_NAMES[v.dominant]}. ${v.dominant === "async_await" ? "async/await is more readable and has clearer error handling with try/catch." : "Consider migrating to async/await for consistency and readability."}`,
    }));
  },
};
