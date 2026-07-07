import { readdir, readFile, writeFile, mkdir, unlink } from "fs/promises";
import { homedir } from "os";
import { createHash } from "crypto";
import { join } from "path";
import type { CategoryScores, Finding, DriftFindingReport } from "./types.js";
import { projectHash } from "./baseline.js";

/**
 * Per-project scan history.
 *
 * History lives at $HOME/.vibedrift/scans/<project-hash>/scan-<ts>.json,
 * NOT inside the user's project tree. We never write into the project
 * directory — that pollutes git status and confuses tooling.
 *
 * The project hash is a SHA-256 prefix of the absolute path. It is stable
 * across runs but lets a single user track many projects without leaking
 * paths to anyone reading the directory listing.
 *
 * Schema versioning
 * -----------------
 * v1: { timestamp, rootDir, scores, compositeScore } — scores mixed
 *     drift + hygiene signals into the single `scores` field.
 * v2: { timestamp, rootDir, schemaVersion: 2, scores, compositeScore,
 *       hygieneScores, hygieneScore } — drift and hygiene tracked
 *     separately. `scores` now contains drift-only values.
 * v3: v2 + `findingDigests` and `driftFindingDigests`: stable per-finding
 *     keys that survive line shifts within a 3-line slop window.
 *     Enables scan-over-scan diff (Epic 3).
 *
 * Previous-scan delta: lower-schema comparisons are NOT meaningful for
 * the affected fields, so the loader silently returns null when the
 * latest saved scan predates the version being asked about. Fresh delta
 * is better than a misleading one.
 */

const ROOT_DIR = join(homedir(), ".vibedrift", "scans");
const HISTORY_SCHEMA_VERSION = 3;
const HISTORY_RETENTION = 10;

function projectDir(rootDir: string): string {
  return join(ROOT_DIR, projectHash(rootDir));
}

/** Compact per-finding summary persisted in history for cross-scan diffs. */
export interface FindingDigest {
  /**
   * Stable hash that survives small line shifts. Computed from
   * (analyzerId, file, lineBucket, messageNormalized). Two scans'
   * digests compare equal iff the findings match the same logical
   * problem regardless of a small edit offset.
   */
  key: string;
  analyzerId: string;
  severity: "info" | "warning" | "error";
  file: string | null;
  line: number | null;
  /** Rolled-up category tag from Finding.tags[0] or driftCategory. */
  category: string | null;
  /**
   * Original user-facing message, truncated. Retained for diff display —
   * when we tell the user "you resolved X", X is this message.
   */
  message: string;
}

export interface SavedScan {
  timestamp: string;
  rootDir: string;
  schemaVersion: number;
  scores: CategoryScores;
  compositeScore: number;
  hygieneScores?: CategoryScores;
  hygieneScore?: number;
  findingDigests?: FindingDigest[];
  driftFindingDigests?: FindingDigest[];
  /**
   * SCORING_VERSION at the time of save. Distinct from `schemaVersion` —
   * which captures structural shape (presence of fields). When the next
   * scan's `SCORING_VERSION` differs from this, delta computation is
   * refused: the numbers were produced under different formulas and
   * subtracting them yields a misleading result. Absent on scans saved
   * before this field was introduced.
   */
  scoringVersion?: string;
}

/**
 * Normalize a finding message so semantically-equivalent findings with
 * different concrete numbers hash to the same key.
 *   "14 empty catch blocks in src/" → "N empty catch blocks in src/"
 *   "function handleRequest (46 lines)" → "function handleRequest (N lines)"
 * The goal is "same rule, same place" stability across rescans.
 */
function normalizeMessage(msg: string): string {
  return msg.replace(/\b\d+\b/g, "N").trim();
}

/**
 * Bucket a line number to survive ±3-line edits (slop window).
 *   line 42 → bucket 13   (floor(42 / 3))
 *   line 44 → bucket 14
 *   line 45 → bucket 15
 *
 * Two findings 3 lines apart land in the same bucket ~66% of the time,
 * and at most one bucket apart. Downstream diff treats adjacent buckets
 * as potentially the same finding (via key suffix matching).
 */
function bucketLine(line: number | null | undefined): number | null {
  if (line == null) return null;
  return Math.floor(line / 3);
}

export function computeFindingDigest(f: Finding): FindingDigest {
  const loc = f.locations[0] ?? null;
  const file = loc?.file ?? null;
  const line = loc?.line ?? null;
  const category = (f.tags && f.tags.length > 0) ? f.tags[0] : null;
  const normalizedMsg = normalizeMessage(f.message);
  const keyInput = [f.analyzerId, file ?? "-", bucketLine(line) ?? "-", normalizedMsg].join("|");
  const key = createHash("sha256").update(keyInput).digest("hex").slice(0, 16);
  return {
    key,
    analyzerId: f.analyzerId,
    severity: f.severity,
    file,
    line,
    category,
    message: f.message.slice(0, 240),
  };
}

