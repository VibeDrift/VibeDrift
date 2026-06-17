/**
 * Shared helpers for cross-file drift detectors.
 *
 * The dominance-vote pattern is the backbone of every drift detector:
 *   1. Profile each file — extract its pattern occurrences with evidence
 *   2. Aggregate primary patterns across files into a distribution
 *   3. Pick the majority pattern (the "baseline")
 *   4. Collect the minority files as "deviators" (the drift signal)
 *
 * Two scoping modes:
 *
 *   • PROJECT-SCOPED vote (classic): use `buildPatternDistribution` +
 *     `findDominantPattern` + `collectDeviatingFiles` on the whole file set.
 *     Good when the convention should be consistent across the entire
 *     project (e.g. error shape, top-level export style).
 *
 *   • DIRECTORY-SCOPED vote (new): use `buildDirectoryScopedVote` to group
 *     files by their enclosing directory first, then run the dominance vote
 *     inside each group. Good when peer conventions differ legitimately by
 *     subsystem (e.g. `handlers/` might use async/await while a legacy
 *     `utils/` uses `.then()` chains — each is consistent internally, so
 *     neither should be flagged as drift).
 *
 * Every detector picks one scoping mode per axis. Directory-scoped is the
 * sharper, lower-false-positive choice when peer groups naturally exist.
 */

import { getLineNumber } from "../utils/text.js";
import type { DeviatingFile, DriftContext, Evidence } from "./types.js";

export function getLineContent(content: string, lineNum: number): string {
  return (content.split("\n")[lineNum - 1] ?? "").trim();
}

export function extractEvidence(
  content: string,
  pattern: RegExp,
  maxResults = 3,
): Evidence[] {
  const evidence: Evidence[] = [];
  const regex = new RegExp(pattern.source, pattern.flags);
  let match;
  while ((match = regex.exec(content)) !== null && evidence.length < maxResults) {
    const line = getLineNumber(content, match.index);
    evidence.push({ line, code: getLineContent(content, line) });
  }
  return evidence;
}

/**
 * Pick the primary (most common) pattern within a single file's occurrences.
 * Used to reduce per-file multi-signals to one "primary choice".
 */
export function detectFilePattern<T extends string>(
  patterns: { pattern: T; evidence: Evidence[] }[],
): T | null {
  const fileCounts = new Map<T, number>();
  for (const { pattern } of patterns) {
    fileCounts.set(pattern, (fileCounts.get(pattern) ?? 0) + 1);
  }
  let primaryPattern: T | null = null;
  let maxCount = 0;
  for (const [pat, count] of fileCounts) {
    if (count > maxCount) { maxCount = count; primaryPattern = pat; }
  }
  return primaryPattern;
}

export function buildPatternDistribution<T extends string>(
  profiles: { file: string; patterns: { pattern: T; evidence: Evidence[] }[] }[],
): Map<T, { count: number; files: string[]; weight?: number }> {
  const counts = new Map<T, { count: number; files: string[]; weight?: number }>();

  for (const p of profiles) {
    const primaryPattern = detectFilePattern(p.patterns);
    if (!primaryPattern) continue;

    if (!counts.has(primaryPattern)) counts.set(primaryPattern, { count: 0, files: [] });
    const entry = counts.get(primaryPattern)!;
    entry.count++;
    entry.files.push(p.file);
  }

  return counts;
}

export function findDominantPattern<T extends string>(
  counts: Map<T, { count: number; files: string[]; weight?: number }>,
): { dominant: T; dominantCount: number } | null {
  let dominant: T | null = null;
  let dominantCount = 0;
  for (const [pattern, data] of counts) {
    if (data.count > dominantCount) { dominantCount = data.count; dominant = pattern; }
  }
  if (!dominant) return null;
  return { dominant, dominantCount };
}

