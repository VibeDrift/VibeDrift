/**
 * Drift Sessions derived-only uploader — durable, resumable, ack-gated (N0).
 *
 * Reads EVERY ledger file for the project (oldest first) through the
 * UploadFollower, maps each event to its derived `UploadEvent`
 * (src/session/upload-schema.ts), posts batches through the injected `post`,
 * and persists per-file offsets ONLY through the contiguous prefix of events
 * the server positively acknowledged (accepted / duplicate / permanently
 * rejected). Held events (entitlement lock, version skew, transient server
 * trouble) stay pending, nothing past them commits, and intake backpressure
 * keeps the buffer bounded instead of dropping — so a first-run backfill of
 * weeks of ledgers arrives complete (the R1 rule), and a lock never advances
 * offsets over unstored data (the R3 rule).
 *
 * It runs ONLY when the caller has confirmed opt-in + login (`watch-session`
 * gates it today; the MCP streamer and session-flush share this loop); it is
 * never on the hook's critical path. Fail-open in the strong sense: a failed
 * flush never throws and never loses events — they stay queued, retried after
 * a backoff, and a process death resumes from the durable offsets (re-sends
 * are absorbed by server idempotency).
 */

import { UploadFollower } from "./upload-follower.js";
import { UploadStateStore } from "./upload-state.js";
import { reconcileAck, isIngestLocked, type IngestAck, type TaggedUpload } from "./ingest-ack.js";
import { toUploadEvent, type UploadEvent } from "./upload-schema.js";

const DEFAULT_BATCH = 50;
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_MAX_BUFFER = 2000;
/** Ticks to skip draining after a hold-class response (locked account,
 *  version skew): retrying every second would hammer a server that already
 *  said "not now". Intake continues under backpressure; only sending pauses. */
const HOLD_BACKOFF_TICKS = 30;
/** Cap the best-effort flush after Ctrl-C so a hanging network can't freeze
 *  the terminal (the tape's cleanup awaits this). */
const SHUTDOWN_FLUSH_MS = 2500;

/** Whether hosted sync should run this session: opted in, logged in, and not
 *  forced local for this run. Pure so the gate is unit-testable. Off by
 *  default in every dimension — sync never starts by accident. */
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
  /** POST a batch of derived events; resolves with the server ack (legacy
   *  servers: `{ accepted }` only). Must reject on failure; a rejection with
   *  status 402 means the whole batch is entitlement-locked. */
  post: (events: UploadEvent[]) => Promise<IngestAck | void>;
  batchSize?: number;
  intervalMs?: number;
  /** Pending-buffer bound; intake pauses (backpressure) at this size. */
  maxBuffer?: number;
  signal?: AbortSignal;
  /** injectable sleeper for tests; defaults to real setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** ticks to pause sending after a hold-class response (test seam). */
  holdBackoffTicks?: number;
}

interface DrainOutcome {
  pending: TaggedUpload[];
  /** true when the server said hold (402 or held-class results). */
  backOff: boolean;
}

/** Flush as many whole batches as the server accepts; stop at the first hold
 *  or failure so the rest is retried later. Commits durable offsets for every
 *  contiguously-acknowledged prefix. Never throws. */
async function drain(
  pending: TaggedUpload[],
  batchSize: number,
  post: UploaderOptions["post"],
  store: UploadStateStore,
): Promise<DrainOutcome> {
  while (pending.length > 0) {
    const chunk = pending.slice(0, batchSize);
    let ack: IngestAck | void;
    try {
      ack = await post(chunk.map((t) => t.event));
    } catch (err) {
      if (isIngestLocked(err)) return { pending, backOff: true };
      return { pending, backOff: false }; // network/transient: retry next tick
    }
    const rec = reconcileAck(chunk, ack ?? undefined);
    if (rec.commitUpTo.size > 0) await store.commit(rec.commitUpTo);
    for (const id of rec.rejectedIds) {
      process.stderr.write(`vibedrift sync: event ${id} permanently rejected by server\n`);
    }
    pending = [...rec.held, ...pending.slice(chunk.length)];
    if (rec.held.length > 0) return { pending, backOff: true };
  }
  return { pending, backOff: false };
}

export async function runUploader(opts: UploaderOptions): Promise<void> {
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_BATCH;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxBuffer = opts.maxBuffer && opts.maxBuffer > 0 ? opts.maxBuffer : DEFAULT_MAX_BUFFER;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const store = new UploadStateStore(opts.sessionsDir, opts.projectHash);
  await store.load();
  const follower = new UploadFollower(opts.sessionsDir, opts.projectHash, store);

  let pending: TaggedUpload[] = [];
  let holdTicks = 0;

  while (!opts.signal?.aborted) {
    // Intake under backpressure: never read more than the buffer can hold, so
    // read positions never advance past events we could not queue (R1).
    const budget = maxBuffer - pending.length;
    if (budget > 0) {
      let batch: Awaited<ReturnType<UploadFollower["poll"]>>;
      try {
        batch = await follower.poll(budget);
      } catch {
        batch = []; // fail-open: a read error is an empty tick, never a crash
      }
      for (const t of batch) {
        const u = toUploadEvent(t.event, { teamIntentOptIn: opts.teamIntentOptIn });
        if (u) pending.push({ event: u, file: t.file, endOffset: t.endOffset });
      }
    }

    if (holdTicks > 0) {
      holdTicks--;
    } else if (pending.length > 0) {
      const out = await drain(pending, batchSize, opts.post, store);
      pending = out.pending;
      if (out.backOff) holdTicks = opts.holdBackoffTicks ?? HOLD_BACKOFF_TICKS;
    }

    if (opts.signal?.aborted) break;
    await sleep(interval);
  }

  // Final best-effort flush on shutdown, time-bounded so a hanging network
  // can't wedge the terminal after Ctrl-C.
  await Promise.race([
    drain(pending, batchSize, opts.post, store),
    new Promise<void>((r) => setTimeout(r, SHUTDOWN_FLUSH_MS)),
  ]);
}
