/**
 * Git-derived temporal metadata for the scan root.
 *
 * Shells out to `git log` once (not per-file) to collect:
 *   - per-file most recent commit timestamp
 *   - per-file unique author count
 *   - per-file commit count (90d + total)
 *
 * Caches the result at ~/.vibedrift/git-metadata-cache/<project>.json
 * keyed on HEAD. Cache hits are sub-50ms; cold runs on 500-file repos
 * finish in <500ms. Silent fallback on any failure — callers get null
 * and temporal weighting becomes a no-op.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { FileGitMetadata } from "./types.js";

const execFileP = promisify(execFile);

const CACHE_DIR = join(homedir(), ".vibedrift", "git-metadata-cache");
const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 50 * 1024 * 1024; // 50MB — accommodates very large histories

export interface GitMetadataResult {
  headCommit: string;
  byFile: Map<string, FileGitMetadata>;
}

interface CacheEntry {
  headCommit: string;
  generatedAt: number;
  byFile: Record<string, FileGitMetadata>;
}

function cachePath(rootDir: string): string {
  const hash = createHash("sha256").update(rootDir).digest("hex").slice(0, 16);
  return join(CACHE_DIR, `${hash}.json`);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

/**
 * Files changed relative to `ref` (default HEAD), as paths relative to
 * `rootDir`, plus untracked files. Powers `--diff` — scoping a (deep) scan to
 * just what you changed.
 *
 *   - ref omitted → uncommitted changes (staged + unstaged) vs HEAD
 *   - ref = "main" → everything in the working tree that differs from main
 *     (committed-on-branch AND uncommitted), the natural "review my branch" set
 *
 * `git diff --name-only <ref>` already spans staged+unstaged vs the ref;
 * untracked files (newly written, not yet added) are unioned in separately.
 * Returns null when this isn't a git repo / git is unavailable, so callers can
 * fall back to a full scan rather than scanning nothing.
 */
export async function getChangedFiles(rootDir: string, ref?: string): Promise<string[] | null> {
  const base = ref && ref.trim() ? ref.trim() : "HEAD";
  try {
    const out: string[] = [];
    // --relative makes paths relative to cwd (rootDir), matching SourceFile.relativePath
    // even when scanning a subdirectory of a larger repo.
    const diff = await runGit(rootDir, ["diff", "--name-only", "--relative", base]);
    out.push(...diff.split("\n"));
    try {
      const untracked = await runGit(rootDir, ["ls-files", "--others", "--exclude-standard"]);
      out.push(...untracked.split("\n"));
    } catch {
      // ls-files failure is non-fatal — we still have the tracked diff.
    }
    const unique = [...new Set(out.map((l) => l.trim()).filter(Boolean))];
    return unique;
  } catch {
    return null; // not a git repo, bad ref, or git missing
  }
}

async function resolveHead(rootDir: string): Promise<string | null> {
  try {
    const head = await runGit(rootDir, ["rev-parse", "HEAD"]);
    return head.trim();
  } catch {
    return null;
  }
}

async function loadCache(rootDir: string, head: string): Promise<GitMetadataResult | null> {
  try {
    const buf = await readFile(cachePath(rootDir), "utf8");
    const entry = JSON.parse(buf) as CacheEntry;
    if (entry.headCommit !== head) return null;
    const byFile = new Map<string, FileGitMetadata>();
    for (const [path, meta] of Object.entries(entry.byFile)) {
      byFile.set(path, meta);
    }
    return { headCommit: head, byFile };
  } catch {
    return null;
  }
}

async function saveCache(rootDir: string, head: string, byFile: Map<string, FileGitMetadata>): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = {
      headCommit: head,
      generatedAt: Date.now(),
      byFile: Object.fromEntries(byFile),
    };
    await writeFile(cachePath(rootDir), JSON.stringify(entry));
  } catch {
    // Best-effort cache; failure is non-fatal
  }
}

/**
 * Single-pass scan of git history.
 *
 * Output from `git log --format=COMMIT|<hash>|<unix-time>|<email> --name-only`:
 *   COMMIT|abc...|1713984000|alice@example.com
 *   src/handlers/userHandler.ts
 *   src/handlers/orderHandler.ts
 *   COMMIT|def...|...
 *   ...
 *
 * We stream through and aggregate per-file, keeping raw (ts, email)
 * touch events so the per-file derived metrics (singleSession,
 * authorDiversity, medianCommitIntervalHours) can be computed in a
 * second O(n) pass at the end. Raw touches are discarded before the
 * function returns — only the derived FileGitMetadata survives.
 */
