/**
 * In-loop semantic-duplicate check via the LOCAL embedding index.
 *
 * The fast/cheap path: embed ONLY the function being written (one tiny metered
 * call to /v1/embed), then cosine it locally against the cached per-repo index.
 * The index is built lazily on first use and rebuilt when the repo's baseline
 * changes. This replaces re-sending the repo's functions on every deep check.
 *
 * Two-tier verdict (see the confidence bands below): a strong local cosine match
 * ships immediately, but a *borderline* match — where embedding similarity alone
 * is unreliable — is escalated to the cloud for a Claude confirm/reject verdict.
 * Only the handful of borderline candidates are sent, so the cloud cost stays
 * bounded while the surfaced results gain LLM-grade precision.
 *
 * Returns a DeepResult when the index path ran (or the cloud was unreachable —
 * degraded), or `null` when no index could be built (empty repo / no functions),
 * which signals the caller to fall back to stateless candidate-feeding.
 *
 * Scope: duplicates only. In-loop intent-mismatch still lives on the full
 * `--deep` scan (it needs the server's name-vs-body pass).
 */
import { resolveToken, resolveApiUrl } from "../auth/resolver.js";
import { embedFunctions } from "../ml-client/embed-client.js";
import { buildEmbeddingIndex } from "../ml-client/build-embedding-index.js";
import {
  loadEmbeddingIndex,
  isIndexStale,
  findSimilarByEmbedding,
  type EmbeddingIndex,
} from "../core/embedding-index.js";
import { classifyDegradeReason, deepAnalyze, type DeepResult, type DeepFinding } from "./deep-client.js";
import type { MlFunctionPayload } from "../ml-client/types.js";

// Confidence bands for a local cosine match:
//   ≥ HIGH_CONFIDENCE       → ship directly as a confirmed semantic duplicate (no cloud call)
//   [BORDERLINE_FLOOR, HIGH) → ambiguous; send the candidate to the cloud for an LLM verdict
//   < BORDERLINE_FLOOR       → drop (too weak to be worth a verdict)
// The borderline band is where embedding cosine is unreliable on its own; routing
// only those (a handful, not the whole repo) to Claude is what makes the in-loop
// check both cheap AND precise.
const BORDERLINE_FLOOR = 0.72; // collect matches from here up
const HIGH_CONFIDENCE = 0.9; // server's "semantic_duplicate" bar
const MAX_BORDERLINE = 8; // cap the cloud cost of a single in-loop check
const MAX_MATCHES = 20;

export async function deepDuplicatesViaIndex(
  rootDir: string,
  queryPayload: MlFunctionPayload,
  baselineKey: string,
  opts: { excludeFile?: string } = {},
): Promise<DeepResult | null> {
  const tok = await resolveToken();
  if (!tok?.token) {
    return { degraded: true, reason: "no_token", intentMismatches: [], duplicates: [] };
  }
  const apiUrl = await resolveApiUrl();

  // Load, or lazily (re)build, the per-repo index.
  let index: EmbeddingIndex | null = await loadEmbeddingIndex(rootDir);
  if (isIndexStale(index, baselineKey)) {
    index = await buildEmbeddingIndex(rootDir, baselineKey, { token: tok.token, apiUrl });
  }
  if (!index) return null; // nothing to compare against → caller falls back

  // Embed just the query function (one small metered call).
  let queryVec: number[] | undefined;
  try {
    const [item] = await embedFunctions([queryPayload], tok.token, apiUrl, "mcp");
    queryVec = item?.vector;
  } catch (e) {
    return { degraded: true, reason: classifyDegradeReason(e), intentMismatches: [], duplicates: [] };
  }
  if (!queryVec) return { degraded: false, intentMismatches: [], duplicates: [] };

  const matches = findSimilarByEmbedding(queryVec, index, {
    threshold: BORDERLINE_FLOOR,
    cap: MAX_MATCHES,
    excludeFile: opts.excludeFile,
  });

  // High-confidence local matches ship directly — cosine alone is reliable here.
  const duplicates: DeepFinding[] = matches
    .filter((m) => m.similarity >= HIGH_CONFIDENCE)
    .map((m) => ({
      kind: "duplicate",
      detail: `${queryPayload.id} ≈ ${m.relativePath}::${m.name}`,
      confidence: m.similarity,
      verdict: "semantic_duplicate",
    }));

  // Borderline matches are ambiguous: ask the cloud for an LLM confirm/reject
  // verdict instead of surfacing a maybe. We send ONLY the query + the borderline
  // candidates (each carries its stored body), and filter the server's pairwise
  // result back to the query. Rejected pairs simply don't come back → dropped.
  const borderline = matches
    .filter((m) => m.similarity < HIGH_CONFIDENCE && m.body)
    .slice(0, MAX_BORDERLINE);

  if (borderline.length > 0) {
    const candidatePayloads: MlFunctionPayload[] = borderline.map((m) => ({
      id: `${m.relativePath}::${m.name}`,
      name: m.name,
      file: m.relativePath,
      body: m.body as string,
      line_start: m.line,
      line_end: m.line,
      language: queryPayload.language,
    }));
    const verdict = await deepAnalyze(
      [queryPayload, ...candidatePayloads],
      queryPayload.language ?? "unknown",
      queryPayload.id,
    );
    if (verdict.degraded) {
      // The cloud verdict failed (quota/offline/rate-limit). Surface the
      // high-confidence locals we already have; only report degraded if those
      // were our only signal, so the caller can tell the user verification ran short.
      if (duplicates.length === 0) {
        return { degraded: true, reason: verdict.reason, intentMismatches: [], duplicates: [] };
      }
    } else {
      // Defense-in-depth: surface a borderline pair ONLY if the server's verdict
      // cleared the high-confidence bar. The server boosts Claude-CONFIRMED pairs
      // to >= HIGH_CONFIDENCE and leaves uncertain ones at their raw cosine, so
      // this drops anything Claude didn't confirm — mirroring the full --deep
      // path's client-side confidence filter rather than trusting the response
      // verbatim. (Rejected pairs aren't returned at all.)
      duplicates.push(...verdict.duplicates.filter((d) => d.confidence >= HIGH_CONFIDENCE));
    }
  }

  duplicates.sort((a, b) => b.confidence - a.confidence);
  return { degraded: false, intentMismatches: [], duplicates: duplicates.slice(0, MAX_MATCHES) };
}
