/**
 * Return-shape consistency detector.
 *
 * AI-generated code frequently oscillates between error-handling idioms — a
 * handler that throws `NotFoundError()` sits next to a sibling that returns
 * `{ status: 404, error: ... }`, next to one that returns `null`. None of
 * the existing analyzers flag this because each individual choice is valid;
 * the drift is in the inconsistency.
 *
 * Algorithm:
 *   1. Extract each function's body (regex, approximation — no AST in
 *      DriftContext).
 *   2. Classify its error-path shape: throws | result-type | tuple |
 *      result-object | null-sentinel (priority order — a function that
 *      both throws AND returns null is classified as "throws").
 *   3. Skip functions with no error path at all ("plain-return") — they
 *      don't signal an error-handling choice.
 *   4. Group functions by directory (peer-group proxy).
 *   5. For each group with ≥3 error-handling functions, run the standard
 *      dominance vote. Flag groups where the minority is ≥1 file and the
 *      dominant is ≥70% of the group.
 *
 * Confidence 0.7 — regex classification has known false positives (e.g.
 * a comment containing "throw new Error"). An AST pass would bump this
 * to 0.85 once DriftContext carries tree-sitter output.
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
  directoryOf,
  isAnalyzableSource,
  pickDominantFiles,
  pickIntentHint,
  seedDominanceVote,
} from "./utils.js";
import { getLineNumber } from "../utils/text.js";

type ReturnShape =
  | "throws"
  | "result_type"
  | "tuple"
  | "result_object"
  | "null_sentinel";

export const SHAPE_NAMES: Record<ReturnShape, string> = {
  throws: "throws on error",
  result_type: "Result/Either types",
  tuple: "tuple returns (value, error)",
  result_object: "error-object returns",
  null_sentinel: "null/undefined sentinels",
};

// Priority: if a function has multiple error paths, classify by the most
// distinctive one. Throw > Result > tuple > result-object > null-sentinel.
const SHAPE_PRIORITY: ReturnShape[] = [
  "throws",
  "result_type",
  "tuple",
  "result_object",
  "null_sentinel",
];

/** Body-regex classifiers. Each returns evidence offsets for the caller. */
const SHAPE_PATTERNS: Record<ReturnShape, RegExp> = {
  throws: /\b(?:throw\s+new\s+\w+|throw\s+\w+|raise\s+\w+|panic\s*\()/,
  result_type: /\b(?:Result\.(?:fail|ok|err)|Err\s*\(|Ok\s*\(|Either\.(?:left|right)|Result<|Either<)/,
  // Go-style `return x, err` or `return nil, err` — two-return-value with err token last
  tuple: /\breturn\s+[^;{}\n]+,\s*(?:err|error|Err)\b/,
  // Require an explicit error field. `status`/`success` alone over-match
  // benign state/config objects (e.g. `return { status: 0, ... }`).
  result_object: /\breturn\s+\{[^{}]*\b(?:error|err)\b\s*:/,
  null_sentinel: /\breturn\s+(?:null|undefined|None)\b/,
};

interface FunctionExtraction {
  file: string;
  name: string;
  line: number;
  bodySlice: string;
}

/**
 * Extract approximate function bodies via regex — slice from each function
 * start to the next one (or EOF). Good enough for "does this body contain
 * throw / return null / etc.". Same trick as analyzers/complexity.ts.
 */
function extractFunctionBodies(file: DriftFile): FunctionExtraction[] {
  const content = file.content;

  // One pattern per language — we don't need to know which matched, just
  // where functions start and what they're called.
  const functionPattern =
    /(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>|def\s+(\w+)|func\s+(?:\([^)]*\)\s+)?(\w+)|(?:pub\s+)?(?:async\s+)?fn\s+(\w+))/g;

  const starts: { name: string; index: number; line: number }[] = [];
  let match;
  while ((match = functionPattern.exec(content)) !== null) {
    const name = match[1] || match[2] || match[3] || match[4] || match[5];
    if (!name) continue;
    const line = getLineNumber(content, match.index);
    starts.push({ name, index: match.index, line });
  }

  const out: FunctionExtraction[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : content.length;
    out.push({
      file: file.path,
      name: start.name,
      line: start.line,
      bodySlice: content.slice(start.index, end),
    });
  }
  return out;
}

// Global (count) variants for dominance classification. A function's shape is
// the one it uses MOST, not merely the most "distinctive" one that appears once.
const SHAPE_COUNT_PATTERNS: Record<Exclude<ReturnShape, "throws">, RegExp> = {
  result_type: new RegExp(SHAPE_PATTERNS.result_type.source, "g"),
  tuple: new RegExp(SHAPE_PATTERNS.tuple.source, "g"),
  result_object: new RegExp(SHAPE_PATTERNS.result_object.source, "g"),
  null_sentinel: new RegExp(SHAPE_PATTERNS.null_sentinel.source, "g"),
};
// Intentional throw contracts: construct-and-throw / raise / panic.
const STRONG_THROW = /\b(?:throw\s+new\s+\w+|raise\s+\w+|panic\s*\()/g;
// Any `throw <token>` (includes "throw new X"); bare = ANY − THROW_NEW.
const ANY_THROW = /\bthrow\s+\w+/g;
const THROW_NEW = /\bthrow\s+new\s+\w+/g;

function countMatches(re: RegExp, s: string): number {
  const m = s.match(re);
  return m ? m.length : 0;
}

/**
 * Classify one function's error-path shape by its DOMINANT pattern. Returns
 * null if the body shows no error-handling pattern (healthy plain-return
 * function — skip from the drift analysis entirely).
 *
 * Counting (not first-priority-wins) avoids mislabeling a function that
 * returns error-object/sentinel values several times but has a single
 * defensive `throw error` re-propagating a caught error. A bare `throw <ident>`
 * is treated as a re-throw (not this function's own contract) and only counts
 * toward "throws" when the function exposes no other error-return shape. Ties
 * break by SHAPE_PRIORITY (most distinctive wins).
 */
function classifyShape(body: string): ReturnShape | null {
  // Strip line comments so "// throw new Error" doesn't trigger.
  const stripped = body
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*#.*$/gm, "");

  const counts: Record<ReturnShape, number> = {
    throws: 0,
    result_type: countMatches(SHAPE_COUNT_PATTERNS.result_type, stripped),
    tuple: countMatches(SHAPE_COUNT_PATTERNS.tuple, stripped),
    result_object: countMatches(SHAPE_COUNT_PATTERNS.result_object, stripped),
    null_sentinel: countMatches(SHAPE_COUNT_PATTERNS.null_sentinel, stripped),
  };

  const strongThrows = countMatches(STRONG_THROW, stripped);
  const bareThrows = countMatches(ANY_THROW, stripped) - countMatches(THROW_NEW, stripped);
  const hasOtherShape =
    counts.result_type + counts.tuple + counts.result_object + counts.null_sentinel > 0;
  counts.throws = strongThrows + (hasOtherShape ? 0 : bareThrows);

  let best: ReturnShape | null = null;
  let bestCount = 0;
  for (const shape of SHAPE_PRIORITY) {
    if (counts[shape] > bestCount) {
      best = shape;
      bestCount = counts[shape];
    }
  }
  return bestCount > 0 ? best : null;
}

/**
 * Single-body classifier for the return-shape dimension, returning the DISPLAY
 * label (the same string stored in a finding's dominantPattern) or null when
 * the body shows no error-handling choice. Shared with validate_change so the
 * in-loop check can never disagree with this detector.
 */
export function classifyReturnShapeLabel(body: string): string | null {
  const shape = classifyShape(body);
  return shape ? SHAPE_NAMES[shape] : null;
}

/**
 * Group per-function signals into per-file profiles (one primary shape
 * per file, evidence = all its functions that match that shape), then
 * group those profiles by directory.
 */
interface FileShapeProfile {
  file: string;
  patterns: { pattern: ReturnShape; evidence: Evidence[] }[];
}

function buildDirectoryGroups(
  extractions: Map<string, FunctionExtraction[]>,
  shapes: Map<string, ReturnShape[]>,
): Map<string, FileShapeProfile[]> {
  const byDir = new Map<string, FileShapeProfile[]>();

  for (const [filePath, fns] of extractions) {
    const fileShapes = shapes.get(filePath) ?? [];
    if (fns.length === 0 || fileShapes.length === 0) continue;

    // Aggregate shapes → pattern list with per-shape evidence
    const perShape = new Map<ReturnShape, Evidence[]>();
    fns.forEach((fn, i) => {
      const shape = fileShapes[i];
      if (!shape) return;
      const list = perShape.get(shape) ?? [];
      list.push({ line: fn.line, code: `${fn.name}()` });
      perShape.set(shape, list);
    });

    const patterns: { pattern: ReturnShape; evidence: Evidence[] }[] = [];
    for (const [pattern, evidence] of perShape) {
      patterns.push({ pattern, evidence: evidence.slice(0, 3) });
    }
    if (patterns.length === 0) continue;

    const dir = directoryOf(filePath);
    const group = byDir.get(dir) ?? [];
    group.push({ file: filePath, patterns });
    byDir.set(dir, group);
  }

  return byDir;
}

export const returnShapeConsistency: DriftDetector = {
  id: "return-shape-consistency",
  name: "Return Shape Consistency",
  category: "return_shape_consistency",

  detect(ctx: DriftContext): DriftFinding[] {
    // Step 1: extract and classify every function in every source file
    const extractionsByFile = new Map<string, FunctionExtraction[]>();
    const shapesByFile = new Map<string, ReturnShape[]>();

    for (const file of ctx.files) {
      if (!file.language) continue;
      if (!isAnalyzableSource(file.path)) continue;
      // Only languages whose error-handling idioms we understand well.
      if (!["javascript", "typescript", "python", "go", "rust"].includes(file.language)) continue;

      const fns = extractFunctionBodies(file);
      if (fns.length === 0) continue;

      const shapes: ReturnShape[] = [];
      for (const fn of fns) {
        const shape = classifyShape(fn.bodySlice);
        if (shape) shapes.push(shape);
      }
      // Only keep functions that actually matched a shape, aligned with shapes[]
      const matched = fns.filter((fn) => classifyShape(fn.bodySlice) !== null);
      if (matched.length > 0) {
        extractionsByFile.set(file.path, matched);
        shapesByFile.set(file.path, shapes);
      }
    }

    // Step 2: group by directory
    const groups = buildDirectoryGroups(extractionsByFile, shapesByFile);

    // Step 3: per-group dominance vote
    // When an intent hint declares a return-shape for this category, the
    // dominance vote is seeded via `seedDominanceVote`. The hint is a
    // per-project signal (not per-directory), so we pick it once before
    // the loop.
    const findings: DriftFinding[] = [];
    const MIN_GROUP_SIZE = 3;
    const DOMINANCE_THRESHOLD = 0.7;
    const hint = pickIntentHint(ctx, "return_shape_consistency");

    for (const [dir, profiles] of groups) {
      if (profiles.length < MIN_GROUP_SIZE) continue;

      const counts = buildPatternDistribution(profiles);
      if (counts.size < 2 && !hint) continue;

      const seeded = seedDominanceVote(counts, hint);
      if (!seeded.dominant) continue;

      const { dominant, dominantCount } = seeded;
      const totalFiles = profiles.length;
      const consistencyScore = Math.round((dominantCount / totalFiles) * 100);
      // Seeded votes bypass the raw-dominance threshold because the
      // declaration itself is enough signal to emit a finding: either
      // the code aligned with the hint (in which case dominance is OK)
      // or it didn't (which is exactly the divergence we want to flag).
      // Without a seed we require the standard strong-majority threshold.
      if (!hint && dominantCount / totalFiles < DOMINANCE_THRESHOLD) continue;

      const deviating = collectDeviatingFiles(counts, dominant, profiles, SHAPE_NAMES);
      // Emit when there's something to say: deviators OR declared-vs-dominant
      // divergence. A group whose code matches the hint with zero deviators
      // is healthy — skip silently.
      const divergence = seeded.declaredMatched === false;
      if (deviating.length === 0 && !divergence) continue;

      findings.push({
        detector: "return-shape-consistency",
        driftCategory: "return_shape_consistency",
        severity: deviating.length >= 5 ? "error" : "warning",
        confidence: 0.7,
        finding: divergence
          ? `Team declared ${SHAPE_NAMES[seeded.declaredPattern as ReturnShape] ?? seeded.declaredPattern} in ${hint!.source} but ${dir}/ uses ${SHAPE_NAMES[dominant]} (${dominantCount}/${totalFiles} files)`
          : `${deviating.length} file(s) in ${dir}/ use ${[...new Set(deviating.map((d) => d.detectedPattern))].join(", ")} while ${dominantCount} use ${SHAPE_NAMES[dominant]}`,
        dominantPattern: SHAPE_NAMES[dominant],
        dominantCount,
        totalRelevantFiles: totalFiles,
        consistencyScore,
        deviatingFiles: deviating,
        dominantFiles: pickDominantFiles(counts, dominant),
        recommendation: divergence
          ? `Team convention in ${hint!.source}:${hint!.line} says use ${hint!.label}. Migrate ${dir}/ to match the declaration.`
          : `Pick one error-handling shape per directory. In ${dir}/, ${dominantCount} of ${totalFiles} files use ${SHAPE_NAMES[dominant]} — migrate the rest to match.`,
      });
    }

    return findings;
  },
};
