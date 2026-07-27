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
import type { IngestAck } from "./ingest-ack.js";
import type { UploadEvent } from "./upload-schema.js";

export interface FlushRunOptions {
  /** Entitlement-cache dir (the VibeDrift home root). */
  baseDir: string;
  sessionsDir: string;
  projectHash: string;
  teamIntentOptIn?: boolean;
  /** Ask the server for entitlement; must reject on failure. */
  fetchEntitlement: () => Promise<EntitlementFetchResult>;
  post: (events: UploadEvent[]) => Promise<IngestAck | void>;
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
  if (entitlement && !entitlement.entitled) return { uploaded: false, locked: true };

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
    return { uploaded: true, locked: true };
  }

  return { uploaded: true, locked: false };
}
