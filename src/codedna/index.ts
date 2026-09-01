import type { AnalysisContext, Finding } from "../core/types.js";
import type { CodeDnaResult, DeviationJustification } from "./types.js";
import { extractAllFunctions } from "./function-extractor.js";
import { computeSemanticFingerprints, findDuplicateGroups, fingerprintFindings } from "./semantic-fingerprint.js";
import { extractOperationSequences, findSequenceSimilarities } from "./operation-sequence.js";
import { classifyPatterns, patternFindings } from "./pattern-classifier.js";
import { analyzeTaintFlows, taintFindings } from "./taint-analysis.js";
import { scoreDeviations, deviationFindings } from "./deviation-heuristics.js";

/**
 * `codedna-pattern` and `codedna-deviation` are two readings of ONE event.
 *
 * The deviation heuristics run over exactly the files the pattern classifier
 * already flagged as deviating, and only decide WHY (accidental vs justified).
 * Emitting both meant the same deviating file produced two
 * architecturalConsistency drift findings from two different analyzer ids, and
 * the scoring engine's noisy-OR multiplies over DETECTORS — so one file's single
 * deviation was counted as two independent patterns drifting, damaging the
 * category twice over.
 *
 * The pattern finding is the one that keeps its place (it carries the vote and
 * the evidence locations); the justification VERDICT is folded into its message
 * and tags so nothing the deviation finding said is lost from the report. A
 * deviation finding for a file the pattern detector did NOT flag still stands on
 * its own.
 */
export function mergePatternAndDeviation(
  patternFindingList: Finding[],
  deviationFindingList: Finding[],
  justifications: DeviationJustification[],
): Finding[] {
  const byPath = new Map(justifications.map((j) => [j.relativePath, j]));
  const flagged = new Set<string>();

  const enrichedPattern = patternFindingList.map((f) => {
    if (!f.tags?.includes("drift")) return f;
    const path = f.locations[0]?.file;
    if (!path) return f;
    flagged.add(path);
    const j = byPath.get(path);
    if (!j || j.verdict !== "likely_accidental") return f;
    const evidence = j.signals
      .filter((s) => s.present && s.weight !== 0)
      .map((s) => s.evidence)
      .filter(Boolean)
      .join("; ");
    return {
      ...f,
      message: `${f.message} — looks accidental${evidence ? `: ${evidence}` : ""}`,
      tags: [...(f.tags ?? []), "accidental"],
    };
  });

  return [
    ...enrichedPattern,
    ...deviationFindingList.filter((d) => !flagged.has(d.locations[0]?.file ?? "")),
  ];
}

export function runCodeDnaAnalysis(ctx: AnalysisContext): CodeDnaResult {
  const timings = {
    extractionMs: 0,
    fingerprintMs: 0,
    sequenceMs: 0,
    patternMs: 0,
    taintMs: 0,
    deviationMs: 0,
    totalMs: 0,
  };

  const totalStart = Date.now();

  // 1. Extract all functions (shared across modules)
  let t = Date.now();
  const functions = extractAllFunctions(ctx.files);
  timings.extractionMs = Date.now() - t;

  // 2. Semantic fingerprinting (Module 1)
  t = Date.now();
  const fingerprints = computeSemanticFingerprints(functions);
  const duplicateGroups = findDuplicateGroups(fingerprints, functions);
  timings.fingerprintMs = Date.now() - t;

  // 3. Operation sequence analysis (Module 2)
  t = Date.now();
  const sequences = extractOperationSequences(functions);
  const sequenceSimilarities = findSequenceSimilarities(sequences, functions);
  timings.sequenceMs = Date.now() - t;

  // 4. Pattern classification (Module 3)
  t = Date.now();
  const patternDistributions = classifyPatterns(ctx.files);
  timings.patternMs = Date.now() - t;

  // 5. Taint analysis (Module 4)
  t = Date.now();
  const taintFlows = analyzeTaintFlows(functions);
  timings.taintMs = Date.now() - t;

  // 6. Deviation heuristics (Module 5) — uses pattern distributions
  t = Date.now();
  const deviationJustifications = scoreDeviations(patternDistributions, ctx.files);
  timings.deviationMs = Date.now() - t;

  // Aggregate all findings.
  //
  // Operation-sequence similarities are deliberately NOT surfaced as findings.
  // They measure workflow-SHAPE similarity (the abstract opcode LCS), which is a
  // consistency signal, not evidence of duplicate logic: sibling command
  // handlers legitimately share load->validate->log->return, so surfacing them
  // as "near-duplicate" pairs conflates correct consistency with redundancy and
  // is a systematic false-positive source (e.g. runDoctor vs runLogout). Genuine
  // duplicates are caught by the body-level detectors (fingerprint, 98.7%
  // precision, + MinHash/LCS in drift/semantic-duplication). The
  // `sequenceSimilarities` data is retained on the result for the drift signal
  // and the deep-scan tease, just not as a user-facing duplicate finding.
  const findings: Finding[] = [
    ...fingerprintFindings(duplicateGroups),
    ...mergePatternAndDeviation(
      patternFindings(patternDistributions),
      deviationFindings(deviationJustifications),
      deviationJustifications,
    ),
    ...taintFindings(taintFlows),
  ];

  timings.totalMs = Date.now() - totalStart;

  return {
    functions,
    fingerprints,
    duplicateGroups,
    sequenceSimilarities,
    patternDistributions,
    taintFlows,
    deviationJustifications,
    findings,
    timings,
  };
}