export function collectDeviatingFiles<T extends string>(
  counts: Map<T, { count: number; files: string[]; weight?: number }>,
  dominant: T,
  profiles: { file: string; patterns: { pattern: T; evidence: Evidence[] }[] }[],
  patternNames: Record<T, string>,
): DeviatingFile[] {
  const deviating: DeviatingFile[] = [];
  for (const [pattern, data] of counts) {
    if (pattern === dominant) continue;
    for (const filePath of data.files) {
      const profile = profiles.find((p) => p.file === filePath);
      const evidence = profile?.patterns
        .filter((pp) => pp.pattern === pattern)
        .flatMap((pp) => pp.evidence) ?? [];
      deviating.push({
        path: filePath,
        detectedPattern: patternNames[pattern],
        evidence: evidence.slice(0, 3),
      });
    }
  }
  return deviating;
}

/** Skip files that are tests, fixtures, configs, or generated — shared across detectors. */
export function isAnalyzableSource(path: string): boolean {
  if (/(?:test|spec|mock|fixture|__test__|__mocks__|\.test\.|\.spec\.)/i.test(path)) return false;
  if (/(?:\.config\.|\.d\.ts$|node_modules|dist\/|build\/)/i.test(path)) return false;
  return true;
}

// ─── Shannon entropy gate ────────────────────────────────────────────

/**
 * Shannon entropy of a discrete distribution given raw counts.
 * Range: [0, log₂(k)] where k is the number of non-zero categories.
 */
export function shannonEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let H = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    H -= p * Math.log2(p);
  }
  return H;
}

export interface EntropyGateResult {
  /** "no_convention" if the distribution is too uniform to declare a winner;
   *  "flag_deviators" if a clear majority exists. */
  decision: "no_convention" | "flag_deviators";
  /** Confidence to attach to the resulting finding. */
  confidence: number;
  /** Normalized entropy in [0, 1]. */
  normalizedEntropy: number;
}

/**
 * Decide whether to flag deviators or punt with a "no convention" info.
 * H_norm > 0.8 → too uniform; output a single "no convention" info instead
 * of flagging every minority deviator (avoids false-positive scolding when
 * the project genuinely hasn't established a convention).
 *
 * Otherwise returns confidence = clamp(1 − H_norm, 0.3, 0.9). The tighter
 * the convention, the more confident a deviation is real drift.
 */
export function entropyGate(
  distribution: Map<string, { count: number; files: string[] }>,
): EntropyGateResult {
  const counts = [...distribution.values()].map((d) => d.count);
  const k = counts.filter((c) => c > 0).length;
  if (k < 2) {
    return { decision: "flag_deviators", confidence: 0.9, normalizedEntropy: 0 };
  }
  const H = shannonEntropy(counts);
  const maxH = Math.log2(k);
  const normalizedEntropy = maxH > 0 ? H / maxH : 0;

  if (normalizedEntropy > 0.8) {
    return { decision: "no_convention", confidence: 0.75, normalizedEntropy };
  }
  return {
    decision: "flag_deviators",
    confidence: Math.max(0.3, Math.min(0.9, 1 - normalizedEntropy)),
    normalizedEntropy,
  };
}

// ─── Temporal weighting ─────────────────────────────────────────────

/**
 * Exponential decay weight based on a file's last-modified age.
 *
 *   daysAgo ≤ 0 (just touched)  → 2.0× (doubles the vote)
 *   daysAgo = 90  (one quarter) → 1.0× (neutral)
 *   daysAgo = 180 (two quarters)→ 0.5×
 *   daysAgo = 365 (one year)    → 0.12×
 *
 * The point is to let 3 recent files outvote 10 old ones when the
 * codebase is actively migrating away from an old pattern. Missing
 * metadata (`null`/`undefined`) returns 1.0 — no temporal signal, no
 * change from the pre-temporal behavior.
 */
export function temporalWeight(daysAgo: number | null | undefined): number {
  if (daysAgo == null) return 1.0;
  const d = Math.max(0, daysAgo);
  return 2.0 * Math.exp(-Math.LN2 * d / 90);
}

/**
 * Build a `path → daysAgo` map from the DriftContext. Returns undefined
 * when no git metadata is available, signaling callers to skip temporal
 * weighting (all weights will fall back to 1.0).
 */
