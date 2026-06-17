import type { AnalysisContext, Finding } from "../core/types.js";
import type { CodeDnaResult } from "./types.js";
import { extractAllFunctions } from "./function-extractor.js";
import { computeSemanticFingerprints, findDuplicateGroups, fingerprintFindings } from "./semantic-fingerprint.js";
import { extractOperationSequences, findSequenceSimilarities, sequenceFindings } from "./operation-sequence.js";
import { classifyPatterns, patternFindings } from "./pattern-classifier.js";
import { analyzeTaintFlows, taintFindings } from "./taint-analysis.js";
import { scoreDeviations, deviationFindings } from "./deviation-heuristics.js";

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

  // Aggregate all findings
  const findings: Finding[] = [
    ...fingerprintFindings(duplicateGroups),
    ...sequenceFindings(sequenceSimilarities),
    ...patternFindings(patternDistributions),
    ...taintFindings(taintFlows),
    ...deviationFindings(deviationJustifications),
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
