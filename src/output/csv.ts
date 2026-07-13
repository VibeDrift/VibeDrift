/**
 * CSV report renderer for VibeDrift scan results.
 *
 * Produces a multi-section CSV document covering summary stats, category scores,
 * drift findings, Code DNA results (duplicates, taint flows, pattern distributions),
 * per-file scores, and deep insights. Designed for spreadsheet import and CI
 * artifact archiving.
 */

import type { ScanResult } from "../core/types.js";

function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function row(...cells: (string | number)[]): string {
  return cells.map((c) => csvEscape(String(c))).join(",");
}

function csvMetadata(result: ScanResult): string[] {
  return [
    "VIBEDRIFT REPORT",
    row("Project", result.context.rootDir.split("/").pop() ?? ""),
    row("Files Scanned", result.context.files.length),
    row("Total Lines", result.context.totalLines),
    row("Scan Time (ms)", result.scanTimeMs),
    row("Composite Score", result.compositeScore),
    row("Max Score", result.maxCompositeScore),
    "",
  ];
}

function csvScoreCategories(result: ScanResult): string[] {
  const lines: string[] = [];
  lines.push("CATEGORY SCORES");
  lines.push(row("Category", "Score", "Max Score", "Finding Count"));
  for (const [key, val] of Object.entries(result.scores)) {
    lines.push(row(key, val.score, val.maxScore, val.findingCount));
  }
  lines.push("");

  const ds = result.driftScores ?? {};
  if (Object.keys(ds).length > 0) {
    // securityPosture N/A on the floored composite (result.scores) means every
    // security drift finding was below the peer floor and demoted to advisory.
    // The driftScores breakdown credits an empty category full health
    // (security_posture -> 14/14, 0 findings), which would still read as a
    // scored bar next to the composite's N/A. Suppress that one row to match.
    const securityIsNa = result.scores.securityPosture?.applicable === false;
    lines.push("DRIFT SCORES");
    lines.push(row("Category", "Score", "Max Score", "Findings", "Grade"));
    for (const [key, val] of Object.entries(ds)) {
      if (key === "composite" || key === "grade") continue;
      if (key === "security_posture" && securityIsNa) continue;
      const v = val as any;
      if (v?.score !== undefined) {
        lines.push(row(key, v.score, v.maxScore, v.findings ?? 0));
      }
    }
    lines.push("");
  }
  return lines;
}

function csvDriftFindings(result: ScanResult): string[] {
  // result.driftFindings already excludes below-floor route-consistency
  // security findings (scoredDriftView at the scan source), so a thin finding
  // is never listed as a scored drift finding here.
  const driftFindings = result.driftFindings ?? [];
  if (driftFindings.length === 0) return [];
  const lines: string[] = [];
  lines.push("DRIFT FINDINGS");
  lines.push(row("Severity", "Category", "Finding", "Dominant Pattern", "Dominant Count", "Total Files", "Consistency %", "Deviating Files", "Recommendation"));
  for (const d of driftFindings) {
    const devFiles = d.deviatingFiles.map((f) => f.path).join("; ");
    lines.push(row(
      d.severity, d.driftCategory, d.finding,
      d.dominantPattern, d.dominantCount, d.totalRelevantFiles, d.consistencyScore,
      devFiles, d.recommendation,
    ));
  }
  lines.push("");
  return lines;
}

function csvDuplicateGroups(dna: any): string[] {
  if (!dna.duplicateGroups?.length) return [];
  const lines: string[] = [];
  lines.push("CODE DNA: SEMANTIC DUPLICATES");
  lines.push(row("Group", "Functions", "Files"));
  for (const g of dna.duplicateGroups) {
    const fns = g.functions.map((f: any) => f.name + "()").join("; ");
    const files = g.functions.map((f: any) => f.relativePath || f.file).join("; ");
    lines.push(row(g.groupId, fns, files));
  }
  lines.push("");
  return lines;
}

function csvSequenceSimilarities(dna: any): string[] {
  if (!dna.sequenceSimilarities?.length) return [];
  const lines: string[] = [];
  lines.push("CODE DNA: OPERATION SEQUENCE MATCHES");
  lines.push(row("Function A", "File A", "Function B", "File B", "Similarity %"));
  for (const s of dna.sequenceSimilarities) {
    lines.push(row(
      s.functionA.name, s.functionA.relativePath || s.functionA.file,
      s.functionB.name, s.functionB.relativePath || s.functionB.file,
      Math.round(s.similarity * 100),
    ));
  }
  lines.push("");
  return lines;
}