export function buildFileAgeMap(ctx: DriftContext): Map<string, number> | undefined {
  if (!ctx.hasGitMetadata) return undefined;
  const m = new Map<string, number>();
  for (const f of ctx.files) {
    if (f.git) m.set(f.path, f.git.lastModifiedDaysAgo);
  }
  return m.size > 0 ? m : undefined;
}

// ─── Intent-hint helpers ─────────────────────────────────────────────

/**
 * Pick the single strongest intent hint for a given drift category +
 * subcategory. When a subcategory is supplied but no match exists, falls
 * back to the best category-level hint. Returns null when no hint applies
 * or when every matching hint is below the confidence floor (0.6).
 */
export function pickIntentHint(
  ctx: DriftContext,
  category: string,
  confidenceFloor = 0.6,
): import("../intent/types.js").IntentHint | null {
  const hints = ctx.intentHints ?? [];
  const matching = hints.filter((h) => h.category === category && h.confidence >= confidenceFloor);
  if (matching.length === 0) return null;
  // Highest confidence wins. Ties broken by earlier source (dedupe already
  // applied that rule during parse, but apply again defensively).
  return matching.reduce((best, h) => (h.confidence > best.confidence ? h : best), matching[0]);
}

export interface SeededVoteResult<T extends string> {
  /** Pattern the hint declared, or null when no hint was passed in. */
  declaredPattern: T | null;
  /**
   * Whether the CODE (raw, unboosted) dominant matches the declaration.
   *   true  — the codebase already follows the hint.
   *   false — the codebase does NOT follow it (caller emits intent_divergence).
   *   null  — no hint applied, or no code to compare against (empty distribution).
   *
   * IMPORTANT: this is computed from the RAW code dominant, NOT the boosted
   * dominant. A declaration that *flips* a close vote still reports
   * `declaredMatched: false` — flipping the seeded vote does not mean the code
   * agrees, it means the team is papering over an unconverged split. Reporting
   * the boosted result as "matched" was the intent-laundering bug.
   */
  declaredMatched: boolean | null;
  /**
   * The raw, unboosted dominant decided by file count alone — what the code
   * actually does, independent of any declaration. Null when distribution is
   * empty. Use this (not `dominant`) as the baseline when describing drift.
   */
  codeDominant: T | null;
  /**
   * True when the hint boost changed the dominant (codeDominant !== dominant).
   * A flip is the strongest signal that the codebase has not converged — it
   * should RAISE confidence in an intent_divergence finding, never silence it.
   */
  flipped: boolean;
  /** Final dominant pattern after hint is applied (boosted). Null when empty. */
  dominant: T | null;
  /** File count for the dominant pattern (raw, NOT weighted). */
  dominantCount: number;
  /** The hint itself, exposed so callers can render divergence context. */
  hint: import("../intent/types.js").IntentHint | null;
}

/**
 * Apply an intent-hint declaration to a pre-built pattern distribution,
 * then pick the dominant with the hint's influence baked in.
 *
 * Semantics
 * ---------
 *   1. If no hint is provided, compute the raw dominant and return it —
 *      this path is a pure no-op passthrough so callers can unconditionally
 *      invoke `seedDominanceVote(distribution, hint)` without branching.
 *
 *   2. If the hint's declared pattern is already in the distribution,
 *      multiply its `weight` by `intentBoost` (default 1.5×). This boosts
 *      an existing pattern without adding phantom files.
 *
 *   3. If the hint's declared pattern is NOT in the distribution, inject
 *      a virtual entry with `count: 0`, `files: []`, and
 *      `weight: 1 + hint.confidence`. A high-confidence declaration
 *      (~0.95) thus carries ~2× the weight of a single file's vote —
 *      strong enough to flip a close vote, not strong enough to override
 *      a broad consensus.
 *
 *   4. Dominance is then decided on the `weight` field (highest wins).
 *      Raw `count` is preserved on every entry for UI / evidence display.
 *
 * Invariant: a hint can flip the dominant pattern only when the hint's
 * weighted contribution exceeds the raw-count gap between the pre-hint
 * dominant and the declared pattern. This is tested exhaustively in
 * `test/unit/drift/seed-dominance.test.ts`.
 */
