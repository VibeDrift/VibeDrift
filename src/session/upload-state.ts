/**
 * Durable per-ledger-file upload offsets (the N0 heart).
 *
 * The uploader used to keep offsets in memory and tail only the newest ledger
 * file, so sessions recorded while no watcher ran never reached the dashboard
 * (G1). This store persists, per ledger file, the offset up to which every
 * event has been POSITIVELY acknowledged — so any later uploader resumes
 * exactly where the last one stopped, across files and process restarts.
 *
 * Offsets are indexes into the utf8-DECODED file content (string indexes),
 * matching how the followers read (whole-file readFile("utf8") + slicing), so
 * they are stable across processes reading the same bytes.
 *
 * Fail-open everywhere: missing or corrupt state resumes from zero. That is
 * safe because the ingest endpoint is idempotent per activity id and replays
 * report "duplicate". Each write is atomic (tmp + rename) and max-merges
 * against the on-disk state at read time. The read-merge-write is NOT atomic
 * across processes, though: two flush children with independent in-memory
 * snapshots can race, and the later writer's merge window may drop an offset
 * the other just committed, regressing that file backward. This is deliberate
 * and harmless. The store is lock-free on purpose (a stranded lockfile from a
 * SIGKILLed flush child would wedge the hook), and a regressed offset only
 * re-sends already-acknowledged events, which ingest dedups as "duplicate"
 * while the watermark re-advances on the next pass. Nothing reaches findings,
 * scores, or billing.
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeSegment } from "./ledger.js";

const STATE_VERSION = 1 as const;
const STATE_FILE = "upload-state.json";

/** Process-unique tmp suffix. `process.pid` alone collides when two stores in
 *  the SAME process commit concurrently (unit tests, or two in-process
 *  uploaders), which would tear the tmp file; a monotonic counter makes every
 *  write target a distinct tmp path so the rename stays atomic. */
let tmpCounter = 0;

interface UploadStateShape {
  v: typeof STATE_VERSION;
  files: Record<string, { offset: number }>;
}

export function uploadStatePath(sessionsDir: string, projectHash: string): string {
  return join(sessionsDir, safeSegment(projectHash), STATE_FILE);
}

function parseState(raw: string): Record<string, { offset: number }> {
  try {
    const parsed = JSON.parse(raw) as Partial<UploadStateShape>;
    if (!parsed || parsed.v !== STATE_VERSION || typeof parsed.files !== "object" || parsed.files === null) {
      return {};
    }
    const out: Record<string, { offset: number }> = {};
    for (const [file, v] of Object.entries(parsed.files)) {
      const off = (v as { offset?: unknown } | null)?.offset;
      if (typeof off === "number" && Number.isFinite(off) && off >= 0) out[file] = { offset: off };
    }
    return out;
  } catch {
    return {}; // corrupt: resume from zero, dedup absorbs re-sends
  }
}

export class UploadStateStore {
  private readonly dir: string;
  private readonly path: string;
  private files: Record<string, { offset: number }> = {};

  constructor(sessionsDir: string, projectHash: string) {
    this.dir = join(sessionsDir, safeSegment(projectHash));
    this.path = uploadStatePath(sessionsDir, projectHash);
  }

  /** Load persisted offsets; prune entries for ledgers that no longer exist. Never throws. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      this.files = {};
      return;
    }
    const loaded = parseState(raw);
    try {
      const existing = new Set(await readdir(this.dir));
      for (const file of Object.keys(loaded)) if (!existing.has(file)) delete loaded[file];
    } catch {
      // listing failed: keep entries rather than forget progress
    }
    this.files = loaded;
  }

  /** Committed offset for a ledger basename (0 when unknown). */
  get(file: string): number {
    return this.files[file]?.offset ?? 0;
  }

  /**
   * Merge offsets forward and persist. Each write is atomic (tmp + rename) and
   * re-reads the on-disk state first to max-merge with a concurrent writer's
   * progress. That merge only sees what is on disk at read time, so it is NOT a
   * cross-process monotonicity guarantee: a racing writer that reads before this
   * write lands but writes after it can overwrite an offset with its own stale
   * snapshot, regressing a file backward. Deliberately lock-free (see the module
   * header); a regressed offset is harmless because the re-sent events dedup as
   * "duplicate" and the watermark re-advances. Never throws: a failed persist
   * just means the next run re-sends a little, which dedup absorbs.
   */
  async commit(entries: ReadonlyMap<string, number>): Promise<void> {
    let changed = false;
    for (const [file, off] of entries) {
      if (off > (this.files[file]?.offset ?? 0)) {
        this.files[file] = { offset: off };
        changed = true;
      }
    }
    if (!changed) return;
    try {
      // max-merge with whatever is on disk right now (racing uploader)
      try {
        const onDisk = parseState(await readFile(this.path, "utf8"));
        for (const [file, v] of Object.entries(onDisk)) {
          if (v.offset > (this.files[file]?.offset ?? 0)) this.files[file] = { offset: v.offset };
        }
      } catch {
        // no/corrupt on-disk state: ours wins
      }
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const body = JSON.stringify({ v: STATE_VERSION, files: this.files } satisfies UploadStateShape);
      const tmp = `${this.path}.tmp.${process.pid}.${tmpCounter++}`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, this.path);
    } catch {
      // fail-open: offsets stay in memory for this run
    }
  }
}
