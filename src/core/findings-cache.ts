/**
 * Per-analyzer findings cache.
 *
 * Keyed by a Merkle-style hash of the analyzer's applicable files
 * (sorted [relativePath:sha256(content)] tuples) combined with the analyzer
 * id and version. Any change to any applicable file invalidates that
 * analyzer's cache; changes outside its language filter do not.
 *
 * Lives at $HOME/.vibedrift/findings-cache/<project-hash>/<key>.json — never
 * inside the user's project tree. The project-hash scheme mirrors
 * src/core/history.ts so paths aren't leaked in the directory listing.
 *
 * Invalidation levers:
 *   1. File content change → new content hash → new key → miss.
 *   2. Analyzer logic change → bump `version` in the Analyzer → new key → miss.
 *   3. TTL (30 days) and size cap (500MB) enforced by pruneCache().
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { homedir } from "os";
import { createHash } from "crypto";
import { join } from "path";
import type { Finding, SourceFile, SupportedLanguage } from "./types.js";
import { projectHash } from "./baseline.js";

const ROOT_DIR = join(homedir(), ".vibedrift", "findings-cache");
const TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_CACHE_BYTES = 500 * 1024 * 1024;

function projectDir(rootDir: string): string {
  return join(ROOT_DIR, projectHash(rootDir));
}

/**
 * Select the subset of files an analyzer operates on.
 * Keeping the key scoped to applicable files means changes to, say, Python
 * code don't invalidate a TS-only analyzer's cache.
 */
export function filterApplicableFiles(
  files: SourceFile[],
  applicableLanguages: SupportedLanguage[] | "all",
): SourceFile[] {
  if (applicableLanguages === "all") {
    return files.filter((f) => f.language !== null);
  }
  return files.filter(
    (f) => f.language !== null && applicableLanguages.includes(f.language),
  );
}

/**
 * Compute a cache key for an analyzer run.
 *
 * Merkle-style: hash the sorted list of [relativePath:contentHash] tuples
 * (not the raw content — keeps the intermediate size bounded regardless of
 * project size) with analyzer id and version.
 */
export function computeAnalyzerCacheKey(
  analyzerId: string,
  version: number,
  applicableFiles: SourceFile[],
): string {
  const fileHashes = applicableFiles
    .map((f) => {
      const contentHash = createHash("sha256")
        .update(f.content)
        .digest("hex")
        .slice(0, 16);
      return `${f.relativePath}:${contentHash}`;
    })
    .sort()
    .join("\n");

  return createHash("sha256")
    .update(`${analyzerId}\0${version}\0${fileHashes}`)
    .digest("hex");
}

export async function loadAnalyzerFindings(
  rootDir: string,
  key: string,
): Promise<Finding[] | null> {
  const path = join(projectDir(rootDir), `${key}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as { findings: Finding[]; ts: number };
    // Touch mtime so LRU eviction keeps frequently-used entries.
    // Best-effort — ignore failures.
    try {
      const now = new Date();
      const { utimes } = await import("fs/promises");
      await utimes(path, now, now);
    } catch { /* ignore */ }
    return data.findings;
  } catch {
    return null;
  }
}

export async function saveAnalyzerFindings(
  rootDir: string,
  key: string,
  findings: Finding[],
): Promise<void> {
  const dir = projectDir(rootDir);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch { /* exists */ }
  const path = join(dir, `${key}.json`);
  const data = { findings, ts: Date.now() };
  await writeFile(path, JSON.stringify(data));
}

/**
 * Best-effort cleanup. Called once per scan. Failures are swallowed —
 * a full cache dir just means the next writes go to the same place and
 * pruning runs next time.
 */
export async function pruneCache(rootDir: string): Promise<void> {
  const dir = projectDir(rootDir);
  let entries: { name: string; size: number; mtime: number }[];
  try {
    const files = await readdir(dir);
    entries = [];
    const now = Date.now();

    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = await stat(join(dir, f));
        if (now - s.mtimeMs > TTL_MS) {
          await unlink(join(dir, f));
          continue;
        }
        entries.push({ name: f, size: s.size, mtime: s.mtimeMs });
      } catch { /* skip */ }
    }
  } catch {
    return; // dir doesn't exist
  }

  let total = entries.reduce((s, e) => s + e.size, 0);
  if (total <= MAX_CACHE_BYTES) return;

  entries.sort((a, b) => a.mtime - b.mtime);
  for (const e of entries) {
    if (total <= MAX_CACHE_BYTES) break;
    try {
      await unlink(join(dir, e.name));
      total -= e.size;
    } catch { /* skip */ }
  }
}

export function isCacheDisabled(): boolean {
  return process.env.VIBEDRIFT_DISABLE_CACHE === "1";
}
