import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadTasks, repoDir } from "../../eval/fixtures.js";

describe("eval fixtures", () => {
  const tasks = loadTasks();

  it("loads a non-trivial task set", () => {
    expect(tasks.length).toBeGreaterThanOrEqual(8);
  });

  it("every task references an existing seed repo and a new (not-yet-existing) target file", () => {
    for (const t of tasks) {
      expect(t.id, "task id").toBeTruthy();
      expect(t.prompt.length, `prompt for ${t.id}`).toBeGreaterThan(20);
      const dir = repoDir(t.repo);
      expect(existsSync(dir), `repo dir for ${t.id}: ${dir}`).toBe(true);
      // targetPath is a NEW file the agent writes — it must not already exist
      expect(existsSync(join(dir, t.targetPath)), `${t.id} targetPath should not pre-exist`).toBe(false);
    }
  });

  it("covers both seed repos", () => {
    const repos = new Set(tasks.map((t) => t.repo));
    expect(repos.has("async-await-repo")).toBe(true);
    expect(repos.has("repository-pattern-repo")).toBe(true);
  });
});
