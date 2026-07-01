/**
 * jsonl.ts — generic append-only JSONL IO (serialized appends, resilient load).
 * Used for the judged drift scores (store.ts remains the RunResult-typed store).
 */
import { readFile, appendFile } from "node:fs/promises";

let appendQueue: Promise<void> = Promise.resolve();

/** Append one row as a JSON line. Concurrent calls are serialized. */
export async function appendJsonl<T>(path: string, row: T): Promise<void> {
  appendQueue = appendQueue.then(() => appendFile(path, JSON.stringify(row) + "\n", "utf-8"));
  return appendQueue;
}

/** Load all rows. Returns [] if the file is absent; skips blank/corrupt lines. */
export async function loadJsonl<T>(path: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: T[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      console.warn(`[jsonl] skipping corrupt line: ${t.slice(0, 80)}`);
    }
  }
  return out;
}