export function seedDominanceVote<T extends string>(
  distribution: Map<T, { count: number; files: string[]; weight?: number }>,
  hint: import("../intent/types.js").IntentHint | null,
  intentBoost = 1.5,
): SeededVoteResult<T> {
  if (!hint) {
    const dom = findDominantPattern(distribution);
    return {
      declaredPattern: null,
      declaredMatched: null,
      codeDominant: dom?.dominant ?? null,
      flipped: false,
      dominant: dom?.dominant ?? null,
      dominantCount: dom?.dominantCount ?? 0,
      hint: null,
    };
  }

  const declared = hint.pattern as T;

  // Compute the RAW code dominant BEFORE any boost — this is what the codebase
  // actually does, and the only honest basis for "does the code follow the
  // declaration?" (see declaredMatched docs — fixing the laundering bug).
  const rawDom = findDominantPattern(distribution);
  const codeDominant = rawDom?.dominant ?? null;

  // Normalize weights so the boost multiplies a real number. Classical
  // `buildPatternDistribution` doesn't set weight; initialize to count.
  for (const [, entry] of distribution) {
    if (entry.weight === undefined) entry.weight = entry.count;
  }

  if (distribution.has(declared)) {
    const entry = distribution.get(declared)!;
    entry.weight = (entry.weight ?? entry.count) * intentBoost;
  } else {
    distribution.set(declared, {
      count: 0,
      files: [],
      weight: 1 + hint.confidence,
    });
  }

  const dom = findWeightedDominantShared(distribution);
  const seededDominant = dom?.dominant ?? null;
  return {
    declaredPattern: declared,
    // Matched iff the CODE (raw) dominant equals the declaration. Null when
    // there is no code to compare against. A boost-driven flip yields false
    // (codeDominant !== declared) → caller correctly emits intent_divergence.
    declaredMatched: codeDominant === null ? null : codeDominant === declared,
    codeDominant,
    flipped: codeDominant !== null && codeDominant !== seededDominant,
    dominant: seededDominant,
    dominantCount: dom?.dominantCount ?? 0,
    hint,
  };
}

/**
 * Exported weighted-dominant picker. Returns the entry whose `weight`
 * (falling back to `count` when weight is undefined) is maximum. Used by
 * `seedDominanceVote` and available to any detector that wants to decide
 * dominance by weight rather than raw count.
 */
export function findWeightedDominantShared<T extends string>(
  counts: Map<T, { count: number; files: string[]; weight?: number }>,
): { dominant: T; dominantCount: number } | null {
  let dominant: T | null = null;
  let dominantWeight = -1;
  let dominantCount = 0;
  for (const [pattern, data] of counts) {
    const w = data.weight ?? data.count;
    if (w > dominantWeight) {
      dominantWeight = w;
      dominant = pattern;
      dominantCount = data.count;
    }
  }
  if (!dominant) return null;
  return { dominant, dominantCount };
}

// ─── Directory-scoped voting ─────────────────────────────────────────

/**
 * Directory of a relative path.
 *   "handlers/user.ts"            → "handlers"
 *   "src/routes/admin/settings.ts" → "src/routes/admin"
 *   "main.ts"                     → "."
 *   ""                            → "."
 */
export function directoryOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "." : filePath.slice(0, idx);
}