export function computeDriftFindingDigest(d: DriftFindingReport): FindingDigest {
  // Drift findings aggregate many files into a single finding — use the
  // dominant pattern + driftCategory + deviating file count as a stable
  // stand-in. Line is null because drift findings are directory/project
  // scoped, not line-scoped.
  const normalizedMsg = normalizeMessage(d.finding);
  const keyInput = [
    `drift:${d.detector}`,
    d.driftCategory,
    d.subCategory ?? "-",
    d.dominantPattern,
    normalizedMsg,
  ].join("|");
  const key = createHash("sha256").update(keyInput).digest("hex").slice(0, 16);
  return {
    key,
    analyzerId: `drift:${d.detector}`,
    severity: d.severity,
    file: d.deviatingFiles[0]?.path ?? null,
    line: null,
    category: d.driftCategory,
    message: d.finding.slice(0, 240),
  };
}

async function pruneHistory(dir: string): Promise<void> {
  try {
    const files = await readdir(dir);
    const scanFiles = files
      .filter((f) => f.startsWith("scan-") && f.endsWith(".json"))
      .sort(); // ascending — oldest first
    if (scanFiles.length <= HISTORY_RETENTION) return;
    const toPrune = scanFiles.slice(0, scanFiles.length - HISTORY_RETENTION);
    await Promise.all(toPrune.map((f) => unlink(join(dir, f)).catch(() => {})));
  } catch {
    // Best effort — pruning is not critical.
  }
}

export async function saveScanResult(
  rootDir: string,
  scores: CategoryScores,
  compositeScore: number,
  hygieneScores?: CategoryScores,
  hygieneScore?: number,
  findings?: Finding[],
  driftFindings?: DriftFindingReport[],
  scoringVersion?: string,
): Promise<void> {
  const dir = projectDir(rootDir);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch { /* exists */ }

  const findingDigests = findings
    ? findings.slice(0, 200).map(computeFindingDigest) // cap to keep files small
    : undefined;
  const driftFindingDigests = driftFindings
    ? driftFindings.slice(0, 100).map(computeDriftFindingDigest)
    : undefined;

  const data: SavedScan = {
    timestamp: new Date().toISOString(),
    rootDir,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    scores,
    compositeScore,
    hygieneScores,
    hygieneScore,
    findingDigests,
    driftFindingDigests,
    scoringVersion,
  };

  const filename = `scan-${Date.now()}.json`;
  await writeFile(join(dir, filename), JSON.stringify(data, null, 2));
  await pruneHistory(dir);
}

export async function loadPreviousScores(
  rootDir: string,
): Promise<CategoryScores | null> {
  const scan = await loadLatestScan(rootDir);
  if (!scan || scan.schemaVersion < 2) return null;
  return scan.scores ?? null;
}

export async function loadPreviousHygieneScores(
  rootDir: string,
): Promise<CategoryScores | null> {
  const scan = await loadLatestScan(rootDir);
  if (!scan || scan.schemaVersion < 2) return null;
  return scan.hygieneScores ?? null;
}

/**
 * Load the SCORING_VERSION of the most recent saved scan, if any. Returns
 * null when no history exists or the saved scan predates the field — both
 * of which the engine treats as a version mismatch (delta refused). Lets
 * the caller pass the version into `computeScores`'s
 * `previousScoringVersion` option without needing to read the full
 * SavedScan.
 */
export async function loadPreviousScoringVersion(
  rootDir: string,
): Promise<string | null> {
  const scan = await loadLatestScan(rootDir);
  if (!scan) return null;
  return scan.scoringVersion ?? null;
}

/**
 * Load the most recent saved scan in full. Returns null when no history
 * exists or on parse errors. Callers can use this directly for diffing,
 * or fall back to the more specific `loadPrevious*Scores` helpers for
 * delta rendering.
 */
export async function loadLatestScan(rootDir: string): Promise<SavedScan | null> {
  const dir = projectDir(rootDir);
  try {
    const files = await readdir(dir);
    const scanFiles = files
      .filter((f) => f.startsWith("scan-") && f.endsWith(".json"))
      .sort()
      .reverse();
    if (scanFiles.length === 0) return null;
    const raw = await readFile(join(dir, scanFiles[0]), "utf-8");
    return JSON.parse(raw) as SavedScan;
  } catch {
    return null;
  }
}

/**
 * Load a specific saved scan by its scan file name (e.g. `scan-1234567.json`
 * or the prefix `1234567`). Returns null if the scan doesn't exist or is
 * unreadable. Used by `vibedrift scan --since <scanId>`.
 */
export async function loadScanById(
  rootDir: string,
  scanId: string,
): Promise<SavedScan | null> {
  const dir = projectDir(rootDir);
  const filename = scanId.startsWith("scan-")
    ? (scanId.endsWith(".json") ? scanId : `${scanId}.json`)
    : `scan-${scanId}.json`;
  try {
    const raw = await readFile(join(dir, filename), "utf-8");
    return JSON.parse(raw) as SavedScan;
  } catch {
    return null;
  }
}

/** List saved scan file names in descending chronological order. */
export async function listScans(rootDir: string): Promise<string[]> {
  const dir = projectDir(rootDir);
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.startsWith("scan-") && f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
