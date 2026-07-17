/**
 * Scan-over-scan diff engine.
 *
 * Compares two saved scans (previous vs current) and classifies every
 * finding into one of three buckets:
 *   - resolved  — present in previous, absent in current
 *   - new       — absent in previous, present in current
 *   - persistent — present in both
 *
 * The same classification is computed independently for the two finding
 * streams: generic analyzer findings (hygiene + drift-aware static) and
 * aggregated drift detector findings. A caller that wants "what drift did
 * the user actually resolve" can filter by kind or look at
 * `driftFindingsDiff` directly.
 *
 * Score delta is a simple numeric difference. The diff engine does NOT
 * project a causal link from individual finding changes to the score
 * delta — that's a lossy inference best left to the UI layer.
 */

import type { SavedScan, FindingDigest } from "../core/history.js";

export interface DiffResult {
  findingsDiff: FindingDelta;
  driftFindingsDiff: FindingDelta;
  scoreDelta: number;
  hygieneDelta: number;
  fromTimestamp: string | null;
  toTimestamp: string | null;
  /** True when the previous scan is too old to compare meaningfully. */
  incomparable: boolean;
  /**
   * True when the two scans were scored under different SCORING_VERSIONs
   * (or the previous scan predates the field). Both the score delta AND the
   * resolved/new classification would then be artifacts of an engine change,
   * not the user's code, so all comparisons are refused: deltas are 0 and
   * every finding lands in `new`. Renderers must stay SILENT on this flag
   * (no banner, no trajectory) — the one-time scoring-refined notice is the
   * only surface that explains a version shift.
   */
  versionMismatch: boolean;
}

export interface FindingDelta {
  resolved: FindingDigest[];
  new: FindingDigest[];
  persistent: FindingDigest[];
}

const MIN_SCHEMA_FOR_DIFF = 3;

function diffBy(
  prev: FindingDigest[] | undefined,
  curr: FindingDigest[] | undefined,
): FindingDelta {
  const prevMap = new Map<string, FindingDigest>();
  for (const d of prev ?? []) prevMap.set(d.key, d);
  const currMap = new Map<string, FindingDigest>();
  for (const d of curr ?? []) currMap.set(d.key, d);

  const resolved: FindingDigest[] = [];
  const added: FindingDigest[] = [];
  const persistent: FindingDigest[] = [];

  for (const [key, digest] of prevMap) {
    if (!currMap.has(key)) resolved.push(digest);
    else persistent.push(currMap.get(key)!); // keep the CURRENT copy for message
  }
  for (const [key, digest] of currMap) {
    if (!prevMap.has(key)) added.push(digest);
  }

  // Sort for deterministic output: resolved by analyzerId, new by
  // severity (error → warning → info) then analyzerId.
  resolved.sort((a, b) => a.analyzerId.localeCompare(b.analyzerId));
  const sevRank: Record<FindingDigest["severity"], number> = { error: 0, warning: 1, info: 2 };
  added.sort(
    (a, b) => sevRank[a.severity] - sevRank[b.severity] || a.analyzerId.localeCompare(b.analyzerId),
  );
  persistent.sort((a, b) => a.analyzerId.localeCompare(b.analyzerId));

  return { resolved, new: added, persistent };
}

/**
 * Compute the diff between two saved scans. Either side may be null —
 * a null previous scan means "no history, nothing to diff" and returns
 * empty resolved/persistent with every current finding marked `new`.
 *
 * When the previous scan predates schema v3 (findingDigests not
 * persisted), the diff is marked `incomparable: true` and everything
 * lands in `new` (we can't claim anything was "resolved" because we
 * don't know what used to be there).
 *
 * When the current scan carries a `scoringVersion` and the previous scan
 * was scored under a different one (or predates the field), the diff is
 * marked `versionMismatch: true` and every comparison is refused the same
 * way: subtracting numbers produced by different formulas, or attributing
 * detector-set changes to the user's code, yields misleading results. This
 * implements the refusal that SavedScan.scoringVersion's contract promises.
 */
export function diffScans(
  previous: SavedScan | null,
  current: Pick<SavedScan, "compositeScore" | "hygieneScore" | "findingDigests" | "driftFindingDigests" | "timestamp"> & { scoringVersion?: string },
): DiffResult {
  const incomparable = previous !== null && (previous.schemaVersion ?? 1) < MIN_SCHEMA_FOR_DIFF;
  const versionMismatch =
    previous !== null &&
    current.scoringVersion !== undefined &&
    previous.scoringVersion !== current.scoringVersion;
  // Either condition means the two scans cannot be honestly compared.
  const blind = incomparable || versionMismatch;

  const prevFindings = blind || previous === null ? undefined : previous.findingDigests;
  const prevDrift = blind || previous === null ? undefined : previous.driftFindingDigests;

  const findingsDiff = diffBy(prevFindings, current.findingDigests);
  const driftFindingsDiff = diffBy(prevDrift, current.driftFindingDigests);

  const scoreDelta = previous && !blind
    ? Math.round(((current.compositeScore ?? 0) - (previous.compositeScore ?? 0)) * 10) / 10
    : 0;
  const hygieneDelta = previous && !blind
    ? Math.round(((current.hygieneScore ?? 0) - (previous.hygieneScore ?? 0)) * 10) / 10
    : 0;

  return {
    findingsDiff,
    driftFindingsDiff,
    scoreDelta,
    hygieneDelta,
    fromTimestamp: previous?.timestamp ?? null,
    toTimestamp: current.timestamp,
    incomparable,
    versionMismatch,
  };
}

/** Human-friendly "2h ago" / "3d ago" rendering for the banner. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
