/**
 * Types for explicit intent extracted from team-declared conventions.
 *
 * A human team often documents their preferred patterns in CLAUDE.md,
 * AGENTS.md, or .cursorrules. Those declarations are a stronger signal
 * than any vote — they're what the team SAYS they do, which is the
 * ground truth for whether a deviation is accidental or legacy.
 *
 * VibeDrift treats each declaration as an `IntentHint` that:
 *   - seeds the dominance vote (boosts the declared pattern's weight)
 *   - attaches provenance to findings ("declared in CLAUDE.md line 42")
 *   - triggers a special "intent divergence" finding when code ignores
 *     a declared convention
 */

import type { DriftCategory } from "../drift/types.js";

export interface IntentHint {
  /** Which drift dimension this hint targets. */
  category: DriftCategory;
  /**
   * Canonical pattern value that should match detector-emitted
   * patterns — e.g. `"repository"`, `"async_await"`, `"camelCase"`.
   * Detectors classify files into these same strings, so the hint
   * seeds the vote by matching pattern value equality.
   */
  pattern: string;
  /** Short human label for UI display (e.g. "repository pattern"). */
  label: string;
  /** Path of the intent file, relative to scan root. */
  source: string;
  /** 1-indexed line number in the source file where the hint was found. */
  line: number;
  /** Verbatim text of the matched line (trimmed), for fix-prompt attribution. */
  text: string;
  /**
   * Classifier confidence in [0, 1]:
   *   - 0.9 — unambiguous direct declaration ("use the repository pattern")
   *   - 0.7 — keyword match inside a conventions heading/list
   *   - 0.5 — weak match in prose or a non-convention section
   * Only hints with confidence ≥ 0.6 seed the vote; lower-confidence
   * hints are retained for debugging but don't bias findings.
   */
  confidence: number;
}

export interface IntentParseResult {
  hints: IntentHint[];
  /** Files actually consulted (only those that existed in the scan root). */
  sourcesScanned: string[];
  /** Files that were looked for but weren't present. Debug aid. */
  sourcesMissing: string[];
}
