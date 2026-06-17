/**
 * Passive update check.
 *
 * Best-effort check against the npm registry to see whether the user
 * is on the latest `@vibedrift/cli`. Results are cached at
 * `~/.vibedrift/version-check.json` for 24 hours so we never query the
 * registry more than once a day, and so offline users / CI runs never
 * pay a network RTT on every scan.
 *
 * The check is deliberately non-blocking:
 *   - Runs in the background from `runScan`.
 *   - Never fails the scan. Registry errors, timeouts, parse failures,
 *     cache-write failures — all silently swallowed.
 *   - The resulting notice is rendered AFTER the scan completes, not
 *     before, so it never interrupts or delays output.
 *
 * Opt-out: users who don't want the check can disable telemetry
 * (`vibedrift telemetry disable`) OR use `--local-only`, both of which
 * skip this path entirely. The version check honors the same network
 * gate as the scan beacon — no surprises, no hidden egress.
 *
 * Why it matters: VibeDrift ships often in its early stages; the
 * latest version is always the one with the sharpest detectors and
 * latest fixes. Users stuck on an old version miss improvements that
 * materially change scan accuracy.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const PACKAGE_NAME = "@vibedrift/cli";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_PATH = join(homedir(), ".vibedrift", "version-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 2000;

export interface UpdateCheckResult {
  /** Currently running CLI version (passed in, echoed back for rendering). */
  current: string;
  /** Latest version on the registry, as of the cache entry. */
  latest: string;
  /** ISO timestamp when the cache entry was written. */
  checkedAt: string;
  /** True when `latest` is strictly newer than the running version. */
  outdated: boolean;
}

interface CacheEntry {
  latest: string;
  checkedAt: number;
}

export function semverGreater(a: string, b: string): boolean {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function readCache(): Promise<CacheEntry | null> {
  try {
    const buf = await readFile(CACHE_PATH, "utf8");
    const entry = JSON.parse(buf) as CacheEntry;
    if (typeof entry.latest !== "string" || typeof entry.checkedAt !== "number") {
      return null;
    }
    if (Date.now() - entry.checkedAt > CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

async function writeCache(latest: string): Promise<void> {
  try {
    await mkdir(join(homedir(), ".vibedrift"), { recursive: true, mode: 0o700 });
    const entry: CacheEntry = { latest, checkedAt: Date.now() };
    await writeFile(CACHE_PATH, JSON.stringify(entry));
  } catch {
    // best-effort; no retry
  }
}

async function fetchLatestFromRegistry(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Check for a newer `@vibedrift/cli` on the registry. Cached 24 hours
 * per user. Returns null on any failure (offline, registry error,
 * parse failure). Always returns a populated result on success, even
 * when the user is already on the latest version — callers check
 * `result.outdated` to decide whether to render a notice.
 *
 * Callers MUST pass the currently running version. Keeps the module
 * testable and the version source explicit at the call site.
 */
export async function checkForUpdate(
  currentVersion: string,
): Promise<UpdateCheckResult | null> {
  const cached = await readCache();
  if (cached) {
    return {
      current: currentVersion,
      latest: cached.latest,
      checkedAt: new Date(cached.checkedAt).toISOString(),
      outdated: semverGreater(cached.latest, currentVersion),
    };
  }
  const latest = await fetchLatestFromRegistry();
  if (!latest) return null;
  await writeCache(latest);
  return {
    current: currentVersion,
    latest,
    checkedAt: new Date().toISOString(),
    outdated: semverGreater(latest, currentVersion),
  };
}
