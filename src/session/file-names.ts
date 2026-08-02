/**
 * The opt-in file-name manifest (per repo, default OFF).
 *
 * Derived events carry a file only as `fileHash` — a per-repo grouping
 * pseudonym (see upload-schema.ts) — so the dashboard can group by file but can
 * only ever say "file ab12cd34". A user who WANTS real names on their own
 * dashboard turns them on for one repo with `vibedrift watch-session --names on`,
 * and this module ships the hash -> repo-relative path mapping alongside the
 * flush. Paths only. Never file contents, never an absolute path, never a path
 * outside the repo.
 *
 * Four rules hold this honest:
 *  1. The hash is NEVER re-derived here. Every entry's `fileHash` comes from
 *     `toUploadEvent()` itself, so a manifest entry can only ever describe a
 *     hash the events already carry. If the derivation changes, both move
 *     together by construction.
 *  2. Only this project's own ledger contributes, and only lines the uploader
 *     already committed (flushed). A line stamped with another project's hash
 *     is skipped, so a stray record can never be relabeled into this repo.
 *  3. PROVENANCE, not path shape, decides what is in this repo. The hook stamps
 *     `detail.inRepo` when it resolves the edited file (hook-entry.ts). Only
 *     lines marked `inRepo: true` contribute; an unmarked line (written before
 *     the field existed) is unknown provenance and contributes nothing. That is
 *     what makes "nothing outside this repo" a fact rather than a hope. The hook
 *     also records an out-of-repo edit as `../<basename>`, a form no in-repo
 *     relative path can take, so the two can never be the same string and
 *     therefore never the same pseudonym: a hash this manifest puts a real name
 *     on cannot also stand for an edit outside the repo.
 *  4. Every path is ALSO validated client-side with the same rules the ingest
 *     endpoint applies (defense in depth): an absolute path, a drive letter, a
 *     `..` segment, a backslash, a control character or an overlong path never
 *     leaves the machine, even if some future producer wrote one to the ledger.
 *
 * A name counts as uploaded only when the SERVER says it stored it. The endpoint
 * answers HTTP 200 with `ok:false` (entries `held`, code `db_error`) when its
 * write fails, so a 2xx alone is not an acceptance: held entries stay out of the
 * local record and the next flush sends them again. What the local record tracks
 * is therefore SETTLED entries, not accepted ones: an entry the server refused
 * outright is settled too (a rejection will not change on a retry), and
 * recording it is what keeps it from riding along on every flush forever.
 *
 * Fail-open, always: nothing here throws, and it runs AFTER the event flush has
 * committed its offsets, so a names failure cannot block, delay or corrupt the
 * flush. Turning sharing off deletes what was uploaded; if that DELETE cannot
 * reach the server it is recorded as pending and retried on the next flush.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { debug } from "../core/debug.js";
import { safeSegment } from "./ledger.js";
import { UploadStateStore } from "./upload-state.js";
import { toUploadEvent } from "./upload-schema.js";
import {
  loadActivation,
  namesDeleteIsPending,
  setNamesDeletePending,
  shareFileNamesEnabled,
} from "./activation.js";
import type { SessionEvent } from "./types.js";

/** Server batch cap; a request never carries more than this many entries. */
export const NAMES_BATCH_MAX = 500;
/**
 * Byte cap per request, comfortably under the endpoint's 256KB body limit.
 * The entry cap alone is NOT enough: 500 entries of long multi-byte paths
 * measure several hundred KB, and because names upload fail-open a 413 would be
 * SILENT — the names would simply never appear on the dashboard.
 */
export const NAMES_BATCH_MAX_BYTES = 180 * 1024;
/** Room for the `{"projectHash":"...","names":[]}` envelope in that budget. */
const ENVELOPE_BYTES = 128;
/** Server path cap, mirrored client-side. */
export const MAX_REL_PATH_LEN = 300;

const STATE_VERSION = 2 as const;
const STATE_FILE = "names-state.json";

export interface FileNameEntry {
  /** 16 lowercase hex — the SAME pseudonym the derived events carry. */
  fileHash: string;
  /** Repo-relative path, e.g. `src/payments/refund.ts`. */
  path: string;
}

