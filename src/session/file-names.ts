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
 * Three rules hold this honest:
 *  1. The hash is NEVER re-derived here. Every entry's `fileHash` comes from
 *     `toUploadEvent()` itself, so a manifest entry can only ever describe a
 *     hash the events already carry. If the derivation changes, both move
 *     together by construction.
 *  2. Only this project's own ledger contributes, and only lines the uploader
 *     already committed (flushed). A line stamped with another project's hash
 *     is skipped, so a stray record can never be relabeled into this repo.
 *  3. Every path is validated client-side with the same rules the ingest
 *     endpoint applies (defense in depth): an absolute path, a drive letter, a
 *     `..` segment, a backslash, a control character or an overlong path never
 *     leaves the machine, even if some future producer wrote one to the ledger.
 *
 * Fail-open, always: nothing here throws, and it runs AFTER the event flush has
 * committed its offsets, so a names failure cannot block, delay or corrupt the
 * flush. Turning sharing off deletes what was uploaded; if that DELETE cannot
 * reach the server it is recorded as pending and retried on the next flush.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
/** Server path cap, mirrored client-side. */
export const MAX_REL_PATH_LEN = 300;

const STATE_VERSION = 1 as const;
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
      // Only this project's own records, and only paths that pass the wire rules.
      if (!ev || ev.projectHash !== projectHash) continue;
      const rel = ev.detail?.file;
      if (!isSafeRelPath(rel)) continue;
      // The hash comes from the upload schema itself: never re-derived here.
      const hash = toUploadEvent(ev)?.fileHash;
      if (!isFileHash(hash)) continue;
      if (!byHash.has(hash)) byHash.set(hash, rel);
    }
  }
  return [...byHash].map(([fileHash, path]) => ({ fileHash, path }));
}

export function namesStatePath(sessionsDir: string, projectHash: string): string {
  return join(sessionsDir, safeSegment(projectHash), STATE_FILE);
}

/** Hashes already accepted by the server, so a per-turn flush re-sends nothing.
 *  Fail-open: unreadable state means "send it again", which the server upserts. */
async function readUploadedHashes(sessionsDir: string, projectHash: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(namesStatePath(sessionsDir, projectHash), "utf8")) as {
      v?: number;
      uploaded?: unknown;
    };
    if (parsed?.v !== STATE_VERSION || !Array.isArray(parsed.uploaded)) return new Set();
    return new Set(parsed.uploaded.filter(isFileHash));
  } catch {
    return new Set();
  }
}

/** Merge newly-accepted hashes into the local record (atomic, never throws). */
async function recordUploadedHashes(sessionsDir: string, projectHash: string, hashes: string[]): Promise<void> {
  try {
    const merged = await readUploadedHashes(sessionsDir, projectHash);
    for (const h of hashes) merged.add(h);
    const dir = join(sessionsDir, safeSegment(projectHash));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = namesStatePath(sessionsDir, projectHash);
    const tmp = `${path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify({ v: STATE_VERSION, uploaded: [...merged] }), { mode: 0o600 });
    await rename(tmp, path);
  } catch {
    // fail-open: the next flush re-sends, which the server upserts
  }
}

/** Forget what was uploaded, so a later opt-in re-uploads from scratch. */
export async function clearUploadedNames(sessionsDir: string, projectHash: string): Promise<void> {
  try {
    await rm(namesStatePath(sessionsDir, projectHash), { force: true });
  } catch {
    // best effort
  }
}

export interface NamesSyncOptions {
  sessionsDir: string;
  projectHash: string;
  /** VibeDrift home: the activation store (the opt-in flag) lives here. */
  home: string;
  /** POST one batch of at most NAMES_BATCH_MAX entries. Must reject on failure. */
  postNames?: (entries: FileNameEntry[]) => Promise<unknown>;
  /** DELETE every uploaded name for this project. Must reject on failure. */
  deleteNames?: () => Promise<unknown>;
  /** false when the account is entitlement-locked: an owed deletion is still
   *  honored, but nothing new is uploaded. */
  canUpload?: boolean;
}

export interface NamesSyncResult {
  /** Entries the server accepted this run. */
  uploaded: number;
  /** Requests actually made. */
  batches: number;
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
  const res: NamesSyncResult = { uploaded: 0, batches: 0, deleted: false, deletePending: false };
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
    const known = await readUploadedHashes(sessionsDir, projectHash);
    const fresh = entries.filter((e) => !known.has(e.fileHash));
    if (fresh.length === 0) return res;

    for (let i = 0; i < fresh.length; i += NAMES_BATCH_MAX) {
      const batch = fresh.slice(i, i + NAMES_BATCH_MAX);
      try {
        await opts.postNames(batch);
      } catch {
        break; // one attempt per flush run; the rest waits for the next flush
      }
      res.batches++;
      res.uploaded += batch.length;
      await recordUploadedHashes(sessionsDir, projectHash, batch.map((e) => e.fileHash));
    }
    return res;
  } catch {
    return res; // a names fault is never the flush's problem
  }
}
