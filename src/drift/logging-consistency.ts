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

/**
 * Generic label for the `structured` family. We deliberately do NOT name
 * specific libraries here — the regex below also matches a project's own
 * `logger.*` console wrapper (e.g. createLogger() in src/utils/debug.ts),
 * which is common in AI-generated code and pulls in NO third-party logger.
 * Naming winston/pino/bunyan/log4js in that case is a false claim. When an
 * actual library IS referenced, `describeStructured` swaps in its real name.
 */
const STRUCTURED_GENERIC = "a shared structured logger";

const FAMILY_NAMES: Record<LoggerFamily, string> = {
  console: "console.*",
  structured: STRUCTURED_GENERIC,
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

/**
 * Third-party structured-logging libraries we can name only when they are
 * ACTUALLY referenced in the scanned source. `tracing` is the Rust crate.
 */
const STRUCTURED_LIBRARIES: { name: string; pattern: RegExp }[] = [
  { name: "winston", pattern: /\bwinston\b/ },
  { name: "pino", pattern: /\bpino\b/ },
  { name: "bunyan", pattern: /\bbunyan\b/ },
  { name: "log4js", pattern: /\blog4js\b/ },
  { name: "tracing", pattern: /\btracing::/ },
];

/**
 * Build an honest display name for the `structured` family. If any of the
 * known libraries are referenced anywhere in the structured-logger files,
 * name exactly those. Otherwise fall back to the generic label — the code
 * uses a `logger.*` wrapper, not a library we can point at.
 */
function describeStructured(profiles: FileLoggerProfile[]): string {
  const present = new Set<string>();
  for (const p of profiles) {
    const usesStructured = p.patterns.some((pp) => pp.pattern === "structured");
    if (!usesStructured) continue;
    const code = p.patterns
      .filter((pp) => pp.pattern === "structured")
      .flatMap((pp) => pp.evidence)
      .map((e) => e.code)
      .join("\n");
    for (const lib of STRUCTURED_LIBRARIES) {
      if (lib.pattern.test(code)) present.add(lib.name);
    }
  }
  if (present.size === 0) return STRUCTURED_GENERIC;
  return `structured logger (${[...present].sort().join("/")})`;
}

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

    // Name the `structured` family from what's actually in the code, never
    // from a hardcoded library list. When the only structured logging is a
    // `logger.*` console wrapper, this stays generic instead of falsely
    // claiming winston/pino/bunyan/log4js are present.
    const familyNames: Record<LoggerFamily, string> = {
      ...FAMILY_NAMES,
      structured: describeStructured(profiles),
    };

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

    const deviating = collectDeviatingFiles(counts, dominant, profiles, familyNames);
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
        ? `Team declared ${familyNames[seeded.declaredPattern as LoggerFamily] ?? seeded.declaredPattern} in ${hint!.source} but ${dominantCount}/${totalFiles} files use ${familyNames[dominant]}`
        : `${deviating.length} file(s) use ${[...new Set(deviating.map((d) => d.detectedPattern))].join(", ")} while ${dominantCount} use ${familyNames[dominant]}`,
      dominantPattern: familyNames[dominant],
      dominantCount,
      totalRelevantFiles: totalFiles,
      consistencyScore,
      deviatingFiles: deviating,
      dominantFiles: pickDominantFiles(counts, dominant),
      recommendation: divergence
        ? `Team convention in ${hint!.source}:${hint!.line} says use ${hint!.label}. Migrate ${totalFiles - dominantCount} file(s) to match the declaration.`
        : `Standardize on ${familyNames[dominant]}. Mixed logging forces log aggregation to handle multiple output shapes.`,
    }];
  },
};
