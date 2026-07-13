/**
 * Architectural-contradiction detector (directory-scoped per axis).
 *
 * Scans each source file for evidence along four architectural axes and
 * votes on the dominant choice within each directory:
 *   - data_access       (repository / raw_sql / orm / direct_db / http_client / in_memory)
 *   - error_handling    (wrap_with_context / raw_propagation / swallow / http_error_response / exception_throw / result_type)
 *   - config            (env_direct / config_struct_di / hardcoded / mixed)
 *   - dependency_injection (constructor_injection / global_import / service_locator / no_di)
 *
 * Each axis votes independently, per-directory (L1.5-S1). A file drifts
 * only when its directory peers disagree with it on one axis — e.g.
 * 3 files in `src/handlers/` use the repository pattern and 1 uses raw
 * SQL. Different directories can legitimately pick different patterns
 * (`src/handlers/` with repositories, `src/migrations/` with raw SQL)
 * without either being flagged.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, Evidence } from "./types.js";
import {
  buildDirectoryScopedVote,
  buildFileAgeMap,
  extractEvidence,
  isAnalyzableSource,
  pickIntentHint,
} from "./utils.js";

type DataAccessPattern = "repository" | "raw_sql" | "orm" | "direct_db" | "http_client" | "in_memory";
type ErrorHandlingPattern = "wrap_with_context" | "raw_propagation" | "swallow" | "http_error_response" | "exception_throw" | "result_type";
type ConfigPattern = "env_direct" | "config_struct_di" | "hardcoded" | "mixed";
type DIPattern = "constructor_injection" | "global_import" | "service_locator" | "no_di";

interface FileArchProfile {
  file: string;
  language: string;
  dataAccess: { pattern: DataAccessPattern; evidence: Evidence[] }[];
  errorHandling: { pattern: ErrorHandlingPattern; evidence: Evidence[] }[];
  config: { pattern: ConfigPattern; evidence: Evidence[] }[];
  di: { pattern: DIPattern; evidence: Evidence[] }[];
}

// --- Data Access Pattern Detection ---

function detectDataAccess(file: DriftFile): { pattern: DataAccessPattern; evidence: Evidence[] }[] {
  const results: { pattern: DataAccessPattern; evidence: Evidence[] }[] = [];
  const c = file.content;

  // Repository pattern
  const repoEvidence = extractEvidence(c, /\b(?:store|repo|repository)\.\w+\s*\(/g);
  if (repoEvidence.length > 0) results.push({ pattern: "repository", evidence: repoEvidence });

  // Raw SQL
  const sqlEvidence = extractEvidence(c, /(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|SET|\*)\b/gi);
  if (sqlEvidence.length > 0 && !isRepoFile(file.relativePath)) {
    results.push({ pattern: "raw_sql", evidence: sqlEvidence });
  }

  // ORM
  const ormPatterns = /\.(?:Where|Find|Create|Save|Delete|First|Preload|findOne|findMany|findAll|objects\.filter)\s*\(/g;
  const ormEvidence = extractEvidence(c, ormPatterns);
  if (ormEvidence.length > 0) results.push({ pattern: "orm", evidence: ormEvidence });

  // Direct DB
  const dbEvidence = extractEvidence(c, /\b(?:db|pool|client)\.\s*(?:Query|Exec|QueryRow|query|execute|raw)\s*\(/g);
  if (dbEvidence.length > 0 && !isRepoFile(file.relativePath)) {
    results.push({ pattern: "direct_db", evidence: dbEvidence });
  }

  // HTTP client calls in business logic
  const httpEvidence = extractEvidence(c, /\b(?:fetch|axios|http\.(?:Get|Post|Put)|requests\.(?:get|post))\s*\(/g);
  if (httpEvidence.length > 0) {
    results.push({ pattern: "http_client", evidence: httpEvidence });
  }

  return results;
}

function isRepoFile(path: string): boolean {
  return /(?:repository|repo|store|dal|model|query)/i.test(path);
}

// --- Error Handling Pattern Detection ---

function detectErrorHandling(file: DriftFile): { pattern: ErrorHandlingPattern; evidence: Evidence[] }[] {
  const results: { pattern: ErrorHandlingPattern; evidence: Evidence[] }[] = [];
  const c = file.content;

  if (file.language === "go") {
    const wrapEvidence = extractEvidence(c, /fmt\.Errorf\([^)]*%w/g);
    if (wrapEvidence.length > 0) results.push({ pattern: "wrap_with_context", evidence: wrapEvidence });

    const rawEvidence = extractEvidence(c, /return\s+(?:\w+,\s*)?err\b/g);
    if (rawEvidence.length > 0) results.push({ pattern: "raw_propagation", evidence: rawEvidence });

    const swallowEvidence = extractEvidence(c, /\b_\s*=\s*\w+\.\w+\(/g);
    if (swallowEvidence.length > 0) results.push({ pattern: "swallow", evidence: swallowEvidence });

    const httpErrEvidence = extractEvidence(c, /echo\.NewHTTPError|http\.Error|c\.JSON\(\s*http\.Status/g);
    if (httpErrEvidence.length > 0) results.push({ pattern: "http_error_response", evidence: httpErrEvidence });
  } else if (file.language === "javascript" || file.language === "typescript") {
    const wrapEvidence = extractEvidence(c, /new\s+(?:\w+)?Error\([^)]*\+|throw\s+new\s+\w*Error\(/g);
    if (wrapEvidence.length > 0) results.push({ pattern: "wrap_with_context", evidence: wrapEvidence });

    const swallowEvidence = extractEvidence(c, /catch\s*\([^)]*\)\s*\{\s*(?:\/\/.*\n\s*)?(?:console\.(?:log|warn)|logger\.\w+)[^}]*\}/g);
    if (swallowEvidence.length > 0) results.push({ pattern: "swallow", evidence: swallowEvidence });

    const httpErrEvidence = extractEvidence(c, /res\.status\(\d+\)\.json|\.json\(\s*\{[^}]*error/g);
    if (httpErrEvidence.length > 0) results.push({ pattern: "http_error_response", evidence: httpErrEvidence });

    const resultEvidence = extractEvidence(c, /Result<|Either<|\.ok\(|\.err\(/g);
    if (resultEvidence.length > 0) results.push({ pattern: "result_type", evidence: resultEvidence });
  } else if (file.language === "python") {
    const swallowEvidence = extractEvidence(c, /except[^:]*:\s*\n\s*(?:pass|\.\.\.)\b/g);
    if (swallowEvidence.length > 0) results.push({ pattern: "swallow", evidence: swallowEvidence });

    const raiseEvidence = extractEvidence(c, /raise\s+\w+/g);
    if (raiseEvidence.length > 0) results.push({ pattern: "exception_throw", evidence: raiseEvidence });
  }

  return results;
}

// --- Config Pattern Detection ---

function detectConfigPattern(file: DriftFile): { pattern: ConfigPattern; evidence: Evidence[] }[] {
  const results: { pattern: ConfigPattern; evidence: Evidence[] }[] = [];
  const c = file.content;

  const envEvidence = extractEvidence(c, /(?:process\.env\.\w+|os\.Getenv\(|os\.environ|import\.meta\.env\.\w+|env::var\()/g);
  if (envEvidence.length > 0) results.push({ pattern: "env_direct", evidence: envEvidence });

  const configDI = extractEvidence(c, /\b(?:cfg|config|settings)\.\w+/g);
  if (configDI.length > 0) results.push({ pattern: "config_struct_di", evidence: configDI });

  return results;
}

// --- DI Pattern Detection ---

function detectDIPattern(file: DriftFile): { pattern: DIPattern; evidence: Evidence[] }[] {
  const results: { pattern: DIPattern; evidence: Evidence[] }[] = [];
  const c = file.content;

  if (file.language === "go") {
    const constructorEvidence = extractEvidence(c, /func\s+New\w+\s*\([^)]*\)\s*\*/g);
    if (constructorEvidence.length > 0) results.push({ pattern: "constructor_injection", evidence: constructorEvidence });
  } else if (file.language === "javascript" || file.language === "typescript") {
    const constructorEvidence = extractEvidence(c, /constructor\s*\([^)]*(?:private|readonly|public)\s+\w+/g);
    if (constructorEvidence.length > 0) results.push({ pattern: "constructor_injection", evidence: constructorEvidence });

    const factoryEvidence = extractEvidence(c, /(?:create|make|build)\w+\s*\([^)]*(?:store|repo|service|client)/g);
    if (factoryEvidence.length > 0) results.push({ pattern: "constructor_injection", evidence: factoryEvidence });
  }

  return results;
}