/** The 16-hex pseudonym shape the wire accepts. */
export function isFileHash(h: unknown): h is string {
  return typeof h === "string" && /^[0-9a-f]{16}$/.test(h);
}

/**
 * Client-side mirror of the ingest validation. A path is shareable only when it
 * is a plain repo-relative path: non-empty, within the length cap, no leading
 * "/", no drive letter, no `..` segment, no backslash, no control characters.
 * This is defense in depth, not a formality: it is the last gate before a path
 * leaves the machine.
 */
export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== "string") return false;
  if (p.trim().length === 0) return false;
  if (p.length > MAX_REL_PATH_LEN) return false;
  if (p.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(p)) return false; // C:\repo, c:/repo
  if (p.includes("\\")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return !p.split("/").some((seg) => seg === "..");
}

/**
 * Build this project's manifest from its OWN ledger: every distinct file whose
 * derived event has already been flushed (committed offsets), in ledger order.
 * Never throws; an unreadable ledger simply contributes nothing.
 */
export async function collectFileNames(sessionsDir: string, projectHash: string): Promise<FileNameEntry[]> {
  const dir = join(sessionsDir, safeSegment(projectHash));
  let files: string[];
  try {
    files = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const store = new UploadStateStore(sessionsDir, projectHash);
  await store.load();

  const byHash = new Map<string, string>();
  for (const name of files) {
    const committed = store.get(name);
    if (committed <= 0) continue; // nothing from this ledger has shipped yet
    let raw: string;
    try {
      raw = await readFile(join(dir, name), "utf8");
    } catch {
      continue;
    }
    let cursor = 0;
    for (const line of raw.split("\n")) {
      const end = cursor + line.length + 1; // +1 for the newline
      cursor = end;
      if (end > committed) break; // past what the uploader acknowledged
      if (!line.trim()) continue;
      let ev: SessionEvent;
      try {
        ev = JSON.parse(line) as SessionEvent;
      } catch {
        continue; // corrupt line: skip, never wedge the manifest
      }
      // Only this project's own records, only files the hook stamped as being
      // INSIDE this repo, and only paths that pass the wire rules.
      if (!ev || ev.projectHash !== projectHash) continue;
      if (ev.detail?.inRepo !== true) continue; // unmarked or out-of-repo: never shared
      const rel = ev.detail?.file;
      if (!isSafeRelPath(rel)) continue;
      // The hash comes from the upload schema itself: never re-derived here.
      const hash = toUploadEvent(ev)?.fileHash;
      if (!isFileHash(hash)) continue;
      byHash.set(hash, rel); // last occurrence wins; position stays ledger order
    }
  }
  return [...byHash].map(([fileHash, path]) => ({ fileHash, path }));
}

/**
 * Split a manifest into the requests that may actually be sent. The last gate
 * before the wire, so it re-applies every rule rather than trusting its input:
 *  - drops anything whose hash or path fails validation,
 *  - collapses a repeated fileHash (last occurrence wins) so no request can
 *    carry the same conflict target twice,
 *  - caps each request at NAMES_BATCH_MAX entries AND NAMES_BATCH_MAX_BYTES of
 *    serialized JSON, whichever binds first.
 */
export function planNameBatches(entries: readonly FileNameEntry[]): FileNameEntry[][] {
  const unique = new Map<string, string>();
  for (const e of entries) {
    if (!e || !isFileHash(e.fileHash) || !isSafeRelPath(e.path)) continue;
    unique.set(e.fileHash, e.path); // last occurrence wins, first position kept
  }

  const batches: FileNameEntry[][] = [];
  let current: FileNameEntry[] = [];
  let bytes = ENVELOPE_BYTES;
  for (const [fileHash, path] of unique) {
    const entry: FileNameEntry = { fileHash, path };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1; // +1 comma
    if (current.length > 0 && (current.length >= NAMES_BATCH_MAX || bytes + size > NAMES_BATCH_MAX_BYTES)) {
      batches.push(current);
      current = [];
      bytes = ENVELOPE_BYTES;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function namesStatePath(sessionsDir: string, projectHash: string): string {
  return join(sessionsDir, safeSegment(projectHash), STATE_FILE);
}

/**
 * Hashes the server has SETTLED — stored, deduplicated onto an existing row, or
 * refused outright — so a per-turn flush re-sends none of them. A held entry is
 * never in here: it is the one outcome a retry can still change.
 *
 * Fail-open: unreadable state (including a v1 file, which recorded accepted
 * entries only) means "send it again", which the server upserts.
 */
async function readSettledHashes(sessionsDir: string, projectHash: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(namesStatePath(sessionsDir, projectHash), "utf8")) as {
      v?: number;
      settled?: unknown;
    };
    if (parsed?.v !== STATE_VERSION || !Array.isArray(parsed.settled)) return new Set();
    return new Set(parsed.settled.filter(isFileHash));
  } catch {
    return new Set();
  }
}

/** Merge newly-settled hashes into the local record (atomic, never throws). */
async function recordSettledHashes(sessionsDir: string, projectHash: string, hashes: string[]): Promise<void> {
  try {
    const merged = await readSettledHashes(sessionsDir, projectHash);
    for (const h of hashes) merged.add(h);
    const dir = join(sessionsDir, safeSegment(projectHash));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = namesStatePath(sessionsDir, projectHash);
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify({ v: STATE_VERSION, settled: [...merged] }), { mode: 0o600 });
    await rename(tmp, path);
  } catch {
    // fail-open: the next flush re-sends, which the server upserts
  }
}

/** Forget what the server settled, so a later opt-in re-uploads from scratch. */
export async function clearUploadedNames(sessionsDir: string, projectHash: string): Promise<void> {
  try {
    await rm(namesStatePath(sessionsDir, projectHash), { force: true });
  } catch {
    // best effort
  }
}

/** What the server reports per batch. Legacy/void answers count as all-stored. */
export interface NamesPostAck {
  /**
   * `false` when the server answered 200 but did NOT persist the batch (its
   * write failed, so every entry comes back `held`). Honoring this is what
   * makes the upload recoverable: a held batch is left out of the local record
   * so the NEXT flush sends it again. Absent means "stored" (a legacy or void
   * answer), which is the only safe reading of a server that predates the flag.
   */
  ok?: boolean;
  stored?: number;
  /** Entries the server refused (bad hash/path, duplicate in batch). */
  rejected?: number;
  /** Per-entry outcome, when the server reports one. Only `stored` (and
   *  `duplicate`, whose winning entry IS stored) means the row exists; `held`
   *  and `rejected` do not. */
  results?: Array<{ fileHash?: string | null; status?: string; code?: string }>;
}

/** What a batch's ack says happened per entry, or null when it carries no
 *  per-entry detail (then the batch is judged as a whole). `stored` is what is
 *  actually on the server (`duplicate`'s winning entry is); `rejected` is what
 *  the server refused. Anything else (`held`) is neither, and stays retryable. */
function perEntryOutcome(ack: NamesPostAck | void): { stored: Set<string>; rejected: Set<string> } | null {
  if (!ack || !Array.isArray(ack.results)) return null;
  const stored = new Set<string>();
  const rejected = new Set<string>();
  for (const r of ack.results) {
    if (!r || !isFileHash(r.fileHash)) continue;
    if (r.status === "stored" || r.status === "duplicate") stored.add(r.fileHash);
    else if (r.status === "rejected") rejected.add(r.fileHash);
  }
  return { stored, rejected };
}

/** Entries this ack reports as accepted-but-unstored. 0 when it says nothing. */
function heldCount(ack: NamesPostAck | void): number {
  if (!ack || !Array.isArray(ack.results)) return 0;
  return ack.results.filter((r) => r?.status === "held").length;
}

export interface NamesSyncOptions {
  sessionsDir: string;
  projectHash: string;
  /** VibeDrift home: the activation store (the opt-in flag) lives here. */
  home: string;
  /** POST one planned batch. Must reject on failure. */
  postNames?: (entries: FileNameEntry[]) => Promise<NamesPostAck | void>;
  /** DELETE every uploaded name for this project. Must reject on failure. */
  deleteNames?: () => Promise<unknown>;
  /** false when the account is entitlement-locked: an owed deletion is still
   *  honored, but nothing new is uploaded. */
  canUpload?: boolean;
}

export interface NamesSyncResult {
  /** Entries the server actually stored. */
  uploaded: number;
  /** Requests actually made. */
  batches: number;
  /** Entries the server itself refused (should be 0: we validate first).
   *  Settled, so they are recorded locally and never sent again. */
  rejected: number;
  /** Entries the server accepted the request for but did NOT store (`ok:false`
   *  or a per-entry `held`). Deliberately left unrecorded: the next flush
   *  re-sends them. */
  held: number;
  /** An owed opt-out deletion completed this run. */
  deleted: boolean;
  /** A deletion is still owed to the server (retried on the next flush). */
  deletePending: boolean;
}

/**
 * The flush-time names step: settle any owed opt-out deletion, then (only when
 * the repo opted in) upload the entries the server has not seen yet. One
 * attempt per flush run: a failed request stops the run instead of retrying, so
 * a bad server never turns into a request storm. Never throws.
 */
export async function syncFileNames(opts: NamesSyncOptions): Promise<NamesSyncResult> {
  const res: NamesSyncResult = { uploaded: 0, batches: 0, rejected: 0, held: 0, deleted: false, deletePending: false };
  try {
    const { sessionsDir, projectHash, home } = opts;
    const store = loadActivation(home);

    // 1. The user's opt-out outranks everything: settle it first, even when the
    //    account is locked (it is a deletion, not an upload).
    if (namesDeleteIsPending(store, projectHash)) {
      res.deletePending = true;
      if (opts.deleteNames) {
        try {
          await opts.deleteNames();
          setNamesDeletePending(projectHash, false, home);
          await clearUploadedNames(sessionsDir, projectHash);
          res.deleted = true;
          res.deletePending = false;
        } catch {
          // still owed: the next flush tries again
        }
      }
    }

    // 2. Uploads are opt-in, and never happen for a locked account.
    if (opts.canUpload === false || !opts.postNames || !shareFileNamesEnabled(store, projectHash)) return res;

    const entries = await collectFileNames(sessionsDir, projectHash);
    if (entries.length === 0) return res;
    const known = await readSettledHashes(sessionsDir, projectHash);
    const fresh = entries.filter((e) => !known.has(e.fileHash));
    if (fresh.length === 0) return res;

    for (const batch of planNameBatches(fresh)) {
      let ack: NamesPostAck | void;
      try {
        ack = await opts.postNames(batch);
      } catch {
        break; // one attempt per flush run; the rest waits for the next flush
      }
      res.batches++;
      if (ack && typeof ack.rejected === "number") res.rejected += ack.rejected;

      // A 200 is NOT an acceptance: the server answers ok:false (every entry
      // `held`) when its write failed. Recording those hashes would filter them
      // out of every future flush — the names would be lost for good, silently.
      if (ack && ack.ok === false) {
        res.held += batch.length;
        break; // one attempt per run: the next flush re-sends this batch
      }
      const outcome = perEntryOutcome(ack);
      const stored = outcome ? batch.filter((e) => outcome.stored.has(e.fileHash)) : batch;
      res.uploaded += stored.length;
      res.held += heldCount(ack);
      // Record everything the server SETTLED, which is more than what it stored:
      // a rejection is final (we validate before sending, so a server that
      // refuses this entry will refuse it again), and leaving it out of the
      // record is what had every later flush carry it again forever. A held
      // entry is deliberately excluded: that one a retry can still fix.
      const settled = outcome
        ? batch.filter((e) => outcome.stored.has(e.fileHash) || outcome.rejected.has(e.fileHash))
        : batch;
      if (settled.length > 0) {
        await recordSettledHashes(sessionsDir, projectHash, settled.map((e) => e.fileHash));
      }
    }
    // Said once, quietly: a held entry is not an error the user can act on, and
    // it costs nothing (the next flush re-sends it).
    if (res.held > 0) {
      debug("session-names", `${res.held} file-name entr${res.held === 1 ? "y" : "ies"} held by the server; retrying on the next flush`);
    }
    // We validate before sending, so a rejection means the server disagrees with
    // this client. Say so once, quietly, and never retry it.
    if (res.rejected > 0) {
      debug("session-names", `${res.rejected} file-name entr${res.rejected === 1 ? "y" : "ies"} rejected by the server`);
    }
    return res;
  } catch {
    return res; // a names fault is never the flush's problem
  }
}
