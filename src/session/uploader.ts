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
  /** true ONLY for the 402 entitlement lock — never for held-class results or
   *  a transient network failure. The caller uses this to lock capture at once
   *  instead of waiting for the next scheduled entitlement refresh. */
  locked: boolean;
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
      if (isIngestLocked(err)) return { pending, backOff: true, locked: true };
      return { pending, backOff: false, locked: false }; // network/transient: retry next tick
    }
    const rec = reconcileAck(chunk, ack ?? undefined);
    if (rec.commitUpTo.size > 0) await store.commit(rec.commitUpTo);
    for (const id of rec.rejectedIds) {
      process.stderr.write(`vibedrift sync: event ${id} permanently rejected by server\n`);
    }
    pending = [...rec.held, ...pending.slice(chunk.length)];
    if (rec.held.length > 0) return { pending, backOff: true, locked: false };
  }
  return { pending, backOff: false, locked: false };
}

export interface FlushResult {
  /** The server answered 402: the account is out of trial and not paid. */
  locked: boolean;
}

export interface FlushOptions extends UploaderOptions {
  /** Hard cap on total flush time (default 30s) so a slow network never wedges
   *  a Stop-spawned child. */
  budgetMs?: number;
  /** Test seam for the clock; defaults to Date.now. */
  now?: () => number;
}

/**
 * One-shot flush: drain the WHOLE project backlog to durable offsets, then
 * return. Shared by the Stop-hook session-flush (a short-lived detached child
 * that ships the turn's events) — no interval loop, no resident process.
 *
 * Stops when the ledger is fully drained, when the server holds (402 /
 * version-skew / transient — the next turn's flush retries), when it stops
 * making progress, or when the time budget elapses. Never throws; a failure
 * loses nothing (durable offsets + idempotent ingest).
 *
 * Returns `{ locked }` — true only when the server answered 402 (the account
 * is out of trial). The caller writes that through to the entitlement cache so
 * the hook gate stops capturing on the next event, instead of the paywall
 * staying invisible until the next scheduled refresh.
 */
export async function runUploaderOnce(opts: FlushOptions): Promise<FlushResult> {
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_BATCH;
  const maxBuffer = opts.maxBuffer && opts.maxBuffer > 0 ? opts.maxBuffer : DEFAULT_MAX_BUFFER;
  const budgetMs = opts.budgetMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const start = now();

  const store = new UploadStateStore(opts.sessionsDir, opts.projectHash);
  await store.load();
  const follower = new UploadFollower(opts.sessionsDir, opts.projectHash, store);

  let pending: TaggedUpload[] = [];
  let locked = false;
  while (!opts.signal?.aborted && now() - start < budgetMs) {
    const budget = maxBuffer - pending.length;
    let batch: Awaited<ReturnType<UploadFollower["poll"]>> = [];
    if (budget > 0) {
      try {
        batch = await follower.poll(budget);
      } catch {
        batch = [];
      }
    }
    for (const t of batch) {
      const u = toUploadEvent(t.event, { teamIntentOptIn: opts.teamIntentOptIn });
      if (u) pending.push({ event: u, file: t.file, endOffset: t.endOffset });
    }
    // Nothing queued and nothing new arrived -> the ledger is fully drained.
    if (pending.length === 0) {
      if (batch.length === 0) break;
      continue; // events all filtered out (non-uploadable); poll for more
    }
    const before = pending.length;
    const out = await drain(pending, batchSize, opts.post, store);
    pending = out.pending;
    if (out.locked) locked = true;
    // Hold, or no forward progress with nothing new to read -> give up this run.
    if (out.backOff) break;
    if (pending.length >= before && batch.length === 0) break;
  }
  return { locked };
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