function buildProfile(file: DriftFile): FileArchProfile | null {
  if (!file.language) return null;
  if (!isAnalyzableSource(file.relativePath)) return null;

  const dataAccess = detectDataAccess(file);
  const errorHandling = detectErrorHandling(file);
  const config = detectConfigPattern(file);
  const di = detectDIPattern(file);

  // Only include files that have meaningful patterns
  if (dataAccess.length === 0 && errorHandling.length === 0 && config.length === 0) return null;

  return { file: file.relativePath, language: file.language, dataAccess, errorHandling, config, di };
}

/**
 * Build one DriftFinding per directory-scoped vote on an axis.
 * Returns [] when no directory shows drift on this axis.
 */
function analyzeAxisByDirectory<T extends string>(
  profiles: { file: string; patterns: { pattern: T; evidence: Evidence[] }[] }[],
  patternNames: Record<T, string>,
  subCategory: string,
  fileAges?: Map<string, number>,
  seededPattern?: string,
): DriftFinding[] {
  const votes = buildDirectoryScopedVote(profiles, patternNames, {
    minGroupSize: 3,
    dominanceThreshold: 0.7,
    fileAges,
    seededPattern,
  });

  return votes.map((v) => ({
    detector: "architectural_consistency",
    subCategory,
    driftCategory: "architectural_consistency",
    severity: v.deviators.length >= 3 ? "error" : "warning",
    confidence: 0.85,
    finding: `${v.directory}/: ${v.deviators.length} file(s) use ${[...new Set(v.deviators.map((d) => d.detectedPattern))].join(", ") || "deviating patterns"} while ${v.dominantCount} use ${patternNames[v.dominant]}`,
    dominantPattern: patternNames[v.dominant],
    dominantCount: v.dominantCount,
    totalRelevantFiles: v.totalFiles,
    consistencyScore: v.consistencyScore,
    deviatingFiles: v.deviators,
    dominantFiles: v.dominantFiles,
    recommendation: `In ${v.directory}/, ${v.dominantCount} of ${v.totalFiles} files use ${patternNames[v.dominant]}. Migrate deviating files for consistency.`,
  }));
}

