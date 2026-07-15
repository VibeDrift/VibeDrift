/**
 * Deviation-justification heuristics with config overrides + git/test/ADR
 * signals (L1.7-A2 + A3).
 *
 * Each deviating file gets a score in [0, 1]:
 *   0.0 → likely_accidental drift (forgotten refactor, AI session leak)
 *   1.0 → likely_justified deviation (intentional choice, e.g. raw SQL
 *         in a reporting handler with complex aggregation)
 *
 * Score is base 0.5 + weighted sum of signals. Weights are overridable per
 * project via `.vibedrift.json` (see src/core/config.ts).
 *
 * Signals (with default weights):
 *   +0.15  complex SQL indicators (GROUP BY, HAVING, CTE, 3+ JOIN, etc.)
 *   +0.20  explanatory comment near the deviation site
 *   +0.20  file is in a "special" directory (reporting, admin, migrations)
 *   −0.30  simple CRUD SQL with no complexity
 *   −0.20  same directory as dominant-pattern files
 *   +0.15  git recency — file modified in the last 30 days (intentional)
 *   +0.15  adjacent test file exists (someone thought about this)
 *   +0.25  ADR / decision doc mentions the pattern or filename
 */

import type { SourceFile } from "../core/types.js";
import type { PatternDistribution, DeviationJustification, JustificationSignal, ArchPattern } from "./types.js";
import type { Finding } from "../core/types.js";
import { DEFAULT_DEVIATION_WEIGHTS } from "../core/config.js";

type Weights = typeof DEFAULT_DEVIATION_WEIGHTS;

// Special directories where deviations are more likely justified
const SPECIAL_DIRS = /(?:reporting|analytics|admin|migration|scripts|tools|benchmark|seed|fixtures|test)/i;

