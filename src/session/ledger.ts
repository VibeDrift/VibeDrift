/**
 * Append-only JSONL session ledger.
 *
 * Writes are one line per event via a single appendFile call; readers tolerate
 * corrupt lines (an interrupted write must never take the tape down with it).
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { SessionEvent } from "./types.js";

/** Hard cap per line so a pathological prompt cannot bloat the ledger. */
const MAX_LINE_BYTES = 32 * 1024;

export function newActivityId(): string {
  return `evt-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

/** Confine an untrusted id (session id comes from the hook payload) to a single
 *  safe path segment: no separators, no `..`, so it can never escape the
 *  per-project sessions dir or target a directory that was never created. */
export function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 128) : "unknown";
}

export function sessionFilePath(baseDir: string, projectHash: string, sessionId: string): string {
  return join(baseDir, safeSegment(projectHash), `${safeSegment(sessionId)}.jsonl`);
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export async function appendEvent(
  baseDir: string,
  projectHash: string,
  sessionId: string,
  ev: SessionEvent,
): Promise<void> {
  const dir = join(baseDir, safeSegment(projectHash));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let line = JSON.stringify(ev);
  // Cap by UTF-8 BYTES, not code units: a CJK/emoji prompt is 1 code unit but
  // 3-4 bytes each, so a length check would pass lines ~3x over the cap.
  if (byteLen(line) > MAX_LINE_BYTES && ev.detail.promptText) {
    let kept = ev.detail.promptText;
    // Shrink until the whole serialized line fits, halving the prompt each pass
    // then trimming; cheap and convergent for any multibyte content.
    while (kept.length > 0 && byteLen(line) > MAX_LINE_BYTES) {
      const target = Math.max(0, Math.floor(kept.length * 0.75) - 16);
      kept = kept.slice(0, target);
      line = JSON.stringify({ ...ev, detail: { ...ev.detail, promptText: kept, truncated: true } });
    }
    if (byteLen(line) > MAX_LINE_BYTES) {
      line = JSON.stringify({ ...ev, detail: { ...ev.detail, promptText: "", truncated: true } });
    }
  }
  await appendFile(sessionFilePath(baseDir, projectHash, sessionId), `${line}\n`, { mode: 0o600 });
}

/** Parse a chunk of newline-delimited JSON events, skipping any corrupt line
 *  (an interrupted write must never take the reader down). Shared by the
 *  whole-file reader and the live follower. */
export function parseJsonlLines(chunk: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionEvent);
    } catch {
      // corrupt line: skip it, never throw
    }
  }
  return out;
}

export async function readSessionEvents(filePath: string): Promise<SessionEvent[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return parseJsonlLines(raw);
}
