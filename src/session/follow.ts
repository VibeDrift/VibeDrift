/**
 * Poll-based tail of the active session ledger. No daemon, no fs.watch: each
 * poll reads bytes appended to the current session file since the last read and
 * returns the whole lines that arrived. Follows rotation to a newer session
 * file (a new agent session in the same repo). Fail-open: any I/O error yields
 * an empty batch rather than throwing into the render loop.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { safeSegment, parseJsonlLines } from "./ledger.js";
import type { SessionEvent } from "./types.js";

export class SessionFollower {
  private readonly dir: string;
  private activeFile: string | null = null;
  /** Per-file read offset, so switching back to an earlier file (leapfrogging
   *  mtimes across concurrent sessions) never replays events already emitted. */
  private readonly offsets = new Map<string, number>();

  constructor(sessionsDir: string, projectHash: string) {
    this.dir = join(sessionsDir, safeSegment(projectHash));
  }

  private async newestSessionFile(): Promise<string | null> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return null;
    }
    let newest: { file: string; mtime: number } | null = null;
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(this.dir, name);
      try {
        const s = await stat(file);
        // Tie-break equal mtimes by name so selection is deterministic.
        if (
          !newest ||
          s.mtimeMs > newest.mtime ||
          (s.mtimeMs === newest.mtime && file > newest.file)
        ) {
          newest = { file, mtime: s.mtimeMs };
        }
      } catch {
        // file vanished between readdir and stat; skip
      }
    }
    return newest?.file ?? null;
  }

  async poll(): Promise<SessionEvent[]> {
    const active = await this.newestSessionFile();
    if (!active) return [];
    this.activeFile = active;
    const offset = this.offsets.get(active) ?? 0;

    let raw: string;
    try {
      raw = await readFile(active, "utf8");
    } catch {
      return [];
    }
    // If the file shrank (truncated/replaced), reset to read it fresh.
    const start = raw.length < offset ? 0 : offset;
    if (raw.length <= start) {
      this.offsets.set(active, raw.length);
      return [];
    }

    const slice = raw.slice(start);
    // advance the offset only past the last COMPLETE line, so a half-written
    // trailing line is re-read whole on the next poll.
    const lastNl = slice.lastIndexOf("\n");
    if (lastNl < 0) return [];
    this.offsets.set(active, start + lastNl + 1);

    return parseJsonlLines(slice.slice(0, lastNl));
  }
}
