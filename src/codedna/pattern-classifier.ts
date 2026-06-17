/**
 * Architectural-pattern classifier with Bayesian context priors (L1.7-A1).
 *
 * Old: signals were counted, normalized to a probability distribution by
 * pure division (likelihood-only). A handler with 3 repository signals + 1
 * raw-SQL signal was 75% repository, full stop — directory and language
 * told us nothing about which pattern was *expected*.
 *
 * New: combines likelihood with a context prior via Bayes' rule
 *
 *     P(pattern | signals, context) ∝ P(signals | pattern) · P(pattern | context)
 *
 * where the prior is derived from:
 *   - directory name semantics (handlers/ → boost http_response shape;
 *     repositories/ → boost repository pattern; etc.)
 *   - dominant project language (Go projects favor tuple returns; Python
 *     favors exceptions/raises)
 *
 * Effect: a `handlers/` file with 3 HTTP signals + 1 repo signal stays
 * confidently classified as http_client. The same file in `utils/` with
 * the same signals lands at lower confidence — context didn't reinforce
 * the conclusion. Calibration improves on small files where signals alone
 * are noisy.
 */

import type { SourceFile } from "../core/types.js";
import type { ArchPattern, PatternDistribution, PatternSignal } from "./types.js";
import type { Finding } from "../core/types.js";

interface SignalDef {
  pattern: ArchPattern;
  regex: RegExp;
  label: string;
}

