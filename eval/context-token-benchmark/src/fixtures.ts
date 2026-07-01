/**
 * fixtures.ts — load pinned repos + tasks from the fixtures/ directory.
 * Shared by the run (cli.ts), judge (judge-cli.ts), and analyze (analyze-cli.ts) steps.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RepoSpec, TaskSpec } from "./types.js";

export async function loadRepos(fixturesDir: string): Promise<RepoSpec[]> {
  const raw = await readFile(join(fixturesDir, "repos.json"), "utf-8");
  return JSON.parse(raw) as RepoSpec[];
}

export async function loadTasks(fixturesDir: string): Promise<TaskSpec[]> {
  const tasksDir = join(fixturesDir, "tasks");
  const entries = await readdir(tasksDir);
  const tasks: TaskSpec[] = [];
  for (const entry of entries.filter((e) => e.endsWith(".json"))) {
    const raw = await readFile(join(tasksDir, entry), "utf-8");
    tasks.push(JSON.parse(raw) as TaskSpec);
  }
  return tasks;
}

export function tasksById(tasks: TaskSpec[]): Map<string, TaskSpec> {
  return new Map(tasks.map((t) => [t.id, t]));
}
