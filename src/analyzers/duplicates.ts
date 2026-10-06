/**
 * Duplicate / near-duplicate function detector.
 *
 * Thin wrapper around the shared MinHash + LSH pipeline in
 * src/codedna/minhash.ts. The shared module handles tokenization,
 * normalization (with call-target preservation), shingling, MinHash
 * signatures, LSH bucket discovery, and LCS verification. This file
 * handles function extraction and finding emission.
 *
 * See `src/codedna/minhash.ts` for the full algorithm and collision-
 * probability table.
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding } from "../core/types.js";
import {
  buildSignature,
  findLshCandidatePairs,
  lcsSimilarity,
} from "../codedna/minhash.js";
import { extractFunctionsFromFile } from "../codedna/function-extractor.js";

interface FunctionRecord {
  file: string;
  line: number;
  funcName: string;
  tokens: string[];
  signature: Uint32Array;
}

/**
 * Function discovery goes through the shared extractor
 * (src/codedna/function-extractor.ts), the same one the fingerprint tier,
 * baselines, and the MCP tools use: it skips optional return-type
 * annotations before locating the body, so typed TypeScript functions are
 * seen at all (#88). Scoring below is unchanged: the analyzer still builds
 * its own signatures from the extracted body and keeps its own floors.
 */
function extractFunctions(file: AnalysisContext["files"][number]): FunctionRecord[] {
  const out: FunctionRecord[] = [];
  for (const fn of extractFunctionsFromFile(file)) {
    const body = fn.rawBody;
    if (body.length < 20) continue;

    const sig = buildSignature(body);
    if (sig.tokens.length < 15) continue;

    out.push({
      file: fn.relativePath,
      line: fn.line,
      funcName: fn.name,
      tokens: sig.tokens,
      signature: sig.signature,
    });
  }
  return out;
}

const FLAG_THRESHOLD = 0.7;

export const duplicatesAnalyzer: Analyzer = {
  id: "duplicates",
  name: "Code Duplication",
  category: "redundancy",
  requiresAST: false,
  applicableLanguages: "all",
  // Bumped when detection changes. Invalidates the S1 findings cache.
  // v4: extraction moved to the shared extractor (typed TS/Python, methods,
  // generics, let/var arrows newly seen; throw-only stub bodies now filtered).
  version: 4,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const allFunctions: FunctionRecord[] = [];

    for (const file of ctx.files) {
      if (!file.language) continue;
      allFunctions.push(...extractFunctions(file));
    }

    if (allFunctions.length < 2) return findings;

    const signatures = allFunctions.map((f) => f.signature);
    const candidates = findLshCandidatePairs(signatures);

    const duplicatePairs: { a: FunctionRecord; b: FunctionRecord; similarity: number }[] = [];
    for (const key of candidates) {
      const [aStr, bStr] = key.split("-");
      const a = allFunctions[parseInt(aStr, 10)];
      const b = allFunctions[parseInt(bStr, 10)];
      if (a.file === b.file) continue;

      const shorter = Math.min(a.tokens.length, b.tokens.length);
      const longer = Math.max(a.tokens.length, b.tokens.length);
      if (shorter / longer < 0.6) continue;

      const sim = lcsSimilarity(a.tokens, b.tokens);
      if (sim >= FLAG_THRESHOLD) {
        duplicatePairs.push({ a, b, similarity: sim });
      }
    }

    if (duplicatePairs.length === 0) return findings;

    const seenPairs = new Set<string>();
    const uniquePairs = duplicatePairs
      .sort((x, y) => y.similarity - x.similarity)
      .filter((p) => {
        const key = [
          p.a.file + ":" + p.a.funcName,
          p.b.file + ":" + p.b.funcName,
        ].sort().join("|");
        if (seenPairs.has(key)) return false;
        seenPairs.add(key);
        return true;
      });

    findings.push({
      analyzerId: "duplicates",
      severity: uniquePairs.length > 5 ? "error" : "warning",
      confidence: 0.75,
      message: `${uniquePairs.length} pair(s) of duplicate/near-duplicate functions detected`,
      locations: uniquePairs.slice(0, 10).flatMap((p) => {
        const sim = Math.round(p.similarity * 100);
        const aLabel = p.a.funcName === p.b.funcName
          ? `${p.a.file}:${p.a.funcName}()`
          : `${p.a.funcName}()`;
        const bLabel = p.b.funcName === p.a.funcName
          ? `${p.b.file}:${p.b.funcName}()`
          : `${p.b.funcName}()`;
        return [
          { file: p.a.file, line: p.a.line, snippet: `${aLabel} — ${sim}% similar to ${bLabel}` },
          { file: p.b.file, line: p.b.line, snippet: `${bLabel} — ${sim}% similar to ${aLabel}` },
        ];
      }),
      tags: ["duplicates", "token-based", "verified-by-lcs"],
    });

    return findings;
  },
};