export interface DirectoryVote<T extends string> {
  directory: string;
  totalFiles: number;
  distribution: Map<T, { count: number; files: string[]; weight?: number }>;
  dominant: T;
  dominantCount: number;
  consistencyScore: number;   // (dominantCount / totalFiles) × 100
  deviators: DeviatingFile[];
  /**
   * Up to 3 files that exemplify the dominant pattern in this directory.
   * Feeds the "reference files" list in Fix-Prompt templates. Sorted
   * alphabetically for stable output across re-scans.
   */
  dominantFiles: string[];
  /**
   * True when this vote used temporal weighting (files had git metadata
   * and options.fileAges was provided). Useful for downstream reporting
   * — "this finding is temporally-aware" vs "this was a flat vote."
   */
  temporallyWeighted?: boolean;
  /**
   * When a declared intent was supplied via options.seededPattern, this
   * captures whether the vote's dominant matched the declaration.
   *   - `matched: true`  — code agrees with the declaration. No divergence.
   *   - `matched: false` — declared pattern is NOT the dominant. The
   *                        caller should emit an intent_divergence finding.
   *   - undefined         — no seed was supplied.
   */
  intentMatched?: boolean;
  /** The seeded pattern itself, for downstream divergence-finding construction. */
  seededPattern?: T;
}

/**
 * Pull up to N files that back the dominant pattern from a distribution.
 * Returned alphabetically sorted for deterministic output.
 */
export function pickDominantFiles<T extends string>(
  distribution: Map<T, { count: number; files: string[]; weight?: number }>,
  dominant: T,
  limit = 3,
): string[] {
  const entry = distribution.get(dominant);
  if (!entry) return [];
  return [...entry.files].sort().slice(0, limit);
}

export interface DirectoryScopedVoteOptions {
  /** Minimum files in a directory before we run a vote. Default 3. */
  minGroupSize?: number;
  /** Fraction of files agreeing required to call it "dominant". Default 0.7. */
  dominanceThreshold?: number;
  /**
   * Per-file temporal age (days since last commit). When provided, each
   * file's vote is multiplied by `temporalWeight(age)` — recent files
   * dominate the vote, legacy files fade. Dominance threshold is
   * compared against weighted share, not raw count. Files not in the
   * map contribute neutral weight 1.0.
   *
   * Omit or pass undefined for flat voting (pre-temporal behavior).
   */
  fileAges?: Map<string, number>;
  /**
   * Declared-intent pattern for this detector's category. When set, that
   * pattern's weighted score is multiplied by `intentBoost` (default
   * 1.5×) so human-declared conventions outweigh raw code drift. The
   * vote ALSO records whether the declared pattern matched the eventual
   * dominant — downstream code uses that signal to emit
   * intent-divergence findings when the code ignores the declaration.
   */
  seededPattern?: string;
  /** Boost multiplier applied to the seededPattern's vote weight. Default 1.5. */
  intentBoost?: number;
}

/**
 * Run a dominance vote per-directory instead of project-wide.
 *
 * Why: when `handlers/` and `utils/` have internally-consistent but different
 * conventions, a project-wide vote produces false-positive "drift" findings
 * for the minority directory. Directory-scoped voting only flags a file when
 * its *siblings in the same directory* disagree with it — the peer baseline
 * that actually matters.
 *
 * Algorithm:
 *   1. Group profiles by `directoryOf(file)`.
 *   2. For each group of size ≥ minGroupSize (default 3):
 *      a. Build the pattern distribution within the group.
 *      b. Skip if fewer than 2 distinct patterns (everyone agrees).
 *      c. Pick the dominant. Skip if dominantCount/total < threshold.
 *      d. Collect deviators (non-dominant files in this group only).
 *      e. Emit a DirectoryVote.
 *
 * The returned list has one entry per directory where drift was detected.
 * Each detector converts these into `DriftFinding`s in its own voice.
 */
