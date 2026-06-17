/**
 * Logging consistency detector.
 *
 * AI-generated code routinely mixes logger families within one project —
 * `console.log` in one file, `winston.info` in another, `debug()` in a
 * third. Per-call either is fine; the mix forces whoever wires up log
 * aggregation to handle three shapes. Cross-file dominance signal.
 *
 * Algorithm: classify each file's dominant logger family, then apply the
 * standard dominance vote from src/drift/utils.ts.
 */

import type {
  DriftContext,
  DriftDetector,
  DriftFile,
  DriftFinding,
  Evidence,
} from "./types.js";
import {
  buildPatternDistribution,
  collectDeviatingFiles,
  extractEvidence,
  pickDominantFiles,
  pickIntentHint,
  seedDominanceVote,
  isAnalyzableSource,
} from "./utils.js";

type LoggerFamily = "console" | "structured" | "debug_pkg" | "python_logging" | "go_slog";

const FAMILY_NAMES: Record<LoggerFamily, string> = {
  console: "console.*",
  structured: "structured logger (winston/pino/bunyan/log4js/tracing)",
  debug_pkg: "debug() package",
  python_logging: "Python logging module",
  go_slog: "Go log/slog",
};

const FAMILY_PATTERNS: Record<LoggerFamily, RegExp> = {
  console: /\bconsole\.(?:log|info|warn|error|debug)\s*\(/g,
  structured:
    /\b(?:winston|pino|bunyan|log4js|logger\.(?:info|warn|error|debug|trace))\s*[.(]|tracing::\s*(?:info|warn|error|debug)|import\s+winston|import\s+pino/g,
  debug_pkg: /^\s*(?:const|import)\s+\w+\s*=?\s*(?:require\(\s*['"]debug['"]\s*\)|from\s+['"]debug['"])/gm,
  python_logging: /\blogging\.(?:getLogger|info|warning|error|debug)\s*\(/g,
  go_slog: /\b(?:log\.(?:New|Printf|Println|Fatal)|slog\.(?:Info|Warn|Error|Debug))\s*\(/g,
};

interface FileLoggerProfile {
  file: string;
  patterns: { pattern: LoggerFamily; evidence: Evidence[] }[];
}

function detectFamilies(file: DriftFile): FileLoggerProfile | null {
  if (!file.language) return null;
  if (!isAnalyzableSource(file.path)) return null;

  const matches: { pattern: LoggerFamily; evidence: Evidence[] }[] = [];
  for (const family of Object.keys(FAMILY_PATTERNS) as LoggerFamily[]) {
    const ev = extractEvidence(file.content, FAMILY_PATTERNS[family]);
    if (ev.length > 0) matches.push({ pattern: family, evidence: ev });
  }
  if (matches.length === 0) return null;
  return { file: file.path, patterns: matches };
}

export const loggingConsistency: DriftDetector = {
  id: "logging-consistency",
  name: "Logging Consistency",
  category: "logging_consistency",

  detect(ctx: DriftContext): DriftFinding[] {
    const profiles: FileLoggerProfile[] = [];
    for (const file of ctx.files) {
      const p = detectFamilies(file);
      if (p) profiles.push(p);
    }
    if (profiles.length < 3) return [];

    // Files that use multiple families get classified by the most-used one.
    // When an intent hint declares a logger (e.g. "use winston"), seed the
    // dominance vote so the declaration carries weight even when the
    // codebase is in transition.
    const counts = buildPatternDistribution(profiles);
    const hint = pickIntentHint(ctx, "logging_consistency");
    if (counts.size < 2 && !hint) return [];

    const seeded = seedDominanceVote(counts, hint);
    if (!seeded.dominant) return [];

    const { dominant, dominantCount } = seeded;
    const totalFiles = profiles.length;
    const consistencyScore = Math.round((dominantCount / totalFiles) * 100);

    const deviating = collectDeviatingFiles(counts, dominant, profiles, FAMILY_NAMES);
    const divergence = seeded.declaredMatched === false;
    if (deviating.length === 0 && !divergence) return [];

    // Dominance gate: at least 60% of files should agree before we call
    // the minority "drift". Seeded votes bypass this gate — the hint
    // itself is sufficient signal (agreement: emit drift; divergence:
    // emit divergence).
    if (!hint && dominantCount / totalFiles < 0.6) return [];

    return [{
      detector: "logging-consistency",
      driftCategory: "logging_consistency",
      severity: deviating.length >= 3 ? "error" : "warning",
      confidence: 0.75,
      finding: divergence
        ? `Team declared ${FAMILY_NAMES[seeded.declaredPattern as LoggerFamily] ?? seeded.declaredPattern} in ${hint!.source} but ${dominantCount}/${totalFiles} files use ${FAMILY_NAMES[dominant]}`
        : `${deviating.length} file(s) use ${[...new Set(deviating.map((d) => d.detectedPattern))].join(", ")} while ${dominantCount} use ${FAMILY_NAMES[dominant]}`,
      dominantPattern: FAMILY_NAMES[dominant],
      dominantCount,
      totalRelevantFiles: totalFiles,
      consistencyScore,
      deviatingFiles: deviating,
      dominantFiles: pickDominantFiles(counts, dominant),
      recommendation: divergence
        ? `Team convention in ${hint!.source}:${hint!.line} says use ${hint!.label}. Migrate ${totalFiles - dominantCount} file(s) to match the declaration.`
        : `Standardize on ${FAMILY_NAMES[dominant]}. Mixed logging forces log aggregation to handle multiple output shapes.`,
    }];
  },
};
