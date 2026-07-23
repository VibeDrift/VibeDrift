/**
 * Drift Sessions derived-only uploader (Phase 5). A resident reader — the tape
 * follower's sibling — that tails the active ledger, maps each new event to its
 * derived `UploadEvent` (src/session/upload-schema.ts), batches them, and hands
 * them to an injected `post`. It runs ONLY when the caller has confirmed opt-in +
 * login (`watch-session` gates it); it is never on the hook's critical path.
 *
 * Fail-open in the strong sense: a failed flush never throws and never loses the
 * batch — the events stay queued and are retried on the next tick, with a hard
 * buffer cap so a long outage can't grow memory without bound. When sync is off
 * (or `--local-only`, or logged out) the caller simply never starts this, so
 * local behaviour is byte-identical.
 */

import { SessionFollower } from "./follow.js";
import { toUploadEvent, type UploadEvent } from "./upload-schema.js";
import type { SessionEvent } from "./types.js";

const DEFAULT_BATCH = 50;
const DEFAULT_INTERVAL_MS = 1000;
const MAX_BUFFER = 2000;
/** Cap the best-effort flush after Ctrl-C so a hanging network can't freeze the
 *  terminal (the tape's cleanup awaits this). A refused connection rejects fast;
 *  this only bounds a truly hanging socket. */
const SHUTDOWN_FLUSH_MS = 2500;

/** Whether hosted sync should run this session: opted in, logged in, and not
 *  forced local for this run. Pure so the gate is unit-testable. Off by default
 *  in every dimension — sync never starts by accident. */
export function shouldSync(
  cfg: { sessionsSyncEnabled?: boolean; token?: string },
  localOnly?: boolean,
): boolean {
  return !localOnly && cfg.sessionsSyncEnabled === true && Boolean(cfg.token);
}

export interface UploaderOptions {
  sessionsDir: string;
  projectHash: string;
  /** Ship the two derived free-text fields (decision reason + intent label).
   *  Off unless the team explicitly opted in — the code-egress boundary. */
  teamIntentOptIn?: boolean;
  /** POST a batch of derived events. Injected so the loop is testable and so the
   *  transport (auth, apiUrl) stays out of this module. Must reject on failure. */
  post: (events: UploadEvent[]) => Promise<void>;
  batchSize?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  /** injectable sleeper for tests; defaults to real setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

/** Try to flush as many whole batches as possible; stop at the first failure so
 *  the rest is retried next tick. Never throws. Returns the events still queued. */
async function drain(
  pending: UploadEvent[],
  batchSize: number,
  post: (e: UploadEvent[]) => Promise<void>,
): Promise<UploadEvent[]> {
  while (pending.length > 0) {
    const chunk = pending.slice(0, batchSize);
    try {
      await post(chunk);
    } catch {
      break; // keep everything from here on; retry next tick
    }
    pending.splice(0, chunk.length);
  }
  return pending;
}

export async function runUploader(opts: UploaderOptions): Promise<void> {
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_BATCH;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const follower = new SessionFollower(opts.sessionsDir, opts.projectHash);
  let pending: UploadEvent[] = [];

  while (!opts.signal?.aborted) {
    let batch: SessionEvent[];
    try {
      batch = await follower.poll();
    } catch {
      batch = []; // fail-open: a read error is an empty tick, never a crash
    }
    for (const ev of batch) {
      const u = toUploadEvent(ev, { teamIntentOptIn: opts.teamIntentOptIn });
      if (u) pending.push(u);
    }
    // Cap the buffer: under a long outage, drop the OLDEST derived events rather
    // than grow memory unbounded (they are advisory analytics, not the ledger).
    if (pending.length > MAX_BUFFER) pending = pending.slice(pending.length - MAX_BUFFER);

    pending = await drain(pending, batchSize, opts.post);

    if (opts.signal?.aborted) break;
    await sleep(interval);
  }
  // A final best-effort flush on shutdown, time-bounded so a hanging network
  // can't wedge the terminal after Ctrl-C (the tape cleanup awaits this task).
  await Promise.race([
    drain(pending, batchSize, opts.post),
    new Promise<void>((r) => setTimeout(r, SHUTDOWN_FLUSH_MS)),
  ]);
}
