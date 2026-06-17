import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { EvalTask } from "./types.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

/** Absolute path to a seed repo by its dir name. */
export function repoDir(name: string): string {
  return join(FIXTURES, "repos", name);
}

/** Load a drift-tempting task set (default tasks.json; pass a filename to select
 *  a different set, e.g. "tasks-then.json" for the discriminating experiment). */
export function loadTasks(file = "tasks.json"): EvalTask[] {
  const raw = readFileSync(join(FIXTURES, file), "utf8");
  return (JSON.parse(raw) as { tasks: EvalTask[] }).tasks;
}
