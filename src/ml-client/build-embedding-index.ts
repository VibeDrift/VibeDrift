/**
 * Build + persist the per-repo embedding index.
 *
 * Extracts the repo's functions, sends their bodies to /v1/embed (the server
 * computes the vectors and keeps nothing), and stores the vectors locally via
 * core/embedding-index. This is the one-time cost that makes every later
 * in-loop deep check fast: those checks embed a single function and cosine it
 * against this cached index instead of re-sending candidates each call.
 *
 * Best-effort: returns null on any failure (no token, offline, empty repo), and
 * the in-loop deep path then falls back to candidate-feeding.
 */
import { buildAnalysisContext } from "../core/discovery.js";
import { extractAllFunctions } from "../codedna/function-extractor.js";
import { embedFunctions } from "./embed-client.js";
import {
  writeEmbeddingIndex,
  contentHash,
  EMBEDDING_INDEX_VERSION,
  type EmbeddingIndex,
  type EmbeddingEntry,
} from "../core/embedding-index.js";
import type { MlFunctionPayload } from "./types.js";

// Match the server's per-function truncation so a function embeds identically
// whether it arrives via this index build or a full --deep scan.
const MAX_LINES = 60;

export async function buildEmbeddingIndex(
  rootDir: string,
  baselineKey: string,
  opts: { token: string; apiUrl?: string; nowMs?: number },
): Promise<EmbeddingIndex | null> {
  try {
    const { ctx } = await buildAnalysisContext(rootDir);
    const fns = extractAllFunctions(ctx.files);
    if (fns.length === 0) return null;

    const payloads: MlFunctionPayload[] = fns.map((fn) => {
      const lines = fn.rawBody.split("\n");
      const body = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES).join("\n") : fn.rawBody;
      return {
        id: `${fn.relativePath}::${fn.name}`,
        name: fn.name,
        file: fn.relativePath,
        body,
        line_start: fn.line,
        line_end: fn.line,
        language: fn.language,
      };
    });

    const vectors = await embedFunctions(payloads, opts.token, opts.apiUrl, "cli");
    if (vectors.length === 0) return null;
    const byId = new Map(vectors.map((v) => [v.id, v.vector]));

    const entries: EmbeddingEntry[] = [];
    fns.forEach((fn, i) => {
      const id = `${fn.relativePath}::${fn.name}`;
      const vector = byId.get(id);
      if (!vector) return;
      entries.push({
        id,
        relativePath: fn.relativePath,
        name: fn.name,
        line: fn.line,
        contentHash: contentHash(fn.rawBody),
        // Store the same truncated body that was embedded, so a borderline match
        // can be re-sent to the cloud for an LLM verdict without re-extraction.
        body: payloads[i].body ?? "",
        vector,
      });
    });
    if (entries.length === 0) return null;

    const index: EmbeddingIndex = {
      version: EMBEDDING_INDEX_VERSION,
      rootDir,
      baselineKey,
      dim: vectors[0].vector.length,
      builtAt: opts.nowMs ?? Date.now(),
      entries,
    };
    await writeEmbeddingIndex(index);
    return index;
  } catch {
    return null;
  }
}
