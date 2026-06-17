import type { Finding } from "../core/types.js";
import type { ExtractedFunction } from "../codedna/types.js";
import type { MlFunctionPayload } from "./types.js";
import { buildSignature, findLshCandidatePairs, lcsSimilarity } from "../codedna/minhash.js";

const MAX_FUNCTIONS = 30;
const MAX_LINES_PER_FUNCTION = 60;

/**
 * Functions whose nearest peer's LCS similarity sits in this band are the
 * ambiguous near-duplicates an embedding/LLM judge actually disambiguates:
 * too alike to be unrelated, not alike enough to be an obvious exact clone
 * (exact clones are already caught locally by Code DNA). These are the
 * highest-value deep-scan candidates, so both members of every in-band pair
 * are seeded into the sample regardless of the keyword/size heuristic.
 *
 * Was: the sampler picked the 30 biggest files named index/app/server, which
 * could drop the actual drift candidates entirely (audit DEEP-03).
 */
export const SIMILARITY_BAND_LOW = 0.55;
export const SIMILARITY_BAND_HIGH = 0.8;

// The sampler is RECALL-oriented: it wants to surface the ambiguous near-
// duplicate band that the precision-tuned semantic-duplication detector
// (default 16 bands × 8 rows ≈ 0.68 Jaccard collision threshold) deliberately
// excludes. That band ([0.55, 0.80] LCS) sits BELOW the default threshold, so
// routing through the default LSH config would almost never fire. A wider,
// shallower config (32 bands × 4 rows ≈ 0.42 Jaccard threshold) surfaces those
// pairs; the LCS band filter below then keeps only the genuinely ambiguous
// ones. 32×4 = 128 = DEFAULT_PERMUTATIONS, so signatures need no rebuild.
const SAMPLER_LSH_BANDS = 32;
const SAMPLER_LSH_ROWS = 4;

/**
 * Indices of functions that are a member of at least one candidate pair whose
 * LCS similarity falls in [SIMILARITY_BAND_LOW, SIMILARITY_BAND_HIGH]. Reuses
 * the MinHash signatures from the same pipeline as the semantic-duplication
 * detector, but with a recall-oriented LSH config (see above).
 */
export function functionsInSimilarityBand(functions: ExtractedFunction[]): Set<number> {
  const inBand = new Set<number>();
  if (functions.length < 2) return inBand;
  const sigs = functions.map((fn) => buildSignature(fn.rawBody));
  const pairs = findLshCandidatePairs(
    sigs.map((s) => s.signature),
    SAMPLER_LSH_BANDS,
    SAMPLER_LSH_ROWS,
  );
  for (const key of pairs) {
    const dash = key.indexOf("-");
    const i = Number(key.slice(0, dash));
    const j = Number(key.slice(dash + 1));
    const sim = lcsSimilarity(sigs[i].tokens, sigs[j].tokens);
    if (sim >= SIMILARITY_BAND_LOW && sim <= SIMILARITY_BAND_HIGH) {
      inBand.add(i);
      inBand.add(j);
    }
  }
  return inBand;
}

export function sampleFunctionsForMl(
  functions: ExtractedFunction[],
  findings: Finding[],
): MlFunctionPayload[] {
  // Similarity-band routing: the ambiguous near-duplicate pairs are the cases
  // the deep-scan judge exists to resolve, so they outrank the heuristic.
  const bandIndices = functionsInSimilarityBand(functions);

  // Score functions by importance
  const scored = functions.map((fn, idx) => {
    let score = 0;

    // Ambiguous near-duplicate (similarity band) — top priority. The +100
    // guarantees both members survive the MAX_FUNCTIONS cap.
    if (bandIndices.has(idx)) score += 100;

    // Entry point files are high priority
    if (/(?:main|index|app|server|lib|mod)\./i.test(fn.file)) score += 10;

    // Files with existing findings
    const fnFindings = findings.filter((f) =>
      f.locations.some((l) => l.file === fn.relativePath),
    );
    score += fnFindings.length * 3;

    // Larger functions are more interesting
    const bodyLines = fn.rawBody.split("\n").length;
    score += Math.min(bodyLines / 20, 5);

    // Handler/service files
    if (/(?:handler|controller|service|route|endpoint)/i.test(fn.file)) score += 3;

    return { fn, score };
  });

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, MAX_FUNCTIONS);

  return selected.map(({ fn }) => {
    // Truncate body to max lines
    const bodyLines = fn.rawBody.split("\n");
    const truncatedBody =
      bodyLines.length > MAX_LINES_PER_FUNCTION
        ? bodyLines.slice(0, MAX_LINES_PER_FUNCTION).join("\n") + "\n// ... truncated"
        : fn.rawBody;

    return {
      id: `${fn.relativePath}::${fn.name}`,
      name: fn.name,
      file: fn.relativePath,
      body: truncatedBody,
      line_start: fn.line,
      line_end: fn.line + bodyLines.length,
      language: fn.language,
    };
  });
}
