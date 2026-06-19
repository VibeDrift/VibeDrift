/**
 * In-loop semantic-duplicate check via the LOCAL embedding index.
 *
 * The fast/cheap path: embed ONLY the function being written (one tiny metered
 * call to /v1/embed), then cosine it locally against the cached per-repo index.
 * The index is built lazily on first use and rebuilt when the repo's baseline
 * changes. This replaces re-sending the repo's functions on every deep check.
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
import { classifyDegradeReason, type DeepResult, type DeepFinding } from "./deep-client.js";
import type { MlFunctionPayload } from "../ml-client/types.js";

// No LLM validates these locally, so keep the bar high to protect precision.
const DUPLICATE_FLOOR = 0.85; // below this we don't surface
const HIGH_CONFIDENCE = 0.9; // server's "semantic_duplicate" bar
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
    threshold: DUPLICATE_FLOOR,
    cap: MAX_MATCHES,
    excludeFile: opts.excludeFile,
  });

  const duplicates: DeepFinding[] = matches.map((m) => ({
    kind: "duplicate",
    detail: `${queryPayload.id} ≈ ${m.relativePath}::${m.name}`,
    confidence: m.similarity,
    verdict: m.similarity >= HIGH_CONFIDENCE ? "semantic_duplicate" : "possible_duplicate",
  }));

  return { degraded: false, intentMismatches: [], duplicates };
}
