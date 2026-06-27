import { readFile, appendFile } from "node:fs/promises";
import type { RunResult } from "./types.js";

// Module-level promise chain that serializes concurrent appendResult calls.
// Prevents interleaved writes when multiple workers call appendResult in parallel.
let appendQueue: Promise<void> = Promise.resolve();

/** Append one RunResult as a JSON line to the JSONL file at `path`. */
export async function appendResult(path: string, row: RunResult): Promise<void> {
  appendQueue = appendQueue.then(() =>
    appendFile(path, JSON.stringify(row) + "\n", "utf-8"),
  );
  return appendQueue;
}

/**
 * Read the JSONL file at `path` and return all RunResult rows in order.
 * Returns [] if the file does not exist.
 * Corrupt lines (invalid JSON) are skipped with a console.warn; blank lines
 * are silently skipped.
 */
export async function loadResults(path: string): Promise<RunResult[]> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: RunResult[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as RunResult);
    } catch {
      console.warn(`[store] Skipping corrupt JSONL line: ${trimmed.slice(0, 80)}`);
    }
  }
  return results;
}