async function collectFromLog(rootDir: string): Promise<Map<string, FileGitMetadata>> {
  const output = await runGit(rootDir, [
    "log",
    "--format=COMMIT|%H|%at|%ae",
    "--name-only",
    "--no-merges",
  ]);

  const now = Date.now();
  const ninetyDaysAgoSec = Math.floor((now - 90 * 86400 * 1000) / 1000);

  /** Per-file touch log: timestamps + author emails in git-log order (newest→oldest). */
  const touches = new Map<string, { ts: number; email: string }[]>();

  let currentTs = 0;
  let currentEmail = "";
  let inCommit = false;

  const lines = output.split("\n");
  for (const line of lines) {
    if (line.startsWith("COMMIT|")) {
      const parts = line.split("|");
      if (parts.length >= 4) {
        currentTs = parseInt(parts[2], 10) || 0;
        currentEmail = parts[3] ?? "";
        inCommit = true;
      }
      continue;
    }
    if (!inCommit || line.length === 0) continue;

    const path = line;
    let list = touches.get(path);
    if (!list) {
      list = [];
      touches.set(path, list);
    }
    list.push({ ts: currentTs, email: currentEmail });
  }

  const byFile = new Map<string, FileGitMetadata>();
  const nowSec = Math.floor(now / 1000);
  const SIX_HOURS_SEC = 6 * 3600;

  for (const [path, events] of touches) {
    if (events.length === 0) continue;

    // git log emits newest→oldest. Sort ascending so interval math reads
    // naturally. We don't mutate the original since touches is only
    // used once, but cloning here keeps the invariant local.
    const ascending = [...events].sort((a, b) => a.ts - b.ts);
    const latestTs = ascending[ascending.length - 1].ts;
    const earliestTs = ascending[0].ts;

    // Author diversity: Shannon entropy of commit-count-by-author.
    const commitsByAuthor = new Map<string, number>();
    for (const e of ascending) {
      commitsByAuthor.set(e.email, (commitsByAuthor.get(e.email) ?? 0) + 1);
    }
    const totalCommits = events.length;
    let entropy = 0;
    for (const c of commitsByAuthor.values()) {
      if (c === 0) continue;
      const p = c / totalCommits;
      entropy -= p * Math.log2(p);
    }

    // Commit intervals (hours) — only meaningful with ≥2 commits.
    let medianCommitIntervalHours: number | undefined;
    if (ascending.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < ascending.length; i++) {
        intervals.push((ascending[i].ts - ascending[i - 1].ts) / 3600);
      }
      intervals.sort((a, b) => a - b);
      const mid = Math.floor(intervals.length / 2);
      medianCommitIntervalHours = intervals.length % 2 === 0
        ? (intervals[mid - 1] + intervals[mid]) / 2
        : intervals[mid];
    }

    // Count-in-last-90d, and total count.
    let count90d = 0;
    for (const e of ascending) {
      if (e.ts >= ninetyDaysAgoSec) count90d++;
    }

    // Single-session: all commits within a 6h span. Undefined with <2 commits
    // (no meaningful spread to evaluate).
    let singleSession: boolean | undefined;
    if (ascending.length >= 2) {
      singleSession = (latestTs - earliestTs) <= SIX_HOURS_SEC;
    }

    byFile.set(path, {
      lastModifiedDaysAgo: Math.max(0, Math.floor((nowSec - latestTs) / 86400)),
      uniqueAuthors: commitsByAuthor.size,
      commitCount90d: count90d,
      commitCountTotal: totalCommits,
      singleSession,
      initialAuthorEmail: ascending[0].email || undefined,
      authorDiversity: entropy,
      medianCommitIntervalHours,
    });
  }

  return byFile;
}

/**
 * Collect git metadata for the scan root.
 *
 * Returns null if the scan root isn't a git repo, the git CLI isn't
 * available, or collection errors/times out. Callers MUST treat a
 * null return as "no temporal data" — temporal weighting defaults to
 * uniform 1.0× and pivot detection is disabled.
 */
export async function collectGitMetadata(rootDir: string): Promise<GitMetadataResult | null> {
  // Quick gate: is there a .git directory?
  try {
    await stat(join(rootDir, ".git"));
  } catch {
    return null;
  }

  const head = await resolveHead(rootDir);
  if (!head) return null;

  const cached = await loadCache(rootDir, head);
  if (cached) return cached;

  try {
    const byFile = await collectFromLog(rootDir);
    if (byFile.size === 0) return null;
    await saveCache(rootDir, head, byFile);
    return { headCommit: head, byFile };
  } catch {
    return null;
  }
}