// Complex SQL indicators (justify raw SQL over repository pattern)
const COMPLEX_SQL_INDICATORS = [
  /\bGROUP\s+BY\b/i,
  /\bHAVING\b/i,
  /\bWINDOW\b/i,
  /\bOVER\s*\(/i,
  /\bWITH\s+\w+\s+AS\s*\(/i,  // CTEs
  /\bUNION\b/i,
  /\bEXCEPT\b/i,
  /\bINTERSECT\b/i,
  /JOIN.*JOIN.*JOIN/is,         // 3+ JOINs
  /\bLATERAL\b/i,
  /\bEXISTS\s*\(/i,
];

// Explanatory comment patterns near deviations
const COMMENT_EXPLAINS = /(?:performance|optimization|complex\s+query|custom\s+sql|raw\s+sql|aggregate|report|analytics|workaround|intentional|reason|because|note:|todo:|hack:)/i;

function countComplexSqlSignals(content: string): number {
  let count = 0;
  for (const pattern of COMPLEX_SQL_INDICATORS) {
    if (pattern.test(content)) count++;
  }
  return count;
}

function hasExplanatoryComment(content: string, lines: string[], deviationLine?: number): boolean {
  // Check comments near the deviation (within 5 lines above the SQL/pattern usage)
  if (deviationLine !== undefined) {
    const start = Math.max(0, deviationLine - 5);
    const end = Math.min(lines.length, deviationLine + 3);
    const nearby = lines.slice(start, end).join("\n");
    if (COMMENT_EXPLAINS.test(nearby)) return true;
  }

  // Also check file-level comments
  const firstLines = lines.slice(0, 10).join("\n");
  return COMMENT_EXPLAINS.test(firstLines);
}

function isInSpecialDirectory(path: string): boolean {
  return SPECIAL_DIRS.test(path);
}

function dirOf(p: string): string {
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
}

function hasAdjacentTest(devPath: string, allFiles: SourceFile[]): boolean {
  const base = devPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  if (!base) return false;
  return allFiles.some((f) =>
    new RegExp(`(?:^|/)${base.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\.(?:test|spec)\\.[a-z]+$`).test(f.relativePath),
  );
}

function hasAdrMention(allFiles: SourceFile[], devPath: string, deviatingPattern: string): boolean {
  const base = devPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const escBase = escapeRegex(base);
  const escPattern = escapeRegex(deviatingPattern.replace("_", " ")).replace(/ /g, "\\s*");
  const mentionRe = new RegExp(`\\b${escBase}\\b|\\b${escPattern}\\b`, "i");
  return allFiles.some((f) => {
    if (!/(?:^docs\/|^ADR\.md|^DECISIONS\.md|\/(?:adr|decisions)\/)/i.test(f.relativePath)) return false;
    return mentionRe.test(f.content);
  });
}

/** Escape regex metacharacters so a literal string can be interpolated into a RegExp. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeSignalScore(
  file: SourceFile,
  devDist: PatternDistribution,
  dominantFiles: PatternDistribution[],
  projectDominant: ArchPattern,
  weights: Weights,
  allFiles: SourceFile[],
  recentFiles: Set<string>,
): { signals: JustificationSignal[]; totalWeight: number } {
  const lines = file.content.split("\n");
  const signals: JustificationSignal[] = [];
  let totalWeight = 0;

  // Complex SQL — weight × min(count, 2) to preserve old cap behavior
  const sqlComplexity = countComplexSqlSignals(file.content);
  if (sqlComplexity > 0) {
    const w = Math.min(sqlComplexity * weights.complex_sql, weights.complex_sql * 2);
    signals.push({ type: "complex_sql", present: true, weight: w, evidence: `${sqlComplexity} complex SQL indicators` });
    totalWeight += w;
  }

  // Explanatory comment
  const firstSignalLine = devDist.signals[0]?.line;
  if (hasExplanatoryComment(file.content, lines, firstSignalLine)) {
    signals.push({ type: "explanatory_comment", present: true, weight: weights.explanatory_comment, evidence: "comment explains deviation" });
    totalWeight += weights.explanatory_comment;
  } else {
    signals.push({ type: "no_comment", present: true, weight: -0.1, evidence: "no explanatory comment" });
    totalWeight -= 0.1;
  }

  // Special directory
  if (isInSpecialDirectory(devDist.relativePath)) {
    signals.push({ type: "special_directory", present: true, weight: weights.special_directory, evidence: devDist.relativePath });
    totalWeight += weights.special_directory;
  }

  // Simple CRUD SQL (penalty)
  if (devDist.dominantPattern === "raw_sql" && sqlComplexity === 0) {
    const hasCrudOnly = /(?:SELECT\s+\*|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)/i.test(file.content);
    if (hasCrudOnly) {
      signals.push({ type: "simple_crud", present: true, weight: weights.simple_crud_penalty, evidence: "simple CRUD SQL without complex operations" });
      totalWeight += weights.simple_crud_penalty;
    }
  }

  // Same directory as dominant-pattern files
  const devDir = dirOf(devDist.relativePath);
  const sameDir = dominantFiles.filter((d) => dirOf(d.relativePath) === devDir);
  if (sameDir.length > 0) {
    signals.push({ type: "same_directory_as_dominant", present: true, weight: weights.same_directory_penalty, evidence: `${sameDir.length} files in same directory use ${projectDominant}` });
    totalWeight += weights.same_directory_penalty;
  }

  // NEW: git recency
  if (recentFiles.has(file.relativePath)) {
    signals.push({ type: "git_recency", present: true, weight: weights.git_recency, evidence: "modified within the last 30 days" });
    totalWeight += weights.git_recency;
  }

  // NEW: adjacent test file
  if (hasAdjacentTest(devDist.relativePath, allFiles)) {
    signals.push({ type: "adjacent_test", present: true, weight: weights.adjacent_test, evidence: "matching test file exists" });
    totalWeight += weights.adjacent_test;
  }

  // NEW: ADR / decision-doc mention
  if (hasAdrMention(allFiles, devDist.relativePath, devDist.dominantPattern)) {
    signals.push({ type: "adr_mention", present: true, weight: weights.adr_mention, evidence: "referenced in ADR/decision doc" });
    totalWeight += weights.adr_mention;
  }

  return { signals, totalWeight };
}

function classifyDeviation(totalWeight: number): { justificationScore: number; verdict: DeviationJustification["verdict"] } {
  const rawScore = 0.5 + totalWeight;
  const justificationScore = Math.max(0, Math.min(1, rawScore));

  let verdict: DeviationJustification["verdict"];
  if (justificationScore >= 0.6) verdict = "likely_justified";
  else if (justificationScore <= 0.3) verdict = "likely_accidental";
  else verdict = "uncertain";

  return { justificationScore, verdict };
}

export interface ScoreDeviationsOptions {
  weights?: Weights;
  /** Set of relativePaths considered "recently modified" (top 10% by mtime). */
  recentFiles?: Set<string>;
}

export function scoreDeviations(
  distributions: PatternDistribution[],
  files: SourceFile[],
  options: ScoreDeviationsOptions = {},
): DeviationJustification[] {
  if (distributions.length < 2) return [];
  const weights = options.weights ?? DEFAULT_DEVIATION_WEIGHTS;
  const recentFiles = options.recentFiles ?? new Set<string>();

  // Find project-wide dominant pattern
  const patternCounts = new Map<ArchPattern, number>();
  for (const dist of distributions) {
    patternCounts.set(dist.dominantPattern, (patternCounts.get(dist.dominantPattern) ?? 0) + 1);
  }

  let projectDominant: ArchPattern = "none";
  let maxCount = 0;
  for (const [pattern, count] of patternCounts) {
    if (count > maxCount) {
      maxCount = count;
      projectDominant = pattern;
    }
  }

  if (projectDominant === "none") return [];

  const justifications: DeviationJustification[] = [];
  const dominantFiles = distributions.filter((d) => d.dominantPattern === projectDominant);
  const deviatingFiles = distributions.filter((d) => d.dominantPattern !== projectDominant);

  for (const devDist of deviatingFiles) {
    const file = files.find((f) => f.path === devDist.file || f.relativePath === devDist.relativePath);
    if (!file) continue;

    const { signals, totalWeight } = computeSignalScore(
      file, devDist, dominantFiles, projectDominant, weights, files, recentFiles,
    );
    const { justificationScore, verdict } = classifyDeviation(totalWeight);

    justifications.push({
      file: devDist.file,
      relativePath: devDist.relativePath,
      deviatingPattern: devDist.dominantPattern,
      dominantPattern: projectDominant,
      justificationScore,
      signals,
      verdict,
    });
  }

  return justifications;
}

export function deviationFindings(justifications: DeviationJustification[]): Finding[] {
  return justifications
    .filter((j) => j.verdict === "likely_accidental")
    .map((j) => {
      const signalSummary = j.signals
        .filter((s) => s.present && s.weight !== 0)
        .map((s) => s.evidence)
        .filter(Boolean)
        .join("; ");

      return {
        analyzerId: "codedna-deviation",
        severity: "warning" as const,
        confidence: Math.max(0.5, 1 - j.justificationScore),
        message: `Likely accidental deviation: ${j.relativePath} uses ${j.deviatingPattern} while project uses ${j.dominantPattern}. Signals: ${signalSummary}`,
        locations: [{ file: j.relativePath }],
        tags: ["codedna", "deviation", "accidental"],
      };
    });
}
