/**
 * Which source files a Bash tool call changed, for the PostToolUse:Bash hook
 * path.
 *
 * The hook only ever saw Edit / Write / MultiEdit. An agent in Claude Code's
 * bypass-permissions mode is steered to change files through Bash instead
 * (python heredocs, `sed -i`, `cat >`), and on a recorded session that moved
 * about two thirds of file changes out of the hook's sight: every fix the
 * agent made in answer to a flag went through Bash, so no re-check ever ran
 * and nothing could resolve. This module gives the Bash path the same view an
 * edit tool gets: the files that changed since the hook last ran.
 *
 * No git dependency. The hook keeps a per-session clock (the wall time its
 * previous run finished, in a sidecar next to the ledger); after a Bash call
 * it walks the repo for checkable source files whose mtime is newer than that
 * clock. Bounded on purpose, because the walk runs on every Bash call under
 * the hook's 2s fail-open watchdog: at most `maxVisited` directory entries,
 * at most `deadlineMs` of wall time, at most `maxFiles` results. Hitting any
 * bound returns what was found so far with `truncated: true` rather than
 * failing. Everything here is fail-open: a read error is a skip, never a throw.
 */

import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.js";
import { join, relative } from "node:path";
import { SKIP_DIRS } from "../core/discovery.js";
import { detectLanguage } from "../core/language.js";
import { isInLoopCheckable } from "../drift/utils.js";
import { safeSegment } from "./ledger.js";

export const BASH_CHANGES_MAX_FILES = 20;
export const BASH_CHANGES_MAX_VISITED = 5000;
export const BASH_CHANGES_DEADLINE_MS = 500;
/** Files above this are skipped, matching the scanner's own size guard. */
export const BASH_CHANGES_MAX_FILE_BYTES = 1024 * 1024;
/** Slack against coarse mtime resolution (some filesystems round to whole
 *  seconds): a file written in the same second the clock was stamped must
 *  still count. The cost of the slack is a harmless re-check of an unchanged
 *  file, which the open-finding dedupe absorbs. */
export const MTIME_SLACK_MS = 1000;

export interface HookClock {
  /** Wall time (ms since epoch) the previous hook run stamped at its start. */
  lastMs?: number;
  /** Files the previous Bash-path run recorded, with the mtime each had. A
   *  file whose mtime is unchanged since then was already recorded once and
   *  is not an edit again, however close to the clock it sits (the mtime
   *  slack would otherwise re-detect it on the next Bash call). */
  recorded?: Record<string, number>;
}

export function hookClockPath(sessionsDir: string, projectHash: string, sessionId: string): string {
  return join(sessionsDir, safeSegment(projectHash), `${safeSegment(sessionId)}.hookclock.json`);
}

export async function readHookClock(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
): Promise<HookClock> {
  try {
    const raw = await readFile(hookClockPath(sessionsDir, projectHash, sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<HookClock>;
    if (typeof parsed.lastMs !== "number" || !Number.isFinite(parsed.lastMs)) return {};
    const recorded: Record<string, number> = {};
    if (parsed.recorded && typeof parsed.recorded === "object") {
      for (const [k, v] of Object.entries(parsed.recorded)) {
        if (typeof v === "number" && Number.isFinite(v)) recorded[k] = v;
      }
    }
    return { lastMs: parsed.lastMs, recorded };
  } catch {
    return {};
  }
}

export async function writeHookClock(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
  lastMs: number,
  recorded: Record<string, number> = {},
): Promise<void> {
  try {
    await mkdir(join(sessionsDir, safeSegment(projectHash)), { recursive: true, mode: 0o700 });
    // Atomic, like every other per-session sidecar (see ./atomic-write.ts): the
    // hook arms a 2 s self-timeout and can be killed mid-write, and a plain
    // writeFile truncates in place, so a kill at the wrong moment would leave a
    // half-written clock that parses as no clock at all. Losing the clock is
    // not free here: the next Bash call then detects nothing at all.
    await writeFileAtomic(
      hookClockPath(sessionsDir, projectHash, sessionId),
      JSON.stringify({ lastMs, recorded }),
      { mode: 0o600 },
    );
  } catch {
    // best-effort: a lost clock means the next Bash call detects nothing, never a failure
  }
}

export interface ChangedFilesOptions {
  maxFiles?: number;
  maxVisited?: number;
  deadlineMs?: number;
  now?: () => number;
}

export interface ChangedFilesResult {
  /** repo-relative, forward slashes, code-unit sorted */
  files: string[];
  /** mtime (ms) of each file in `files`, for the caller to remember */
  mtimes: Record<string, number>;
  /** true when a bound (files, visited, deadline) cut the walk short */
  truncated: boolean;
}

/**
 * Checkable source files under `rootDir` modified at or after `sinceMs`
 * (minus MTIME_SLACK_MS). Skips the scanner's SKIP_DIRS and every dot-directory,
 * non-code files, and the test/seed/script classes the in-loop check excludes.
 */
export async function changedSourceFiles(
  rootDir: string,
  sinceMs: number,
  opts: ChangedFilesOptions = {},
): Promise<ChangedFilesResult> {
  const maxFiles = opts.maxFiles ?? BASH_CHANGES_MAX_FILES;
  const maxVisited = opts.maxVisited ?? BASH_CHANGES_MAX_VISITED;
  const deadlineMs = opts.deadlineMs ?? BASH_CHANGES_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const threshold = sinceMs - MTIME_SLACK_MS;

  const found: string[] = [];
  const mtimes: Record<string, number> = {};
  let visited = 0;
  let truncated = false;
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    if (now() - started > deadlineMs || visited >= maxVisited) {
      truncated = true;
      break;
    }
    const dir = stack.pop() as string;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (visited > maxVisited) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(rootDir, abs).replace(/\\/g, "/");
      if (detectLanguage(rel) === null || !isInLoopCheckable(rel)) continue;
      let info: { mtimeMs: number; size: number };
      try {
        info = await stat(abs);
      } catch {
        continue;
      }
      if (info.size > BASH_CHANGES_MAX_FILE_BYTES) continue;
      if (info.mtimeMs < threshold) continue;
      found.push(rel);
      mtimes[rel] = info.mtimeMs;
      if (found.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  // Code-unit order, never localeCompare: the same tree must yield the same
  // order on every machine.
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files: found, mtimes, truncated };
}
