/**
 * Session overlay index: the functions a session has written so far, kept next
 * to the ledger so the inline duplicate check can see them.
 *
 * The baseline's minhash index is built at scan time and only read during a
 * session. On a recorded session the baseline was eight days old by the time
 * the agent wrote two byte-identical `monthTitle` functions fifteen minutes
 * apart, both through the Write tool: neither was in the index, so no flag
 * fired; and a real duplicate was paired with the wrong counterpart because
 * the right one, written two days into the session, was not indexed either.
 *
 * The overlay closes that gap without rebuilding anything: after every
 * CHECKED edit the file's functions are extracted and signed the way the
 * baseline builder signs them, and stored per file in a session sidecar.
 * The next check merges the overlay entries of every OTHER file into the
 * index it queries. Bounded: at most OVERLAY_MAX_ENTRIES functions, oldest
 * file evicted first. Fail-open throughout: a lost overlay only means the
 * check is back to baseline-only.
 */

import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.js";
import { join } from "node:path";
import type { MinhashEntry } from "../core/baseline.js";
import { extractAllFunctions } from "../codedna/function-extractor.js";
import { buildSignature } from "../codedna/minhash.js";
import { detectLanguage } from "../core/language.js";
import { safeSegment } from "./ledger.js";

export const OVERLAY_MAX_ENTRIES = 500;

/** On-disk shape: signatures as number[] (JSON has no typed arrays), files in
 *  insertion order (oldest first) so eviction needs no timestamps. */
interface SerializedOverlay {
  v: 1;
  files: Array<{
    file: string;
    entries: Array<Omit<MinhashEntry, "signature"> & { signature: number[] }>;
  }>;
}

export interface Overlay {
  /** file -> its entries, oldest file first */
  files: Map<string, MinhashEntry[]>;
}

export function overlayPath(sessionsDir: string, projectHash: string, sessionId: string): string {
  return join(sessionsDir, safeSegment(projectHash), `${safeSegment(sessionId)}.overlay.json`);
}

export async function readOverlay(sessionsDir: string, projectHash: string, sessionId: string): Promise<Overlay> {
  try {
    const raw = await readFile(overlayPath(sessionsDir, projectHash, sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<SerializedOverlay>;
    const files = new Map<string, MinhashEntry[]>();
    for (const f of Array.isArray(parsed.files) ? parsed.files : []) {
      if (!f || typeof f.file !== "string" || !Array.isArray(f.entries)) continue;
      files.set(
        f.file,
        f.entries
          .filter((e) => e && typeof e.name === "string" && Array.isArray(e.signature) && Array.isArray(e.tokens))
          .map((e) => ({ ...e, signature: Uint32Array.from(e.signature) })),
      );
    }
    return { files };
  } catch {
    return { files: new Map() };
  }
}

export async function writeOverlay(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
  overlay: Overlay,
): Promise<void> {
  try {
    const serial: SerializedOverlay = {
      v: 1,
      files: [...overlay.files.entries()].map(([file, entries]) => ({
        file,
        entries: entries.map((e) => ({ ...e, signature: Array.from(e.signature) })),
      })),
    };
    await mkdir(join(sessionsDir, safeSegment(projectHash)), { recursive: true, mode: 0o700 });
    // Atomic, like every other per-session sidecar (see ./atomic-write.ts): the
    // hook arms a 2 s self-timeout and can be killed mid-write, and a plain
    // writeFile truncates in place. This is the largest of the sidecars, so it
    // is the one most likely to be caught mid-write, and a half-written overlay
    // parses as no overlay: the very same-session duplicates this index exists
    // to catch would stop being caught, silently.
    await writeFileAtomic(
      overlayPath(sessionsDir, projectHash, sessionId),
      JSON.stringify(serial),
      { mode: 0o600 },
    );
  } catch {
    // best-effort: a lost overlay means baseline-only checks, never a failure
  }
}

/** Index entries for `relFile`'s current content, signed exactly as the
 *  baseline builder signs them (same extractor, same signature). */
export function overlayEntriesFor(relFile: string, content: string): MinhashEntry[] {
  const language = detectLanguage(relFile);
  if (!language) return [];
  try {
    const fns = extractAllFunctions([
      { path: relFile, relativePath: relFile, language, content, lineCount: content.split("\n").length },
    ]);
    return fns.map((fn) => {
      const sig = buildSignature(fn.rawBody);
      return { relativePath: relFile, name: fn.name, line: fn.line, tokens: sig.tokens, signature: sig.signature };
    });
  } catch {
    return [];
  }
}

/** Replace `relFile`'s entries (moving it to newest), then evict the oldest
 *  files until the overlay holds at most OVERLAY_MAX_ENTRIES entries. Pure. */
export function updateOverlay(overlay: Overlay, relFile: string, entries: MinhashEntry[]): Overlay {
  const files = new Map(overlay.files);
  files.delete(relFile);
  if (entries.length > 0) files.set(relFile, entries);
  let total = 0;
  for (const e of files.values()) total += e.length;
  for (const [file, e] of files) {
    if (total <= OVERLAY_MAX_ENTRIES) break;
    if (file === relFile) continue;
    files.delete(file);
    total -= e.length;
  }
  return { files };
}

/** Every overlay entry except `relFile`'s own: a file must never match itself. */
export function overlayEntriesExcept(overlay: Overlay, relFile: string): MinhashEntry[] {
  const out: MinhashEntry[] = [];
  for (const [file, entries] of overlay.files) {
    if (file === relFile) continue;
    out.push(...entries);
  }
  return out;
}
