import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expandMatrix, armOrder, orchestrate } from "../src/orchestrate.js";
import { appendResult } from "../src/store.js";
import type { RepoSpec, TaskSpec, Arm, RunResult } from "../src/types.js";
import type { MatrixItem } from "../src/orchestrate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_A: RepoSpec = {
  id: "repo-a",
  language: "typescript",
  gitUrl: "https://github.com/example/repo-a",
  sha: "aaa111",
  testCmd: "npm test",
  postCutoff: false,
};

const REPO_B: RepoSpec = {
  id: "repo-b",
  language: "python",
  gitUrl: "https://github.com/example/repo-b",
  sha: "bbb222",
  testCmd: "pytest",
  postCutoff: true,
};

const TASK_A1: TaskSpec = {
  id: "task-a1",
  repoId: "repo-a",
  kind: "positive",
  prompt: "Fix the bug in src/index.ts",
  gateTestCmd: "npm test",
};

const TASK_A2: TaskSpec = {
  id: "task-a2",
  repoId: "repo-a",
  kind: "negative-control",
  prompt: "Refactor src/utils.ts",
  gateTestCmd: "npm test",
};

const TASK_B1: TaskSpec = {
  id: "task-b1",
  repoId: "repo-b",
  kind: "positive",
  prompt: "Fix the bug in main.py",
  gateTestCmd: "pytest",
};

/** Minimal valid RunResult factory */
function makeResult(item: MatrixItem): RunResult {
  return {
    runId: `${item.repo.id}__${item.task.id}__${item.arm}__r${item.replicate}`,
    repoId: item.repo.id,
    taskId: item.task.id,
    arm: item.arm,
    replicate: item.replicate,
    modelId: "claude-opus-4-5",
    cliVersion: "0.0.0",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    costUsd: 0.0025,
    reportedCostUsd: null,
    passed: true,
    censored: false,
    competingFailure: false,
    compactionEvents: 0,
    vibedriftToolCalls: 0,
    startedAt: new Date().toISOString(),
    durationMs: 100,
  };
}

/** Fake runOne that resolves immediately with a minimal RunResult. */
const fakeRunOne = async (item: MatrixItem): Promise<RunResult> =>
  makeResult(item);

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let resultsPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "orchestrate-test-"));
  resultsPath = join(tmpDir, "results.jsonl");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// expandMatrix
// ---------------------------------------------------------------------------

