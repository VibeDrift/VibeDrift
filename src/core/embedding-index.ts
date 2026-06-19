/**
 * Local per-repo embedding index.
 *
 * Embeddings are computed server-side (the model only runs there) and returned
 * to the CLI, which persists the vectors HERE, on the user's machine, under
 * ~/.vibedrift/embedding-index/ — the same place the MinHash baseline lives.
 * Your code's vectors never sit on our servers.
 *
 * This is what makes in-loop deep checks fast and cheap at scale: a `deep:true`
 * check embeds only the ONE function being written (one tiny server call) and
 * cosines it locally against this cached index, instead of re-sending the repo's
 * functions on every call. The index is keyed by `sha256(rootDir)` and stamped
 * with the baseline key so it can be invalidated when the repo changes.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Resolved lazily (not a module const) so it honors the current HOME — tests
// redirect HOME to a tmp dir, and homedir() reads $HOME first on POSIX.
function indexDir(): string {
  return join(homedir(), ".vibedrift", "embedding-index");
}
// Bump when the entry shape or vector semantics change, to invalidate all
// cached indexes at once (mirrors BASELINE_VERSION in core/baseline.ts).
// v2: entries now carry the (truncated) function body so a borderline embedding
// match can be sent to the cloud for a Claude confirm/reject verdict without
// re-walking the repo. Old v1 indexes (no body) are dropped + rebuilt on load.
export const EMBEDDING_INDEX_VERSION = 2;

export interface EmbeddingEntry {
  id: string; // `${relativePath}::${name}`
  relativePath: string;
  name: string;
  line: number;
  contentHash: string; // sha256(body)[:16] — staleness/dedupe of a single function
  body: string; // truncated to the same MAX_LINES the server embeds (for borderline LLM validation)
  vector: number[];
}

export interface EmbeddingIndex {
  version: number;
  rootDir: string;
  baselineKey: string; // the RepoDriftBaseline key this index was built against (freshness)
  dim: number;
  builtAt: number; // epoch ms
  entries: EmbeddingEntry[];
}

export interface EmbeddingMatch {
  relativePath: string;
  name: string;
  line: number;
  similarity: number;
  body?: string; // present when the index stores bodies (v2+); used for borderline LLM validation
}

function indexPath(rootDir: string): string {
  const key = createHash("sha256").update(rootDir).digest("hex").slice(0, 16);
  return join(indexDir(), `${key}.json`);
}

/** sha256(body)[:16] — stable per-function content key. */
export function contentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export async function writeEmbeddingIndex(index: EmbeddingIndex): Promise<void> {
  await mkdir(indexDir(), { recursive: true, mode: 0o700 });
  await writeFile(indexPath(index.rootDir), JSON.stringify(index), "utf8");
}

/** Load the index for a repo, or null if absent/corrupt/stale-version. */
export async function loadEmbeddingIndex(rootDir: string): Promise<EmbeddingIndex | null> {
  try {
    const raw = await readFile(indexPath(rootDir), "utf8");
    const idx = JSON.parse(raw) as EmbeddingIndex;
    if (idx.version !== EMBEDDING_INDEX_VERSION || !Array.isArray(idx.entries)) return null;
    return idx;
  } catch {
    return null;
  }
}

/** True when the index is missing or was built against a different baseline
 *  (the repo changed). Callers rebuild when this returns true. */
export function isIndexStale(index: EmbeddingIndex | null, baselineKey: string): boolean {
  return !index || index.baselineKey !== baselineKey || index.entries.length === 0;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Cosine the query vector against every entry; return matches at or above the
 * threshold, sorted descending, capped. `excludeFile` drops the file being
 * edited so a function never matches itself (mirrors the MinHash path).
 */
export function findSimilarByEmbedding(
  queryVec: number[],
  index: EmbeddingIndex,
  opts: { threshold: number; cap: number; excludeFile?: string },
): EmbeddingMatch[] {
  const matches: EmbeddingMatch[] = [];
  for (const e of index.entries) {
    if (opts.excludeFile && e.relativePath === opts.excludeFile) continue;
    const sim = cosineSimilarity(queryVec, e.vector);
    if (sim >= opts.threshold) {
      matches.push({
        relativePath: e.relativePath,
        name: e.name,
        line: e.line,
        similarity: Number(sim.toFixed(3)),
        body: e.body,
      });
    }
  }
  matches.sort((a, b) => b.similarity - a.similarity);
  return matches.slice(0, opts.cap);
}
