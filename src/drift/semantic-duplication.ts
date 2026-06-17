/**
 * Semantic-duplication detector (MinHash + LSH on function bodies).
 *
 * Replaces the old Levenshtein-on-names approach (which only caught near-
 * identical names like getUser/getUsers and missed real semantic duplicates
 * with completely different names like formatCurrency / toUSD).
 *
 * How it catches the rename-refactor case:
 *   formatCurrency(n)           toUSD(x)
 *   const f = new Intl. ...     const f = new Intl. ...
 *   return f.format(n);         return f.format(x);
 *   --                          --
 *   After normalization (call targets preserved):
 *   const ID0 = new Intl. ...   const ID0 = new Intl. ...
 *   return ID0 . format ( ID1 ) return ID0 . format ( ID1 )
 *   --
 *   Token-identical → MinHash signatures collide in every band → LSH pair
 *   → LCS verification = 1.0 → flagged as semantic duplicate.
 *
 * What it doesn't catch (intentional):
 *   - functions calling DIFFERENT APIs but with the same control flow
 *     (e.g. db.query vs Repository.find with identical wrappers). The
 *     call-target preservation in normalizeTokens keeps `db . query` and
 *     `Repository . find` literally different, so they don't collide.
 *
 * Aggregation: per-directory rollup. A directory with multiple duplicate
 * pairs is a stronger drift signal than a single pair across the project.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, DeviatingFile, Evidence } from "./types.js";
import { extractFunctionsFromFile } from "../codedna/function-extractor.js";
import type { ExtractedFunction } from "../codedna/types.js";
import {
  buildSignature,
  findLshCandidatePairs,
  lcsSimilarity,
} from "../codedna/minhash.js";
import { directoryOf, isAnalyzableSource } from "./utils.js";

interface IndexedFunction {
  fn: ExtractedFunction;
  tokens: string[];
  signature: Uint32Array;
}

const FLAG_THRESHOLD = 0.7;
const MIN_BODY_TOKENS = 15;

function indexFunctions(files: DriftFile[]): IndexedFunction[] {
  const out: IndexedFunction[] = [];
  for (const file of files) {
    if (!file.language) continue;
    if (!isAnalyzableSource(file.path)) continue;

    const adapted = {
      path: file.path,
      relativePath: file.path,
      language: file.language as ExtractedFunction["language"],
      content: file.content,
      lineCount: file.lineCount,
    };
    const extracted = extractFunctionsFromFile(adapted);
    for (const fn of extracted) {
      const sig = buildSignature(fn.rawBody);
      if (sig.tokens.length < MIN_BODY_TOKENS) continue;
      out.push({ fn, tokens: sig.tokens, signature: sig.signature });
    }
  }
  return out;
}

interface DuplicatePair {
  a: IndexedFunction;
  b: IndexedFunction;
  similarity: number;
}

function findDuplicatePairs(indexed: IndexedFunction[]): DuplicatePair[] {
  const signatures = indexed.map((i) => i.signature);
  const candidates = findLshCandidatePairs(signatures);
  const pairs: DuplicatePair[] = [];
  for (const key of candidates) {
    const [aStr, bStr] = key.split("-");
    const a = indexed[parseInt(aStr, 10)];
    const b = indexed[parseInt(bStr, 10)];
    // Cross-file only — same-file pairs are usually overloads/variants
    if (a.fn.file === b.fn.file) continue;

    const shorter = Math.min(a.tokens.length, b.tokens.length);
    const longer = Math.max(a.tokens.length, b.tokens.length);
    if (shorter / longer < 0.6) continue;

    const sim = lcsSimilarity(a.tokens, b.tokens);
    if (sim >= FLAG_THRESHOLD) {
      pairs.push({ a, b, similarity: sim });
    }
  }
  return pairs;
}

function dedupePairs(pairs: DuplicatePair[]): DuplicatePair[] {
  const seen = new Set<string>();
  return pairs
    .sort((x, y) => y.similarity - x.similarity)
    .filter((p) => {
      const key = [
        p.a.fn.file + ":" + p.a.fn.name,
        p.b.fn.file + ":" + p.b.fn.name,
      ].sort().join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export const semanticDuplication: DriftDetector = {
  id: "semantic-duplication",
  name: "Semantic Function Duplication",
  category: "semantic_duplication",

  detect(ctx: DriftContext): DriftFinding[] {
    const indexed = indexFunctions(ctx.files);
    if (indexed.length < 2) return [];

    const pairs = dedupePairs(findDuplicatePairs(indexed));
    if (pairs.length === 0) return [];

    // Group pairs by directory — the directory that owns the higher-numbered
    // duplicate is where we attribute the drift.
    const byDir = new Map<string, DuplicatePair[]>();
    for (const p of pairs) {
      // Each pair contributes to BOTH directories (both files are duplicates).
      const dirs = new Set([directoryOf(p.a.fn.file), directoryOf(p.b.fn.file)]);
      for (const dir of dirs) {
        const list = byDir.get(dir);
        if (list) list.push(p);
        else byDir.set(dir, [p]);
      }
    }

    const findings: DriftFinding[] = [];
    const dirs = [...byDir.keys()].sort();
    for (const dir of dirs) {
      const dirPairs = byDir.get(dir)!;
      const deviating: DeviatingFile[] = [];
      const seenFiles = new Set<string>();
      for (const p of dirPairs) {
        for (const fn of [p.a.fn, p.b.fn]) {
          if (directoryOf(fn.file) !== dir) continue;
          if (seenFiles.has(fn.file)) continue;
          seenFiles.add(fn.file);
          const partner = fn === p.a.fn ? p.b.fn : p.a.fn;
          const evidence: Evidence[] = [{
            line: fn.line,
            code: `${fn.name}() — ${Math.round(p.similarity * 100)}% similar to ${partner.name}() at ${partner.relativePath}:${partner.line}`,
          }];
          deviating.push({
            path: fn.file,
            detectedPattern: "duplicate function body",
            evidence,
          });
        }
      }
      if (deviating.length === 0) continue;

      findings.push({
        detector: "semantic-duplication",
        subCategory: "function_body",
        driftCategory: "semantic_duplication",
        severity: deviating.length >= 5 ? "error" : "warning",
        confidence: 0.85,
        finding: `${dir}/: ${dirPairs.length} pair(s) of semantically duplicate functions detected (MinHash + LCS verified)`,
        dominantPattern: "unique function bodies",
        dominantCount: 0,
        totalRelevantFiles: deviating.length,
        consistencyScore: Math.max(0, 100 - dirPairs.length * 10),
        deviatingFiles: deviating.slice(0, 10),
        // Semantic-duplication's "dominant" is "unique function bodies" —
        // an abstract property, not a set of reference files. Leave empty.
        dominantFiles: [],
        recommendation: `Consolidate the ${dirPairs.length} duplicate(s) in ${dir}/ into a single shared implementation.`,
      });
    }

    return findings;
  },
};
