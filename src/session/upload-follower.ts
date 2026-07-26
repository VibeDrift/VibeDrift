/**
 * Upload-side ledger reader: ALL session files, resumable, with backpressure.
 *
 * The live tape's SessionFollower deliberately tails only the newest ledger
 * file (that is what a viewer wants). The uploader needs the opposite: every
 * ledger file in the project dir, oldest first, each resumed from its durable
 * committed offset — so sessions recorded while nothing watched are backfilled
 * the next time any uploader runs, and a restart never re-reads what was
 * already acknowledged.
 *
 * Backpressure (panel amendment R1): poll(budget) never returns more events
 * than the caller can hold, and NEVER advances a read position past an event
 * it did not hand over — so a first-run backfill flood (weeks of ledgers)
 * cannot overflow the pending buffer into silent drops. Unread remainder is
 * simply read again next poll from the same position.
 *
 * Same reading discipline as the tape follower: whole-file utf8 read, string
 * offsets, advance only past complete lines (half-written tails re-read next
 * poll), corrupt lines skipped (they still advance the offset — a torn line
 * must not wedge the file). Fail-open: any I/O error yields fewer events,
 * never a crash.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { safeSegment } from "./ledger.js";
import type { UploadStateStore } from "./upload-state.js";
import type { SessionEvent } from "./types.js";

export interface TrackedEvent {
  event: SessionEvent;
  /** Ledger file basename (durable-offset key). */
  file: string;
  /** String offset just past this event's line in the utf8-decoded content. */
  endOffset: number;
}

export class UploadFollower {
  private readonly dir: string;
  /** In-run read position per file (string offsets); seeded from the store. */
  private readonly readOffsets = new Map<string, number>();
  /** Byte size at last full read, so unchanged files are skipped without a read. */
  private readonly lastSizes = new Map<string, number>();

  constructor(
    sessionsDir: string,
    projectHash: string,
    private readonly store: UploadStateStore,
  ) {
    this.dir = join(sessionsDir, safeSegment(projectHash));
  }

  /**
   * Return up to `budget` parsed events across all ledger files, oldest file
   * first (mtime, name tie-break), each in ledger order with its endOffset.
   */
  async poll(budget: number): Promise<TrackedEvent[]> {
    if (budget <= 0) return [];
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const files: Array<{ name: string; mtime: number; size: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const s = await stat(join(this.dir, name));
        files.push({ name, mtime: s.mtimeMs, size: s.size });
      } catch {
        // vanished between readdir and stat
      }
    }
    files.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const out: TrackedEvent[] = [];
    for (const f of files) {
      if (out.length >= budget) break;
      const started = this.readOffsets.has(f.name);
      const seen = this.lastSizes.get(f.name);
      if (started && seen !== undefined && seen === f.size) continue; // append-only: nothing new

      let raw: string;
      try {
        raw = await readFile(join(this.dir, f.name), "utf8");
      } catch {
        continue;
      }

      let start = this.readOffsets.get(f.name) ?? this.store.get(f.name);
      if (raw.length < start) start = 0; // truncated/replaced: re-read (dedup absorbs)
      if (raw.length <= start) {
        this.readOffsets.set(f.name, start);
        this.lastSizes.set(f.name, Buffer.byteLength(raw, "utf8"));
        continue;
      }

      const slice = raw.slice(start);
      const lastNl = slice.lastIndexOf("\n");
      if (lastNl < 0) {
        // only a partial line so far: wait, and force a re-read next poll
        this.readOffsets.set(f.name, start);
        this.lastSizes.delete(f.name);
        continue;
      }

      // Walk line by line so each event carries its own endOffset, stopping
      // at the budget WITHOUT advancing past unreturned events (backpressure).
      let cursor = start;
      let consumedTo = start;
      let hitBudget = false;
      for (const line of slice.slice(0, lastNl).split("\n")) {
        const end = cursor + line.length + 1; // +1 for the newline
        if (line.trim()) {
          if (out.length >= budget) {
            hitBudget = true;
            break;
          }
          try {
            out.push({ event: JSON.parse(line) as SessionEvent, file: f.name, endOffset: end });
            consumedTo = end;
          } catch {
            consumedTo = end; // corrupt line: skip it, never wedge the file
          }
        } else {
          consumedTo = end;
        }
        cursor = end;
      }
      this.readOffsets.set(f.name, consumedTo);
      if (hitBudget || consumedTo < start + lastNl + 1) {
        // more remains in this file: force a re-read next poll
        this.lastSizes.delete(f.name);
        break;
      }
      this.lastSizes.set(f.name, Buffer.byteLength(raw, "utf8"));
    }
    return out;
  }

}