// Signals that indicate each architectural pattern
const SIGNAL_DEFS: SignalDef[] = [
  // Repository pattern
  { pattern: "repository", regex: /(?:repository|repo|store)\.\w+\(/i, label: "calls repo/store method" },
  { pattern: "repository", regex: /import.*(?:repositories|repos|store)\b/i, label: "imports from repository layer" },
  { pattern: "repository", regex: /this\.repo(?:sitory)?\.|h\.repo\.|s\.store\.|\.repository\./i, label: "accesses injected repository" },

  // Raw SQL
  { pattern: "raw_sql", regex: /(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\s/i, label: "SQL statement literal" },
  { pattern: "raw_sql", regex: /db\.Query(?:Row)?\s*\(/i, label: "direct db.Query call" },
  { pattern: "raw_sql", regex: /db\.Exec\s*\(/i, label: "direct db.Exec call" },
  { pattern: "raw_sql", regex: /cursor\.execute\s*\(/i, label: "cursor.execute call" },
  { pattern: "raw_sql", regex: /\.query\s*\(\s*[`'"]/i, label: "inline SQL query string" },

  // ORM
  { pattern: "orm", regex: /(?:gorm|prisma|sequelize|typeorm|sqlalchemy|django\.db|ent\.)\.?/i, label: "ORM import/usage" },
  { pattern: "orm", regex: /\.Find\(\s*&|\.Create\(\s*&|\.Save\(\s*&|\.Where\(/i, label: "ORM method call (Go)" },
  { pattern: "orm", regex: /\.findOne\(|\.findAll\(|\.create\(.*{|\.update\(.*{|\.destroy\(/i, label: "ORM method call (JS)" },
  { pattern: "orm", regex: /objects\.(?:filter|get|create|all)\(/i, label: "Django ORM call" },

  // Direct DB
  { pattern: "direct_db", regex: /sql\.Open\(|pgx\.Connect|mysql\.Open|mongo\.Connect/i, label: "direct DB connection" },
  { pattern: "direct_db", regex: /new\s+(?:Pool|Client)\(/i, label: "direct DB pool/client" },

  // HTTP client
  { pattern: "http_client", regex: /http\.(?:Get|Post|Put|Delete)\(/i, label: "HTTP client call" },
  { pattern: "http_client", regex: /fetch\(|axios\.|requests\.(?:get|post)/i, label: "HTTP fetch/axios/requests" },
];

// Files that are likely "handler" or "service" files (where pattern drift matters)
function isHandlerOrServiceFile(path: string): boolean {
  return /(?:handler|controller|service|route|endpoint|api|resource)/i.test(path);
}

// ─── Bayesian context priors ─────────────────────────────────────────

const CONTEXT_PRIORS: { test: (path: string) => boolean; boosts: Partial<Record<ArchPattern, number>> }[] = [
  {
    test: (p) => /(?:^|\/)(?:handlers?|controllers?|routes?|endpoints?|api)\b/i.test(p),
    boosts: { http_client: 1.5, repository: 1.2, raw_sql: 0.7, direct_db: 0.5 },
  },
  {
    test: (p) => /(?:^|\/)(?:repositor(?:y|ies)|store|dal|repos?)\b/i.test(p),
    boosts: { repository: 2.0, raw_sql: 1.2, orm: 1.3, http_client: 0.5, direct_db: 0.7 },
  },
  {
    test: (p) => /(?:^|\/)(?:services?|use_cases?|domain)\b/i.test(p),
    boosts: { repository: 1.4, orm: 1.2, raw_sql: 0.8, direct_db: 0.6 },
  },
  {
    test: (p) => /(?:^|\/)(?:migrations?|seeds?|fixtures?)\b/i.test(p),
    boosts: { raw_sql: 2.0, repository: 0.5, orm: 0.7, direct_db: 1.5 },
  },
];

const LANGUAGE_PRIORS: Partial<Record<string, Partial<Record<ArchPattern, number>>>> = {
  go: { repository: 1.2, raw_sql: 1.1 },
  python: { orm: 1.3, repository: 1.0 },
  rust: { repository: 1.1 },
  // js/ts: uniform
};

/**
 * Compute the relative prior P(pattern | context) for each pattern.
 * Returns a multiplier table; defaults to 1.0 (uniform) for any pattern
 * without a specific boost.
 */
function computePriorMultipliers(file: SourceFile): Record<ArchPattern, number> {
  const out: Record<ArchPattern, number> = {
    repository: 1.0, raw_sql: 1.0, orm: 1.0, direct_db: 1.0, http_client: 1.0, none: 1.0,
  };

  for (const ctx of CONTEXT_PRIORS) {
    if (!ctx.test(file.relativePath)) continue;
    for (const [p, boost] of Object.entries(ctx.boosts)) {
      out[p as ArchPattern] *= boost as number;
    }
  }

  if (file.language) {
    const langBoosts = LANGUAGE_PRIORS[file.language];
    if (langBoosts) {
      for (const [p, boost] of Object.entries(langBoosts)) {
        out[p as ArchPattern] *= boost as number;
      }
    }
  }

  return out;
}

function classifyFile(file: SourceFile): PatternDistribution | null {
  if (!file.language) return null;
  if (!isHandlerOrServiceFile(file.relativePath)) return null;

  const lines = file.content.split("\n");
  const signals: PatternSignal[] = [];
  const counts: Partial<Record<ArchPattern, number>> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const def of SIGNAL_DEFS) {
      if (def.regex.test(line)) {
        signals.push({ pattern: def.pattern, signal: def.label, line: i + 1 });
        counts[def.pattern] = (counts[def.pattern] ?? 0) + 1;
      }
    }
  }

  // No signals found → not classifiable
  const totalSignals = Object.values(counts).reduce((sum, c) => sum + c, 0);
  if (totalSignals === 0) return null;

  // Bayesian update: posterior ∝ likelihood × prior
  const priorMul = computePriorMultipliers(file);
  const unnormalized: Partial<Record<ArchPattern, number>> = {};
  let normSum = 0;
  for (const [pattern, count] of Object.entries(counts)) {
    const likelihood = count / totalSignals;
    const prior = priorMul[pattern as ArchPattern] ?? 1.0;
    const posterior = likelihood * prior;
    unnormalized[pattern as ArchPattern] = posterior;
    normSum += posterior;
  }

  const patterns: Partial<Record<ArchPattern, number>> = {};
  for (const [pattern, posterior] of Object.entries(unnormalized)) {
    patterns[pattern as ArchPattern] = Math.round((posterior / normSum) * 100) / 100;
  }

  let dominantPattern: ArchPattern = "none";
  let maxProb = 0;
  for (const [pattern, prob] of Object.entries(patterns)) {
    if (prob > maxProb) {
      maxProb = prob;
      dominantPattern = pattern as ArchPattern;
    }
  }

  const isInternallyInconsistent = maxProb < 0.6 && Object.keys(patterns).length > 1;

  return {
    file: file.path,
    relativePath: file.relativePath,
    patterns,
    dominantPattern,
    confidence: maxProb,
    signals,
    isInternallyInconsistent,
  };
}

export function classifyPatterns(files: SourceFile[]): PatternDistribution[] {
  const distributions: PatternDistribution[] = [];
  for (const file of files) {
    const dist = classifyFile(file);
    if (dist) distributions.push(dist);
  }
  return distributions;
}

export function patternFindings(distributions: PatternDistribution[]): Finding[] {
  const findings: Finding[] = [];

  if (distributions.length < 2) return findings;

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

  // Flag files that deviate from the project-wide dominant pattern
  for (const dist of distributions) {
    if (dist.dominantPattern !== projectDominant && projectDominant !== "none") {
      findings.push({
        analyzerId: "codedna-pattern",
        severity: "warning",
        confidence: dist.confidence,
        message: `Pattern drift: ${dist.relativePath} uses ${dist.dominantPattern} while ${maxCount}/${distributions.length} files use ${projectDominant}`,
        locations: dist.signals.slice(0, 3).map((s) => ({
          file: dist.relativePath,
          line: s.line,
          snippet: s.signal,
        })),
        tags: ["codedna", "pattern", "drift"],
      });
    }

    // Flag internally inconsistent files
    if (dist.isInternallyInconsistent) {
      const patternList = Object.entries(dist.patterns)
        .map(([p, prob]) => `${p}: ${Math.round(prob * 100)}%`)
        .join(", ");
      findings.push({
        analyzerId: "codedna-pattern",
        severity: "info",
        confidence: 0.6,
        message: `Mixed patterns in ${dist.relativePath}: ${patternList} — file mixes architectural approaches internally`,
        locations: [{ file: dist.relativePath }],
        tags: ["codedna", "pattern", "mixed"],
      });
    }
  }

  return findings;
}
