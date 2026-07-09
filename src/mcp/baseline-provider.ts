/**
 * In-memory baseline holder for the long-lived MCP server.
 *
 * Loads a repo's RepoDriftBaseline from disk ONCE and caches it in process.
 * For a repo that already has a baseline it never rebuilds synchronously (a
 * rebuild is 3–8s and would blow the <500ms budget) — instead it re-hashes the
 * working tree to decide `ok` vs `stale` and always serves the cached baseline.
 *
 * For a repo that has NEVER been scanned, the first tool call builds the
 * baseline lazily (a one-time 3–8s), persists it, and returns it — so the MCP
 * server works out of the box with no manual `vibedrift scan` step. Builds are
 * deduped per rootDir. Only a genuinely empty dir (no code) or a failed build
 * falls back to `no_baseline`.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildBaseline,
  writeBaseline,
  computeBaselineKey,
  loadBaselineUnchecked,
  BASELINE_VERSION,
  type RepoDriftBaseline,
} from "../core/baseline.js";

const memCache = new Map<string, RepoDriftBaseline>();
// In-flight lazy builds, keyed by rootDir, so simultaneous first-call tools
// share ONE build instead of each kicking off a 3-8s scan.
const building = new Map<string, Promise<RepoDriftBaseline | null>>();

/**
 * Build a baseline for a repo that has never been scanned, persist it, and
 * cache it in-process. Deduped per rootDir. Returns null when there is nothing
 * to analyze (empty dir) or the build fails, so the caller falls back to
 * `no_baseline`. This is what removes the "run `vibedrift scan` first" step:
 * the first MCP tool call on a fresh repo pays a one-time build, every call
 * after is served from cache.
 */
async function buildAndCacheBaseline(rootDir: string): Promise<RepoDriftBaseline | null> {
  const existing = building.get(rootDir);
  if (existing) return existing;
  const p = (async () => {
    try {
      // STDERR only — stdout is the MCP JSON-RPC channel.
      console.error(`vibedrift-mcp: indexing ${rootDir} for the first time (one-time)…`);
      const b = await buildBaseline(rootDir);
      if (!b.ctxFiles || b.ctxFiles.length === 0) return null; // no code to analyze
      await writeBaseline(b);
      memCache.set(rootDir, b);
      return b;
    } catch (err) {
      console.error(`vibedrift-mcp: baseline build failed for ${rootDir}: ${String((err as Error)?.message ?? err)}`);
      return null;
    } finally {
      building.delete(rootDir);
    }
  })();
  building.set(rootDir, p);
  return p;
}

/** Test-only: drop the in-process cache so disk-load paths are exercised. */
export function __clearBaselineCache(): void {
  memCache.clear();
}

/**
 * Drop one repo's in-process baseline so the next tool call rebuilds it.
 * Called by the MCP `init` tool after it writes exclusions, so a long-lived
 * server honors the new `.vibedriftignore` within the same session instead of
 * serving the pre-exclusion baseline until restart.
 */
export function invalidateBaselineMem(rootDir: string): void {
  memCache.delete(rootDir);
}

/**
 * Re-hash the working tree using the same (path, content-hash) merkle the
 * baseline was keyed on, so a content change flips the result to `stale`.
 * Files that vanished hash as "MISSING" (also a change). New files that the
 * baseline never saw are not detected here — a known v1 limitation.
 */
async function liveKey(rootDir: string, baseline: RepoDriftBaseline): Promise<string> {
  const files = await Promise.all(
    baseline.ctxFiles.map(async (f) => {
      try {
        const content = await readFile(join(rootDir, f.path));
        return { path: f.path, hash: createHash("sha256").update(content).digest("hex") };
      } catch {
        return { path: f.path, hash: "MISSING" };
      }
    }),
  );
  return computeBaselineKey(files);
}

export async function getBaseline(
  rootDir: string,
): Promise<{ baseline: RepoDriftBaseline | null; status: "ok" | "stale" | "no_baseline" }> {
  let baseline = memCache.get(rootDir) ?? null;
  if (!baseline) {
    baseline = await loadBaselineUnchecked(rootDir);
    if (baseline) memCache.set(rootDir, baseline);
  }
  if (!baseline) {
    // Never scanned: build it lazily instead of failing the tool. The freshly
    // built baseline matches the working tree, so it is "ok".
    baseline = await buildAndCacheBaseline(rootDir);
    if (!baseline) return { baseline: null, status: "no_baseline" };
    return { baseline, status: "ok" };
  }

  // A baseline built under an older BASELINE_VERSION is missing current vote
  // shape (e.g. securitySubVotes) and would serve wrong answers forever; the
  // stale tag alone never rebuilds. A version mismatch forces a one-time rebuild
  // (same lazy path as a never-scanned repo). Content-only drift stays "stale"
  // (cheap re-hash, no rebuild) as before.
  if (baseline && baseline.version !== BASELINE_VERSION) {
    memCache.delete(rootDir);
    const rebuilt = await buildAndCacheBaseline(rootDir);
    if (rebuilt) return { baseline: rebuilt, status: "ok" };
    // Rebuild failed (e.g. files vanished): fall through and serve the old one
    // rather than returning no_baseline, so the tool still answers.
  }

  const fresh = (await liveKey(rootDir, baseline)) === baseline.key;
  return { baseline, status: fresh ? "ok" : "stale" };
}
