/**
 * Shared tmp+rename atomic write for the small per-session JSON sidecars
 * (cooldown, outcomes, intent). A plain `writeFile` truncates the target in
 * place; the SessionStart/PostToolUse hook arms a hard 2s self-timeout that
 * calls `process.exit(0)` WITHOUT waiting for pending async I/O
 * (hook-entry.ts), so a truncate-then-write window that self-timeout lands in
 * leaves a torn (truncated or partially-written) file on disk. Every reader's
 * parse-failure fallback then silently resets whatever the sidecar protects —
 * the cooldown throttle, the open-finding dedup, or the intent lock.
 *
 * Every other sidecar in this package (activation.ts, upload-state.ts,
 * entitlement.ts, file-names.ts) already writes this way; this is that same
 * pattern extracted so the write itself cannot drift from it.
 *
 * The tmp path is unique per call (pid + a monotonic in-process counter, the
 * same scheme upload-state.ts uses) so two writers in the SAME process can
 * never tear each other's tmp file, and the final `rename` onto the target
 * path is a single filesystem operation an interrupted process cannot leave
 * half-done.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let tmpCounter = 0;

export interface AtomicWriteOptions {
  mode?: number;
}

/** POSIX `rename` over an existing destination is a single unconditional
 *  filesystem operation; Windows can transiently refuse the same rename with
 *  EPERM/EBUSY when another handle in this process (a concurrent writer's own
 *  tmp-write or close) still has the destination briefly open, even though no
 *  data race is actually happening. Retry a few times with a short backoff
 *  before giving up, rather than losing an otherwise-valid write to a
 *  platform-specific timing hiccup. */
async function renameWithRetry(tmp: string, path: string): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if ((code === "EPERM" || code === "EBUSY") && attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 10));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Write `data` to `path` atomically: write to a unique tmp sibling (creating
 * the parent directory first), then rename over the target. Throws on
 * failure — every caller here is best-effort and wraps this in its own
 * try/catch, matching the fail-open contract the rest of the module keeps.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${tmpCounter++}`;
  await writeFile(tmp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined);
  await renameWithRetry(tmp, path);
}
