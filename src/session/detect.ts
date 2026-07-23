/**
 * Shared drift detection for a file's content: the SAME multi-query
 * decomposition the flag path and the outcome re-check both need. A single
 * whole-body query dilutes redundancy below the 0.8 threshold (a 3-function
 * body vs a 1-function index entry scores ~0.33) and can classify a
 * mixed-async body as null, so both the raise AND the resolve must query the
 * whole body PLUS each extracted function body — otherwise a still-present
 * finding falsely reads "resolved".
 */

import { validateChangeAgainstBaseline } from "../tools-core/index.js";
import { extractAllFunctions } from "../codedna/function-extractor.js";
import { detectLanguage } from "../core/language.js";
import type { RepoDriftBaseline } from "../core/baseline.js";

const MAX_FUNCTIONS = 5;

export interface DetectedConflict {
  dominantPattern: string;
  yourPattern: string;
  fixHint: string;
}
export interface DetectedDup {
  relativePath: string;
  name: string;
  line: number;
  similarity: number;
}
export interface Detected {
  conflicts: Map<string, DetectedConflict>;
  dups: Map<string, DetectedDup>;
}

/** Throws only if validateChangeAgainstBaseline throws; callers wrap. */
export function detectDrift(
  baseline: RepoDriftBaseline,
  relFile: string,
  content: string,
): Detected {
  const queries: string[] = [content];
  try {
    const language = detectLanguage(relFile);
    if (language) {
      const fns = extractAllFunctions([
        { path: relFile, relativePath: relFile, language, content, lineCount: content.split("\n").length },
      ]);
      for (const fn of fns.slice(0, MAX_FUNCTIONS)) queries.push(fn.rawBody);
    }
  } catch {
    // extraction is an accuracy booster, never a requirement
  }

  const conflicts = new Map<string, DetectedConflict>();
  const dups = new Map<string, DetectedDup>();
  for (const q of queries) {
    const result = validateChangeAgainstBaseline(baseline, relFile, q);
    for (const c of result.conflicts) {
      if (!conflicts.has(c.dimension)) conflicts.set(c.dimension, c);
    }
    for (const d of result.duplicateOf) {
      const key = `${d.relativePath}:${d.line}`;
      const prev = dups.get(key);
      if (!prev || d.similarity > prev.similarity) dups.set(key, d);
    }
  }
  return { conflicts, dups };
}
