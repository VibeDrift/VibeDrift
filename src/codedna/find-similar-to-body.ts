/**
 * One-vs-N near-duplicate search for a single function body against a cached
 * index of function token-streams. Uses the low-level MinHash primitives
 * directly (buildSignature → tokens, then exact LCS verify) rather than
 * sampler.ts's band helper, which caps at SIMILARITY_BAND_HIGH (0.80) to
 * EXCLUDE obvious clones — here we want the full range, including exact dups.
 */
import { buildSignature, lcsSimilarity } from "./minhash.js";

export interface SimIndexEntry {
  relativePath: string;
  name: string;
  line: number;
  tokens: string[];
}

export interface SimMatch {
  relativePath: string;
  name: string;
  line: number;
  similarity: number;
}

export function findSimilarToBody(
  body: string,
  index: SimIndexEntry[],
  opts: { threshold: number; cap: number },
): SimMatch[] {
  const q = buildSignature(body);
  const out: SimMatch[] = [];
  for (const e of index) {
    const sim = lcsSimilarity(q.tokens, e.tokens);
    if (sim >= opts.threshold) {
      out.push({
        relativePath: e.relativePath,
        name: e.name,
        line: e.line,
        similarity: Number(sim.toFixed(3)),
      });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, opts.cap);
}