function csvTaintFlows(dna: any): string[] {
  if (!dna.taintFlows?.length) return [];
  const lines: string[] = [];
  lines.push("CODE DNA: TAINT FLOWS");
  lines.push(row("File", "Function", "Source Type", "Source Line", "Sink Type", "Sink Line", "Sanitized"));
  for (const t of dna.taintFlows) {
    lines.push(row(
      t.relativePath || t.file, t.functionName,
      t.source.type, t.source.line, t.sink.type, t.sink.line,
      t.sanitized ? "Yes" : "No",
    ));
  }
  lines.push("");
  return lines;
}

function csvDeviations(dna: any): string[] {
  if (!dna.deviationJustifications?.length) return [];
  const lines: string[] = [];
  lines.push("CODE DNA: DEVIATION ANALYSIS");
  lines.push(row("File", "Deviating Pattern", "Dominant Pattern", "Verdict", "Score"));
  for (const dj of dna.deviationJustifications) {
    lines.push(row(
      dj.relativePath || dj.file, dj.deviatingPattern, dj.dominantPattern,
      dj.verdict, Math.round(dj.justificationScore * 100),
    ));
  }
  lines.push("");
  return lines;
}

function csvPatterns(dna: any): string[] {
  if (!dna.patternDistributions?.length) return [];
  const lines: string[] = [];
  lines.push("CODE DNA: PATTERN DISTRIBUTIONS");
  lines.push(row("File", "Dominant Pattern", "Confidence", "Internally Inconsistent"));
  for (const pd of dna.patternDistributions) {
    lines.push(row(
      pd.relativePath || pd.file, pd.dominantPattern,
      Math.round(pd.confidence * 100), pd.isInternallyInconsistent ? "Yes" : "No",
    ));
  }
  lines.push("");
  return lines;
}

function csvCodeDna(result: ScanResult): string[] {
  const dna = result.codeDnaResult;
  if (!dna) return [];
  return [
    ...csvDuplicateGroups(dna),
    ...csvSequenceSimilarities(dna),
    ...csvTaintFlows(dna),
    ...csvDeviations(dna),
    ...csvPatterns(dna),
  ];
}

function csvFindings(result: ScanResult): string[] {
  const lines: string[] = [];
  lines.push("ALL FINDINGS");
  lines.push(row("Severity", "Analyzer", "Confidence %", "Message", "File", "Line", "Tags"));
  for (const f of result.findings) {
    const loc = f.locations[0];
    lines.push(row(
      f.severity, f.analyzerId, Math.round(f.confidence * 100),
      f.message, loc?.file ?? "", loc?.line ?? "",
      (f.tags ?? []).join("; "),
    ));
  }
  lines.push("");
  return lines;
}

function csvPerFileScores(result: ScanResult): string[] {
  const lines: string[] = [];
  lines.push("PER-FILE SCORES");
  lines.push(row("File", "Score", "Finding Count"));
  const fileSorted = [...result.perFileScores.entries()].sort((a, b) => a[1].score - b[1].score);
  for (const [path, data] of fileSorted) {
    lines.push(row(path, data.score, data.findings.length));
  }
  lines.push("");
  return lines;
}

function csvAiSummary(result: ScanResult): string[] {
  if ((result.deepInsights ?? []).length === 0) return [];
  const lines: string[] = [];
  lines.push("DEEP ANALYSIS INSIGHTS");
  lines.push(row("Category", "Severity", "Title", "Description", "Related Files", "Recommendation"));
  for (const ins of result.deepInsights) {
    lines.push(row(
      ins.category, ins.severity, ins.title, ins.description,
      ins.relatedFiles.join("; "), ins.recommendation ?? "",
    ));
  }
  return lines;
}

export function renderCsvReport(result: ScanResult): string {
  return [
    ...csvMetadata(result),
    ...csvScoreCategories(result),
    ...csvDriftFindings(result),
    ...csvCodeDna(result),
    ...csvFindings(result),
    ...csvPerFileScores(result),
    ...csvAiSummary(result),
  ].join("\n");
}