describe("expandMatrix", () => {
  it("returns empty array when repos is empty", () => {
    const items = expandMatrix([], [TASK_A1, TASK_B1], 3);
    expect(items).toHaveLength(0);
  });

  it("returns empty array when tasks is empty", () => {
    const items = expandMatrix([REPO_A], [], 3);
    expect(items).toHaveLength(0);
  });

  it("returns empty array when replicates is 0", () => {
    const items = expandMatrix([REPO_A], [TASK_A1], 0);
    expect(items).toHaveLength(0);
  });

  it("single repo × 1 task × 3 arms × 1 replicate = 3 items", () => {
    const items = expandMatrix([REPO_A], [TASK_A1], 1);
    expect(items).toHaveLength(3);
  });

  it("single repo × 2 tasks × 3 arms × 2 replicates = 12 items", () => {
    const items = expandMatrix([REPO_A], [TASK_A1, TASK_A2], 2);
    expect(items).toHaveLength(12);
  });

  it("2 repos × (2+1) tasks × 3 arms × 2 replicates = 18 items", () => {
    const items = expandMatrix(
      [REPO_A, REPO_B],
      [TASK_A1, TASK_A2, TASK_B1],
      2,
    );
    expect(items).toHaveLength(18);
  });

  it("only includes tasks whose repoId matches each repo (cross-filtering)", () => {
    const items = expandMatrix(
      [REPO_A, REPO_B],
      [TASK_A1, TASK_A2, TASK_B1],
      1,
    );
    const repoAItems = items.filter((i) => i.repo.id === "repo-a");
    const repoBItems = items.filter((i) => i.repo.id === "repo-b");
    // REPO_A has tasks A1, A2 → 2 tasks × 3 arms = 6 items
    expect(repoAItems).toHaveLength(6);
    // REPO_B has task B1 → 1 task × 3 arms = 3 items
    expect(repoBItems).toHaveLength(3);
  });

  it("tasks belonging to an absent repo are not included", () => {
    // Only REPO_A in repos list; TASK_B1 belongs to repo-b → should not appear
    const items = expandMatrix([REPO_A], [TASK_A1, TASK_B1], 2);
    const taskIds = items.map((i) => i.task.id);
    expect(taskIds).not.toContain("task-b1");
  });

  it("all runIds are unique across the matrix", () => {
    const items = expandMatrix(
      [REPO_A, REPO_B],
      [TASK_A1, TASK_A2, TASK_B1],
      3,
    );
    const ids = items.map(
      (i) =>
        `${i.repo.id}__${i.task.id}__${i.arm}__r${i.replicate}`,
    );
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("each (repo, task, replicate) produces exactly 3 items, one per arm", () => {
    const items = expandMatrix([REPO_A], [TASK_A1], 2);
    // replicate 0
    const r0 = items.filter((i) => i.replicate === 0);
    const r1 = items.filter((i) => i.replicate === 1);
    expect(r0).toHaveLength(3);
    expect(r1).toHaveLength(3);
    const armsR0 = r0.map((i) => i.arm).sort();
    const armsR1 = r1.map((i) => i.arm).sort();
    expect(armsR0).toEqual(["C", "P", "T"]);
    expect(armsR1).toEqual(["C", "P", "T"]);
  });

  it("items carry correct repo and task references", () => {
    const items = expandMatrix([REPO_A], [TASK_A1], 1);
    for (const item of items) {
      expect(item.repo).toBe(REPO_A);
      expect(item.task).toBe(TASK_A1);
    }
  });
});

// ---------------------------------------------------------------------------
// armOrder
// ---------------------------------------------------------------------------

describe("armOrder", () => {
  it("returns exactly 3 elements", () => {
    const order = armOrder("task-a1", 0);
    expect(order).toHaveLength(3);
  });

  it("returns a permutation of C, P, T", () => {
    const order = armOrder("task-a1", 0);
    expect([...order].sort()).toEqual(["C", "P", "T"]);
  });

  it("is deterministic: same (taskId, replicate) → same order", () => {
    const first = armOrder("task-a1", 0);
    const second = armOrder("task-a1", 0);
    expect(first).toEqual(second);
  });

  it("is deterministic across many calls with the same args", () => {
    const reference = armOrder("some-task", 7);
    for (let i = 0; i < 20; i++) {
      expect(armOrder("some-task", 7)).toEqual(reference);
    }
  });

  it("different replicate generally yields a different ordering", () => {
    // Not a strict guarantee on any single pair — but over 10 replicates
    // at least two must differ (with 2 arms, P(all identical) = (1/2)^9 ≈ 0).
    const orders = Array.from({ length: 10 }, (_, r) =>
      armOrder("task-a1", r).join(""),
    );
    const unique = new Set(orders);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("different taskId generally yields a different ordering", () => {
    const tasks = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const orders = tasks.map((t) => armOrder(t, 0).join(""));
    const unique = new Set(orders);
    expect(unique.size).toBeGreaterThan(1);
  });

  it("returns an array of valid Arm values only", () => {
    const validArms = new Set<Arm>(["C", "P", "T"]);
    for (let r = 0; r < 5; r++) {
      for (const arm of armOrder("task-x", r)) {
        expect(validArms.has(arm)).toBe(true);
      }
    }
  });

  it("different (taskId, replicate) pairs produce expected counts of each arm", () => {
    // Each arm must appear exactly once in every armOrder result
    const counts: Record<Arm, number> = { C: 0, P: 0, T: 0 };
    for (let r = 0; r < 10; r++) {
      for (const arm of armOrder("task-count", r)) {
        counts[arm]++;
      }
    }
    // 10 replicates × 1 of each arm = 10 each
    expect(counts.C).toBe(10);
    expect(counts.P).toBe(10);
    expect(counts.T).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// orchestrate
// ---------------------------------------------------------------------------

describe("orchestrate", () => {
  it("runs all items when no prior results exist and returns correct summary", async () => {
    const items = expandMatrix([REPO_A], [TASK_A1], 2); // 6 items (3 arms)
    const called: string[] = [];

    const summary = await orchestrate(items, {
      resultsPath,
      concurrency: 3,
      runOne: async (item) => {
        called.push(
          `${item.repo.id}__${item.task.id}__${item.arm}__r${item.replicate}`,
        );
        return makeResult(item);
      },
    });

    expect(summary.total).toBe(6);
    expect(summary.ran).toBe(6);
    expect(summary.skipped).toBe(0);
    expect(called).toHaveLength(6);
  });

  it("skips items already present in the results file (resume)", async () => {
    const items = expandMatrix([REPO_A], [TASK_A1], 2); // 6 items (3 arms)

    // Pre-seed 2 results
    const preSeeded = items.slice(0, 2);
    for (const item of preSeeded) {
      await appendResult(resultsPath, makeResult(item));
    }

    const called: string[] = [];
    const summary = await orchestrate(items, {
      resultsPath,
      concurrency: 3,
      runOne: async (item) => {
        called.push(
          `${item.repo.id}__${item.task.id}__${item.arm}__r${item.replicate}`,
        );
        return makeResult(item);
      },
    });

    expect(summary.total).toBe(6);
    expect(summary.ran).toBe(4);
    expect(summary.skipped).toBe(2);
    expect(called).toHaveLength(4);
  });

  it("summary.skipped equals number of pre-seeded runIds", async () => {
    const items = expandMatrix([REPO_A], [TASK_A1, TASK_A2], 1); // 6 items (2 tasks × 3 arms)

    // Pre-seed 3 of 6
    for (const item of items.slice(0, 3)) {
      await appendResult(resultsPath, makeResult(item));
    }

    const summary = await orchestrate(items, {
      resultsPath,
      concurrency: 2,
      runOne: fakeRunOne,
    });

    expect(summary.skipped).toBe(3);
    expect(summary.ran).toBe(3);
    expect(summary.total).toBe(6);
  });

  it("returns all-skipped summary when all items are already done", async () => {
    const items = expandMatrix([REPO_A], [TASK_A1], 1); // 3 items (3 arms)
    for (const item of items) {
      await appendResult(resultsPath, makeResult(item));
    }

    let callCount = 0;
    const summary = await orchestrate(items, {
      resultsPath,
      concurrency: 3,
      runOne: async (item) => {
        callCount++;
        return makeResult(item);
      },
    });

    expect(summary.total).toBe(3);
    expect(summary.ran).toBe(0);
    expect(summary.skipped).toBe(3);
    expect(callCount).toBe(0);
  });

  it("appends each completed result to the JSONL file", async () => {
    const { loadResults } = await import("../src/store.js");
    const items = expandMatrix([REPO_A], [TASK_A1], 1); // 3 items (3 arms)

    await orchestrate(items, {
      resultsPath,
      concurrency: 3,
      runOne: fakeRunOne,
    });

    const stored = await loadResults(resultsPath);
    expect(stored).toHaveLength(3);
    const storedIds = new Set(stored.map((r) => r.runId));
    for (const item of items) {
      const id = `${item.repo.id}__${item.task.id}__${item.arm}__r${item.replicate}`;
      expect(storedIds.has(id)).toBe(true);
    }
  });

  it("respects concurrency: observed max in-flight never exceeds the limit", async () => {
    const items = expandMatrix([REPO_A], [TASK_A1, TASK_A2], 2); // 8 items
    let inFlight = 0;
    let maxObserved = 0;
    const CONCURRENCY = 3;

    await orchestrate(items, {
      resultsPath,
      concurrency: CONCURRENCY,
      runOne: async (item) => {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);
        // Yield to the microtask queue so other tasks can start if the
        // orchestrator dispatches them — this makes the concurrency observable.
        await Promise.resolve();
        inFlight--;
        return makeResult(item);
      },
    });

    expect(maxObserved).toBeGreaterThan(0);
    expect(maxObserved).toBeLessThanOrEqual(CONCURRENCY);
  });

  it("all non-skipped items complete and are appended even at concurrency=1", async () => {
    const { loadResults } = await import("../src/store.js");
    const items = expandMatrix([REPO_A, REPO_B], [TASK_A1, TASK_B1], 1); // 6 items (2 tasks × 3 arms)

    await orchestrate(items, {
      resultsPath,
      concurrency: 1,
      runOne: fakeRunOne,
    });

    const stored = await loadResults(resultsPath);
    expect(stored).toHaveLength(6);
  });

  it("concurrency=1 enforces serial execution", async () => {
    const items = expandMatrix([REPO_A], [TASK_A1, TASK_A2], 1); // 4 items
    let inFlight = 0;
    let maxObserved = 0;

    await orchestrate(items, {
      resultsPath,
      concurrency: 1,
      runOne: async (item) => {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);
        await Promise.resolve();
        inFlight--;
        return makeResult(item);
      },
    });

    expect(maxObserved).toBe(1);
  });

  it("concurrency larger than item count runs all items in one batch", async () => {
    const items = expandMatrix([REPO_A], [TASK_A1], 1); // 3 items (3 arms)
    let callCount = 0;

    await orchestrate(items, {
      resultsPath,
      concurrency: 100,
      runOne: async (item) => {
        callCount++;
        return makeResult(item);
      },
    });

    expect(callCount).toBe(3);
  });

  it("handles empty matrix (no items to run)", async () => {
    const summary = await orchestrate([], {
      resultsPath,
      concurrency: 3,
      runOne: fakeRunOne,
    });

    expect(summary.total).toBe(0);
    expect(summary.ran).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  it("concurrency=0 is clamped to 1 and still completes all items", async () => {
    const { loadResults } = await import("../src/store.js");
    const items = expandMatrix([REPO_A], [TASK_A1], 1); // 3 items (3 arms)

    const summary = await orchestrate(items, {
      resultsPath,
      concurrency: 0, // should be clamped to 1 internally
      runOne: fakeRunOne,
    });

    expect(summary.total).toBe(3);
    expect(summary.ran).toBe(3);
    expect(summary.skipped).toBe(0);
    const stored = await loadResults(resultsPath);
    expect(stored).toHaveLength(3);
  });

  it("runOne is NOT called for any item matching a pre-seeded runId", async () => {
    const items = expandMatrix([REPO_A, REPO_B], [TASK_A1, TASK_B1], 2); // 12 items (2 tasks × 3 arms × 2 reps)

    // Pre-seed 4 random items
    const toSeed = [items[0], items[3], items[5], items[7]];
    for (const item of toSeed) {
      await appendResult(resultsPath, makeResult(item));
    }
    const seededIds = new Set(
      toSeed.map(
        (i) => `${i.repo.id}__${i.task.id}__${i.arm}__r${i.replicate}`,
      ),
    );

    const calledIds: string[] = [];
    await orchestrate(items, {
      resultsPath,
      concurrency: 4,
      runOne: async (item) => {
        const id = `${item.repo.id}__${item.task.id}__${item.arm}__r${item.replicate}`;
        calledIds.push(id);
        return makeResult(item);
      },
    });

    // None of the seeded IDs should appear in calledIds
    for (const id of calledIds) {
      expect(seededIds.has(id)).toBe(false);
    }
    expect(calledIds).toHaveLength(8); // 12 total − 4 pre-seeded
  });
});
