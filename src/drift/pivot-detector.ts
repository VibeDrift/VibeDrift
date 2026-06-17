/**
 * Pivot detection — reclassifies drift findings when a codebase is
 * actively migrating from one pattern to another.
 *
 * The problem this solves:
 *   • Repo has 10 old handlers using raw SQL
 *   • Team migrated 3 handlers to the repository pattern last month
 *   • Raw dominance vote says raw_sql is dominant (10 > 3)
 *   • Recent dominance vote (weighted) correctly sees repository as new dominant
 *   • But the 10 old files shouldn't be flagged as "drift" — they're LEGACY
 *     on the old pattern, not deviating from the new one by accident
 *
 * Algorithm — applied AFTER the temporal-weighted vote produces a finding:
 *   1. Split the directory's files into `recent` (≤90 days) and
 *      `legacy` (>90 days) populations.
 *   2. Compute unweighted dominance in each population independently.
 *   3. If recent.dominant ≠ legacy.dominant AND both have ≥ threshold
 *      consistency, it's a pivot.
 *   4. Reclassify deviatingFiles:
 *        - Files aligned with legacy.dominant → `legacy`
 *        - Everyone else (not recent.dominant, not legacy.dominant) → `drift`
 *
 * Without pivot detection, all non-dominant files are drift. WITH pivot
 * detection, the UI can distinguish "migrate when convenient" from
 * "this file is genuinely off on its own."
 */

import type { DriftContext, DriftFile, DriftFinding, PivotDetection } from "./types.js";
import { directoryOf } from "./utils.js";

const RECENT_WINDOW_DAYS = 90;
const MIN_POPULATION = 3;
const RECENT_CONSISTENCY_MIN = 70; // recent pattern must be this consistent
const LEGACY_CONSISTENCY_MIN = 60; // legacy pattern also needs to be somewhat coherent

interface FileBucket {
  pattern: string;
  path: string;
  daysAgo: number | null;
}

function gatherFiles(
  ctx: DriftContext,
  finding: DriftFinding,
): { recent: FileBucket[]; legacy: FileBucket[] } {
  const dir = finding.deviatingFiles[0] ? directoryOf(finding.deviatingFiles[0].path) : null;
  if (!dir) return { recent: [], legacy: [] };

  // Build a path → (pattern, daysAgo) map we can sort into two buckets.
  // Dominant files keep their dominant label; deviators bring their own.
  const ageByFile = new Map<string, number | null>();
  for (const f of ctx.files) {
    ageByFile.set(f.path, f.git?.lastModifiedDaysAgo ?? null);
  }

  const buckets: FileBucket[] = [];
  for (const domPath of finding.dominantFiles ?? []) {
    if (directoryOf(domPath) !== dir) continue;
    buckets.push({
      pattern: finding.dominantPattern,
      path: domPath,
      daysAgo: ageByFile.get(domPath) ?? null,
    });
  }
  for (const dev of finding.deviatingFiles) {
    if (directoryOf(dev.path) !== dir) continue;
    buckets.push({
      pattern: dev.detectedPattern,
      path: dev.path,
      daysAgo: ageByFile.get(dev.path) ?? null,
    });
  }

  const recent: FileBucket[] = [];
  const legacy: FileBucket[] = [];
  for (const b of buckets) {
    if (b.daysAgo == null) continue;
    if (b.daysAgo <= RECENT_WINDOW_DAYS) recent.push(b);
    else legacy.push(b);
  }
  return { recent, legacy };
}

function dominantOf(bucket: FileBucket[]): { pattern: string; count: number; total: number } | null {
  if (bucket.length === 0) return null;
  const counts = new Map<string, number>();
  for (const b of bucket) counts.set(b.pattern, (counts.get(b.pattern) ?? 0) + 1);
  let pattern = "";
  let count = 0;
  for (const [p, c] of counts) {
    if (c > count) { count = c; pattern = p; }
  }
  return { pattern, count, total: bucket.length };
}

/**
 * Detect a pivot inside a single drift finding. Returns null when no
 * pivot is detected (finding stays as-is). Returns a mutated copy with
 * classification metadata when a pivot IS detected.
 */
export function detectPivot(
  ctx: DriftContext,
  finding: DriftFinding,
): DriftFinding {
  if (!ctx.hasGitMetadata) return finding;
  if (!finding.deviatingFiles || finding.deviatingFiles.length === 0) return finding;

  const { recent, legacy } = gatherFiles(ctx, finding);
  if (recent.length < MIN_POPULATION || legacy.length < MIN_POPULATION) {
    return finding;
  }

  const recentDom = dominantOf(recent);
  const legacyDom = dominantOf(legacy);
  if (!recentDom || !legacyDom) return finding;

  const recentConsistency = (recentDom.count / recentDom.total) * 100;
  const legacyConsistency = (legacyDom.count / legacyDom.total) * 100;

  // Pivot requires both populations to have a clear dominant AND the
  // dominants to differ. Same pattern in both = no pivot, just drift.
  if (recentDom.pattern === legacyDom.pattern) return finding;
  if (recentConsistency < RECENT_CONSISTENCY_MIN) return finding;
  if (legacyConsistency < LEGACY_CONSISTENCY_MIN) return finding;

  const pivot: PivotDetection = {
    fromPattern: legacyDom.pattern,
    toPattern: recentDom.pattern,
    recentConsistencyScore: Math.round(recentConsistency),
    legacyConsistencyScore: Math.round(legacyConsistency),
    recentFileCount: recent.length,
    legacyFileCount: legacy.length,
  };

  // Reclassify deviating files. Anyone aligned with the legacy dominant
  // is `legacy` (migrate-when-convenient). Anyone else is real `drift`.
  const reclassifiedDrift = [];
  const legacyFiles = [];
  for (const dev of finding.deviatingFiles) {
    if (dev.detectedPattern === legacyDom.pattern) {
      legacyFiles.push({ ...dev, classification: "legacy" as const });
    } else {
      reclassifiedDrift.push({ ...dev, classification: "drift" as const });
    }
  }

  return {
    ...finding,
    deviatingFiles: reclassifiedDrift,
    legacyFiles,
    pivot,
    // When the recent dominant pattern is the SAME as the finding's
    // reported dominantPattern, no adjustment is needed. When they
    // differ (the weighted vote picked a different winner than the
    // unweighted recent-window check), we defer to the finding's
    // reported dominant — it's the output of the main vote.
  };
}

/**
 * Run pivot detection across every finding in a scan. Returns a new
 * array of findings with drift/legacy reclassification applied where
 * pivots are detected.
 */
export function detectPivotsAcrossFindings(
  ctx: DriftContext,
  findings: DriftFinding[],
): DriftFinding[] {
  if (!ctx.hasGitMetadata) return findings;
  return findings.map((f) => detectPivot(ctx, f));
}

// Re-export for consumers that don't want to import from types.ts
export type { DriftFile, DriftFinding, PivotDetection };
