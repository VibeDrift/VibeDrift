/**
 * The per-turn flush, as a testable unit.
 *
 * `session-flush.ts` is a detached entrypoint script whose body runs on import,
 * so the orchestration it performs lives here instead: entitlement refresh,
 * then upload, then the post-402 correction.
 *
 * Why entitlement lives on this path: sessions are Pro-only with a 5-session
 * trial (decision 8), and the hook's gate (`isCapturePermitted`) reads a LOCAL
 * cache because the hook itself must never touch the network. In the classic
 * flow `watch-session` refreshed that cache. The native flow has no
 * watch-session, so without a refresh here the cache is never written, the gate
 * fails open forever, and the paywall never applies. This flush is the natural
 * owner: it already runs once per turn, detached, off the hook's critical path,
 * and it already holds a token.
 *
 * Fail-open throughout. An unreachable entitlement endpoint leaves the cache
 * untouched and the upload proceeds; only an answer from the server can lock a
 * machine, never a network blip.
 */

import { refreshEntitlementCache, type EntitlementFetchResult } from "./entitlement.js";
import { runUploaderOnce } from "./uploader.js";
import { syncFileNames, type FileNameEntry, type NamesPostAck } from "./file-names.js";
import type { IngestAck } from "./ingest-ack.js";
import type { UploadEvent } from "./upload-schema.js";

export interface FlushRunOptions {
  /** Entitlement-cache dir (the VibeDrift home root) — also where the
   *  activation store that holds the per-repo file-name opt-in lives. */
  baseDir: string;
  sessionsDir: string;
  projectHash: string;
  teamIntentOptIn?: boolean;
  /** Ask the server for entitlement; must reject on failure. */
  fetchEntitlement: () => Promise<EntitlementFetchResult>;
  post: (events: UploadEvent[]) => Promise<IngestAck | void>;
  /** Opt-in file-name manifest (off by default, per repo). Both are optional:
   *  without them the names step is inert. */
  postNames?: (entries: FileNameEntry[]) => Promise<NamesPostAck | void>;
  deleteNames?: () => Promise<unknown>;
  budgetMs?: number;
  now?: () => number;
}

export interface FlushRunResult {
  /** The uploader ran (it may still have had nothing queued). */
  uploaded: boolean;
  /** The account is out of trial: capture stops on the next hook event. */
  locked: boolean;
}

export async function runFlush(opts: FlushRunOptions): Promise<FlushRunResult> {
  const { baseDir, now } = opts;

  // 1. Pre-flight: TTL-gated, and always re-asked while locked so an upgrade
  //    takes effect on the very next turn.
  const entitlement = await refreshEntitlementCache({
    baseDir,
    now,
    fetch: opts.fetchEntitlement,
  });

  // 2. A known-locked account uploads nothing: the server would only 402 it.
  //    A null entitlement means we could not ask, which fails open (upload).
  //    An owed `--names off` deletion is still honored: an opt-out must land
  //    even on an account that can no longer sync.
  if (entitlement && !entitlement.entitled) {
    await settleFileNames(opts, false);
    return { uploaded: false, locked: true };
  }

  const { locked } = await runUploaderOnce({
    sessionsDir: opts.sessionsDir,
    projectHash: opts.projectHash,
    teamIntentOptIn: opts.teamIntentOptIn,
    post: opts.post,
    budgetMs: opts.budgetMs,
  });

  // 3. The server locked us mid-flush. Re-ask (forced, past the TTL) so the
  //    cache reflects the server's truth rather than a value we invented, and
  //    the hook gate stops capturing on the next event.
  if (locked) {
    await refreshEntitlementCache({ baseDir, now, force: true, fetch: opts.fetchEntitlement });
    await settleFileNames(opts, false);
    return { uploaded: true, locked: true };
  }

  // 4. Last, and strictly behind the events: the opt-in file-name manifest.
  //    Offsets are already committed by this point, so a names failure cannot
  //    block, delay or corrupt the flush — and with the flag off (the default)
  //    this makes no request at all.
  await settleFileNames(opts, true);

  return { uploaded: true, locked: false };
}

/** Run the names step without letting it affect the flush in any way. */
async function settleFileNames(opts: FlushRunOptions, canUpload: boolean): Promise<void> {
  if (!opts.postNames && !opts.deleteNames) return;
  try {
    await syncFileNames({
      sessionsDir: opts.sessionsDir,
      projectHash: opts.projectHash,
      home: opts.baseDir,
      postNames: opts.postNames,
      deleteNames: opts.deleteNames,
      canUpload,
    });
  } catch {
    // syncFileNames already fails open; this is the belt on the braces
  }
}
