/**
 * judge.ts — Blinded convention judge (pure logic).
 *
 * The judge scores an agent's source diff against a task's ground-truth
 * conventionTargets. It is the experiment's OUTCOME INSTRUMENT and is
 * independent of VibeDrift's own detectors (no "grading its own homework").
 *
 * Blinding: the judge input carries only the conventionTargets and the diff.
 * It never sees the arm, the .mcp.json, the injected CLAUDE.md directive, or
 * .vibedrift/ (those are excluded upstream by captureDiff). buildJudgePrompt
 * additionally names no tool/product, so a judge cannot infer the arm.
 *
 * The metered `claude -p` JudgeFn lives in judge-real.ts; everything here is
 * pure and unit-tested.
 */

import type { ConventionTarget } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What a single judge is shown. No arm, repo, or tool identity. */
export interface JudgeInput {
  taskId: string;
  conventionTargets: ConventionTarget[];
  /** The blinded agent source diff. */
  diff: string;
}

/** One judge's raw verdict. score scale: 2 = matches, 1 = partial, 0 = violates. */
export interface JudgeVerdict {
  /** One score per conventionTarget, in target order. */
  targetScores: number[];
  /** Holistic "does this change fit the surrounding codebase" score (0|1|2). */
  holistic: number;
  notes: string;
}

/** Aggregated drift score for one run, across the judge panel. */
export interface RunDriftScore {
  runId: string;
  nJudges: number; // judges that returned a usable verdict
  nJudgeFailures: number; // judges whose output could not be parsed
  /** Mean normalized target drift in [0,1] (0 = perfect adherence, 1 = full drift). */
  driftScore: number;
  /** Mean normalized holistic drift in [0,1]. */
  holisticDrift: number;
  /** Per-judge normalized target drift (length = nJudges). */
  perJudgeDrift: number[];
  /** Standard deviation of perJudgeDrift (lower = more judge agreement). */
  judgeStdev: number;
  /** Mean normalized drift per axis, averaged over judges and same-axis targets. */
  driftByAxis: Record<string, number>;
}

/** A judge implementation. Real one calls claude -p (metered); fakes in tests. */
export type JudgeFn = (input: JudgeInput) => Promise<string>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Build the blinded judge prompt. Names no tool/product/arm. Asks for STRICT
 * JSON only so the output is machine-parseable.
 */
export function buildJudgePrompt(input: JudgeInput): string {
  const targetLines = input.conventionTargets
    .map(
      (t, i) =>
        `${i + 1}. [${t.axis}] ${t.expectation} (repo convention: ${t.rationale})`,
    )
    .join("\n");

  return `You are a senior engineer judging whether a code change follows a repository's established conventions. You are given a list of CONVENTION TARGETS the change should satisfy (each derived from how this repository already does things) and a unified DIFF of the change (source edits only).

For EACH target, score how well the diff satisfies it:
  2 = fully matches the expectation
  1 = partial or ambiguous
  0 = violates it (e.g. reimplements something that should have been reused, or uses a different naming/error/import style than the repo's)

Also give ONE holistic score (0, 1, or 2) for how well the change fits the surrounding codebase overall.

Respond with STRICT JSON only — no prose, no code fences — in exactly this shape, with one entry per target in the SAME ORDER as listed:
{"targetScores":[<int 0-2>, ...], "holistic":<int 0-2>, "notes":"<= 200 chars"}

CONVENTION TARGETS (${input.conventionTargets.length}):
${targetLines}

DIFF:
${input.diff || "(empty diff — the change made no source edits)"}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Clamp a value to an integer in {0,1,2}; non-numbers throw. */
function clampScore(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`non-numeric score: ${JSON.stringify(v)}`);
  }
  const r = Math.round(v);
  return r < 0 ? 0 : r > 2 ? 2 : r;
}

/**
 * Parse a judge's raw output into a JudgeVerdict. Tolerates surrounding prose
 * and ```json fences by extracting the first balanced {...} object. Validates
 * that targetScores has exactly nTargets entries. Throws on unrecoverable output
 * (the panel runner drops that judge).
 */
export function parseJudgeVerdict(raw: string, nTargets: number): JudgeVerdict {
  const obj = extractFirstJsonObject(raw);
  if (!obj || typeof obj !== "object") {
    throw new Error("no JSON object found in judge output");
  }
  const rec = obj as Record<string, unknown>;
  const scoresRaw = rec.targetScores;
  if (!Array.isArray(scoresRaw)) {
    throw new Error("targetScores is not an array");
  }
  if (scoresRaw.length !== nTargets) {
    throw new Error(
      `targetScores length ${scoresRaw.length} !== nTargets ${nTargets}`,
    );
  }
  const targetScores = scoresRaw.map(clampScore);
  const holistic = clampScore(rec.holistic);
  const notes = typeof rec.notes === "string" ? rec.notes.slice(0, 200) : "";
  return { targetScores, holistic, notes };
}

/** Extract and parse the first balanced top-level JSON object from a string. */
function extractFirstJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Normalize a 0|1|2 adherence score to drift in [0,1] (2 -> 0, 0 -> 1). */
function toDrift(score: number): number {
  return (2 - score) / 2;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

/**
 * Run the judge panel for one run and aggregate to a RunDriftScore.
 *
 * Calls judgeFn nJudges times (independent verdicts), parses each, drops
 * unparseable ones, and aggregates the survivors. If ALL judges fail, returns a
 * score with nJudges=0 and driftScore=NaN-safe 0 flagged via nJudgeFailures.
 */
export async function runJudgePanel(
  runId: string,
  input: JudgeInput,
  judgeFn: JudgeFn,
  nJudges: number,
): Promise<RunDriftScore> {
  const nTargets = input.conventionTargets.length;
  const verdicts: JudgeVerdict[] = [];
  let failures = 0;

  for (let j = 0; j < nJudges; j++) {
    try {
      const raw = await judgeFn(input);
      verdicts.push(parseJudgeVerdict(raw, nTargets));
    } catch {
      failures++;
    }
  }

  const perJudgeDrift = verdicts.map((v) => mean(v.targetScores.map(toDrift)));
  const holisticDrifts = verdicts.map((v) => toDrift(v.holistic));

  // Per-axis: average drift over judges and over same-axis targets.
  const driftByAxis: Record<string, number> = {};
  if (verdicts.length > 0) {
    const axisAccum: Record<string, number[]> = {};
    for (const v of verdicts) {
      input.conventionTargets.forEach((t, idx) => {
        (axisAccum[t.axis] ??= []).push(toDrift(v.targetScores[idx]));
      });
    }
    for (const [axis, vals] of Object.entries(axisAccum)) {
      driftByAxis[axis] = mean(vals);
    }
  }

  return {
    runId,
    nJudges: verdicts.length,
    nJudgeFailures: failures,
    driftScore: mean(perJudgeDrift),
    holisticDrift: mean(holisticDrifts),
    perJudgeDrift,
    judgeStdev: stdev(perJudgeDrift),
    driftByAxis,
  };
}