export const DATA_ACCESS_NAMES: Record<DataAccessPattern, string> = {
  repository: "repository pattern",
  raw_sql: "raw SQL queries",
  orm: "ORM methods",
  direct_db: "direct database calls",
  http_client: "inline HTTP client calls",
  in_memory: "in-memory data",
};

// When a single body shows multiple data-access signals, pick its primary by
// evidence count, breaking ties toward the more distinctive deviation.
const DATA_ACCESS_PRIORITY: DataAccessPattern[] = ["raw_sql", "direct_db", "http_client", "orm", "repository", "in_memory"];

/**
 * Single-body classifier for the data-access axis, returning the DISPLAY label
 * (the same string stored in a finding's dominantPattern) or null when the body
 * shows no data-access choice. Shared with validate_change so the in-loop check
 * stays in lockstep with this detector's vocabulary.
 */
export function classifyDataAccessLabel(content: string, path: string): string | null {
  const hits = detectDataAccess({ content, relativePath: path, language: "typescript" } as DriftFile);
  if (hits.length === 0) return null;
  const primary = hits
    .slice()
    .sort((a, b) => b.evidence.length - a.evidence.length || DATA_ACCESS_PRIORITY.indexOf(a.pattern) - DATA_ACCESS_PRIORITY.indexOf(b.pattern))[0];
  return DATA_ACCESS_NAMES[primary.pattern];
}

