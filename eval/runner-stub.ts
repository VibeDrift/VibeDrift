import type { AgentRunner, Artifact, EvalTask, RepoContext, Treatment } from "./types.js";

// Multi-line bodies (asyncCounts is per-line, so async ops must be on their own
// lines). The function name is derived from the task so the artifact is plausible.
function driftingBody(name: string): string {
  return [
    `export function ${name}(repo, id) {`,
    `  return repo.findById(id)`,
    `    .then((row) => enrich(row))`,
    `    .then((full) => full);`,
    `}`,
  ].join("\n");
}

function conformingBody(name: string): string {
  return [
    `export async function ${name}(repo, id) {`,
    `  const row = await repo.findById(id);`,
    `  const full = await enrich(row);`,
    `  if (!row) throw new NotFoundError("${name}");`,
    `  return full;`,
    `}`,
  ].join("\n");
}

function fnName(task: EvalTask): string {
  // "thing.ts" → "loadThing"; keep it deterministic + a valid identifier.
  const base = task.targetPath.replace(/\.[tj]s$/, "").replace(/[^A-Za-z0-9]/g, "");
  return "load" + (base.charAt(0).toUpperCase() + base.slice(1) || "Thing");
}

/**
 * Deterministic test double for AgentRunner. Models the core hypothesis without
 * an LLM: WITHOUT VibeDrift ("none") the agent writes a `.then()` chain that
 * drifts from these async/await repos; WITH VibeDrift's guidance ("context") it
 * writes conforming async/await. Lets the whole pipeline (orchestrator + delta)
 * be unit-tested against a known, asserted outcome.
 */
export class StubRunner implements AgentRunner {
  async run(_ctx: RepoContext, task: EvalTask, treatment: Treatment): Promise<Artifact[]> {
    const name = fnName(task);
    const body = treatment === "none" ? driftingBody(name) : conformingBody(name);
    return [{ path: task.targetPath, body }];
  }
}