export function buildDirectoryScopedVote<T extends string>(
  profiles: { file: string; patterns: { pattern: T; evidence: Evidence[] }[] }[],
  patternNames: Record<T, string>,
  options: DirectoryScopedVoteOptions = {},
): DirectoryVote<T>[] {
  const minGroupSize = options.minGroupSize ?? 3;
  const dominanceThreshold = options.dominanceThreshold ?? 0.7;
  const fileAges = options.fileAges;
  const temporallyWeighted = fileAges !== undefined;
  const seededPattern = options.seededPattern as T | undefined;
  const intentBoost = options.intentBoost ?? 1.5;

  // Group by directory
  const byDir = new Map<string, typeof profiles>();
  for (const p of profiles) {
    const dir = directoryOf(p.file);
    const list = byDir.get(dir);
    if (list) list.push(p);
    else byDir.set(dir, [p]);
  }

  const out: DirectoryVote<T>[] = [];
  // Iterate in deterministic order (directory name ascending) for stable output
  const dirs = [...byDir.keys()].sort();
  for (const dir of dirs) {
    const group = byDir.get(dir)!;
    if (group.length < minGroupSize) continue;

    const distribution = buildPatternDistribution(group);
    if (distribution.size < 2) {
      // Directory is internally unanimous. Normally we skip — no drift
      // within the group. BUT if an intent hint declares a pattern and
      // the unanimous pattern is NOT the declared one, that's still a
      // divergence worth reporting (the whole directory ignores the
      // declaration).
      if (seededPattern !== undefined && !distribution.has(seededPattern)) {
        const onlyPattern = [...distribution.keys()][0];
        const entry = distribution.get(onlyPattern)!;
        out.push({
          directory: dir,
          totalFiles: group.length,
          distribution,
          dominant: onlyPattern,
          dominantCount: entry.count,
          consistencyScore: 100,
          deviators: [],
          dominantFiles: pickDominantFiles(distribution, onlyPattern),
          temporallyWeighted,
          intentMatched: false,
          seededPattern,
        });
      }
      continue;
    }

    // When temporal weights are available, attach weighted totals to
    // each distribution entry. Dominance is decided on the weighted
    // share; raw counts are preserved for UI/reporting.
    let totalWeight = group.length;
    const hasAnyWeight = temporallyWeighted || seededPattern !== undefined;
    if (hasAnyWeight) {
      totalWeight = 0;
      for (const [pattern, entry] of distribution) {
        let w = 0;
        if (temporallyWeighted) {
          for (const f of entry.files) {
            w += temporalWeight(fileAges!.get(f));
          }
        } else {
          w = entry.count;
        }
        // Apply intent boost AFTER temporal weighting so the 1.5×
        // multiplier applies to the already-weighted count, not the
        // raw count. This means a declared pattern with recent files
        // gets stacked boosts, but an old declared pattern still gets
        // the declaration's weight even if the code is legacy.
        if (seededPattern !== undefined && pattern === seededPattern) {
          w *= intentBoost;
        }
        entry.weight = w;
        totalWeight += w;
      }
    }

    const dom = hasAnyWeight
      ? findWeightedDominantShared(distribution)
      : findDominantPattern(distribution);
    if (!dom) continue;

    const dominantShare = hasAnyWeight
      ? (distribution.get(dom.dominant)?.weight ?? 0) / Math.max(totalWeight, 0.0001)
      : dom.dominantCount / group.length;
    // When a seed (intent hint) is provided, the declaration is itself
    // a strong enough signal to emit — whether the code agrees (boost
    // pushed a minority into dominance) or disagrees (divergence
    // should be reported). Skip the dominance threshold in that case.
    // Without a seed, require the usual strong-majority threshold.
    if (seededPattern === undefined && dominantShare < dominanceThreshold) continue;

    const deviators = collectDeviatingFiles(distribution, dom.dominant, group, patternNames);

    // Intent divergence: even if no deviators exist inside this directory,
    // when the voted dominant differs from a declared pattern, we still
    // want to record `intentMatched: false` so the caller can emit a
    // top-level divergence finding. But we only emit this vote entry if
    // there's SOMETHING to report (deviators OR a mismatch).
    const intentMatched = seededPattern !== undefined ? dom.dominant === seededPattern : undefined;
    if (deviators.length === 0 && intentMatched !== false) continue;

    out.push({
      directory: dir,
      totalFiles: group.length,
      distribution,
      dominant: dom.dominant,
      dominantCount: dom.dominantCount,
      consistencyScore: Math.round(dominantShare * 100),
      deviators,
      dominantFiles: pickDominantFiles(distribution, dom.dominant),
      temporallyWeighted,
      intentMatched,
      seededPattern,
    });
  }

  return out;
}