const ERROR_HANDLING_NAMES: Record<ErrorHandlingPattern, string> = {
  wrap_with_context: "error wrapping with context",
  raw_propagation: "raw error propagation",
  swallow: "error swallowing",
  http_error_response: "direct HTTP error responses",
  exception_throw: "exception throwing",
  result_type: "Result/Either types",
};

const CONFIG_NAMES: Record<ConfigPattern, string> = {
  env_direct: "direct env var access",
  config_struct_di: "config struct via DI",
  hardcoded: "hardcoded values",
  mixed: "mixed config approaches",
};

const DI_NAMES: Record<DIPattern, string> = {
  constructor_injection: "constructor injection",
  global_import: "global singleton imports",
  service_locator: "service locator",
  no_di: "no dependency injection",
};

export const architecturalContradiction: DriftDetector = {
  id: "architectural-contradiction",
  name: "Architectural Pattern Contradictions",
  category: "architectural_consistency",

  detect(ctx: DriftContext): DriftFinding[] {
    const findings: DriftFinding[] = [];
    const profiles: FileArchProfile[] = [];

    for (const file of ctx.files) {
      const p = buildProfile(file);
      if (p) profiles.push(p);
    }

    if (profiles.length < 3) return findings;

    // Build per-file age map once — reused across all four axis votes.
    // When no git metadata is available, this is undefined and voting
    // falls back to flat (pre-temporal) behavior.
    const fileAges = buildFileAgeMap(ctx);

    // Single intent hint applies to the whole architectural_consistency
    // category. Individual axes use the same seed — CLAUDE.md doesn't
    // typically distinguish "repository for handlers" vs "repository
    // for services." If the declared pattern matches one axis but not
    // others, per-axis voting naturally surfaces the right outcome.
    const hint = pickIntentHint(ctx, "architectural_consistency");
    const seededPattern = hint?.pattern;

    // Data access — directory-scoped
    const dataAccessProfiles = profiles
      .filter((p) => p.dataAccess.length > 0)
      .map((p) => ({ file: p.file, patterns: p.dataAccess }));
    findings.push(...analyzeAxisByDirectory(dataAccessProfiles, DATA_ACCESS_NAMES, "data_access", fileAges, seededPattern));

    // Error handling — directory-scoped
    const errorProfiles = profiles
      .filter((p) => p.errorHandling.length > 0)
      .map((p) => ({ file: p.file, patterns: p.errorHandling }));
    findings.push(...analyzeAxisByDirectory(errorProfiles, ERROR_HANDLING_NAMES, "error_handling", fileAges, seededPattern));

    // Config — directory-scoped
    const configProfiles = profiles
      .filter((p) => p.config.length > 0)
      .map((p) => ({ file: p.file, patterns: p.config }));
    findings.push(...analyzeAxisByDirectory(configProfiles, CONFIG_NAMES, "configuration", fileAges, seededPattern));

    // DI — directory-scoped (fall back to no_di sentinel for files with no DI pattern)
    const diProfiles = profiles.map((p) => ({
      file: p.file,
      patterns: p.di.length > 0 ? p.di : [{ pattern: "no_di" as DIPattern, evidence: [] as Evidence[] }],
    }));
    findings.push(...analyzeAxisByDirectory(diProfiles, DI_NAMES, "dependency_injection", fileAges, seededPattern));

    return findings;
  },
};
