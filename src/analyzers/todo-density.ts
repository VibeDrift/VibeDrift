/**
 * TODO / FIXME / HACK density detector.
 *
 * Replaces the old "flat density > 2 per 1000 lines" rule with a per-file
 * Poisson outlier test. Models TODO arrivals as Poisson with rate λ = mean
 * TODOs per file across the project. A file with k TODOs is flagged if
 * P(X ≥ k | λ) < 0.05 — i.e. its count is in the upper-tail 5% given the
 * project-wide base rate.
 *
 * Why: the old rule misfired on small files (2 TODOs in a 200-line file
 * triggers an "error" at 10/1K even if it's the only notable cluster in
 * the project) and missed real outliers in large projects (10 TODOs in
 * 50k lines = 0.2/1K — silent despite being a pile).
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding } from "../core/types.js";
import { densityPer1K, getLineNumber } from "../utils/text.js";

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX|TEMP)\b/gi;
const POISSON_P_THRESHOLD = 0.05;

/**
 * Patterns that, if they appear within ±5 lines of a TODO, escalate
 * the TODO from an info-level ambient signal to a warning that names
 * the adjacent stub. These are the signals that suggested the TODO
 * is sitting next to actually-broken code, not just a scoped followup.
 */
const SUSPECT_ADJACENT_PATTERNS: RegExp[] = [
  // Placeholder return values (matches implementation-gap vocabulary).
  /\breturn\s+["'`](unvalidated|unimplemented|not\s+implemented|not\s+yet\s+implemented|todo|tbd|placeholder|stub|stubbed|fake|dummy)["'`]/i,
  // Placeholder field assignments (bare key kwargs shape).
  /\b\w+\s*[=:]\s*["'`](unvalidated|unimplemented|not\s+implemented|not\s+yet\s+implemented|todo|tbd|placeholder|stub|stubbed|fake|dummy)["'`]/i,
  // Placeholder field assignments (quoted key dict shape — Python dicts, JSON-like).
  /["']\w+["']\s*:\s*["'`](unvalidated|unimplemented|not\s+implemented|not\s+yet\s+implemented|todo|tbd|placeholder|stub|stubbed|fake|dummy)["'`]/i,
  // Explicit not-implemented language constructs.
  /\braise\s+NotImplementedError\b/,
  /\bthrow\s+new\s+Error\s*\(\s*["'`]Not\s+implemented/i,
  /\b(?:unimplemented|todo)\s*!\s*\(/,  // Rust
  /\bpanic\s*\(\s*["'`](?:not\s+implemented|unimplemented|todo)/i, // Go
];
const ADJACENCY_LINES = 5;

/**
 * P(X ≥ k | λ) for Poisson-distributed X.
 * Computed via the complement: 1 − P(X < k) = 1 − Σ_{i=0..k-1} e^-λ λ^i / i!
 * Iterative to avoid factorial overflow.
 */
function poissonUpperTail(k: number, lambda: number): number {
  if (k <= 0) return 1;
  if (lambda <= 0) return k > 0 ? 0 : 1;
  let term = Math.exp(-lambda); // P(X = 0)
  let cdf = term;
  for (let i = 1; i < k; i++) {
    term *= lambda / i; // P(X = i) from P(X = i−1)
    cdf += term;
  }
  return Math.max(0, 1 - cdf);
}

export const todoDensityAnalyzer: Analyzer = {
  id: "todo-density",
  name: "TODO/FIXME Density",
  category: "redundancy",
  requiresAST: false,
  applicableLanguages: "all",
  version: 2,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    let totalCount = 0;
    const fileHits: { file: string; count: number; lines: number[] }[] = [];
    // Collect TODOs that sit adjacent to suspect code (placeholder
    // returns, NotImplementedError, unreachable-style patterns). These
    // get their own high-severity finding separate from the Poisson
    // outlier path — one TODO next to a placeholder return is far more
    // actionable than 10 TODOs scattered across a messy module.
    const suspectAdjacent: {
      file: string;
      line: number;
      snippet: string;
      cause: string;
    }[] = [];

    for (const file of ctx.files) {
      const matches = [...file.content.matchAll(TODO_PATTERN)];
      if (matches.length === 0) continue;
      totalCount += matches.length;
      const fileLines = file.content.split("\n");
      const todoLineNumbers = matches.map((m) => getLineNumber(file.content, m.index!));
      fileHits.push({ file: file.relativePath, count: matches.length, lines: todoLineNumbers });

      // Cross-check each TODO's neighborhood for stub signals.
      for (const lineNum of todoLineNumbers) {
        const start = Math.max(0, lineNum - 1 - ADJACENCY_LINES);
        const end = Math.min(fileLines.length, lineNum - 1 + ADJACENCY_LINES + 1);
        const window = fileLines.slice(start, end).join("\n");
        for (const pattern of SUSPECT_ADJACENT_PATTERNS) {
          const m = window.match(pattern);
          if (m) {
            suspectAdjacent.push({
              file: file.relativePath,
              line: lineNum,
              snippet: (fileLines[lineNum - 1] ?? "").trim().slice(0, 80),
              cause: m[0].trim().slice(0, 80),
            });
            break; // one hit per TODO is enough to escalate
          }
        }
      }
    }

    if (totalCount === 0) return findings;

    // Escalation path: TODOs adjacent to stubs. Always at least
    // WARNING severity because these are the findings that would have
    // caught the `/v1/analyze` stub in 0.6.3 if anyone had scanned
    // the API repo. Clustering multiple occurrences escalates to
    // ERROR.
    if (suspectAdjacent.length > 0) {
      findings.push({
        analyzerId: "todo-density",
        severity: suspectAdjacent.length >= 3 ? "error" : "warning",
        confidence: 0.95,
        message: `${suspectAdjacent.length} TODO(s) sitting next to stub-shaped code (placeholder returns / NotImplementedError / panic). Likely unfinished implementations in production.`,
        locations: suspectAdjacent.slice(0, 10).map((s) => ({
          file: s.file,
          line: s.line,
          snippet: `${s.snippet} // adjacent: ${s.cause}`,
        })),
        tags: ["todo", "adjacent-stub"],
      });
    }

    // Poisson outlier detection per file. Requires at least 3 files to
    // estimate a meaningful rate.
    if (ctx.files.length >= 3) {
      const lambda = totalCount / ctx.files.length;
      const outliers = fileHits.filter(
        (h) => poissonUpperTail(h.count, lambda) < POISSON_P_THRESHOLD,
      );
      for (const hit of outliers) {
        const p = poissonUpperTail(hit.count, lambda);
        findings.push({
          analyzerId: "todo-density",
          severity: hit.count >= 10 ? "error" : "warning",
          confidence: 1.0,
          message: `${hit.count} TODOs clustered in ${hit.file} (project mean ${lambda.toFixed(1)}/file, p=${p.toExponential(1)})`,
          locations: hit.lines.slice(0, 10).map((l) => ({ file: hit.file, line: l })),
          tags: ["todo", "poisson-outlier"],
        });
      }
    }

    // Project-level info summary — contextualizes the outliers.
    const density = densityPer1K(totalCount, ctx.totalLines);
    findings.push({
      analyzerId: "todo-density",
      severity: "info",
      confidence: 1.0,
      message: `${totalCount} TODOs/FIXMEs across ${fileHits.length} files (density: ${density}/1K lines)`,
      locations: [],
      tags: ["todo", "summary"],
    });

    return findings;
  },
};
