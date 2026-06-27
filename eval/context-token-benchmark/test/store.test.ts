import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendResult, loadResults } from "../src/store.js";
import type { RunResult } from "../src/types.js";

function makeRow(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "repo1__task1__T__r0",
    repoId: "repo1",
    taskId: "task1",
    arm: "T",
    replicate: 0,
    modelId: "claude-opus-4-8",
    cliVersion: "1.0.0",
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    costUsd: 0.005,
    reportedCostUsd: null,
    passed: true,
    censored: false,
    competingFailure: false,
    compactionEvents: 0,
    startedAt: "2026-06-26T00:00:00.000Z",
    durationMs: 1234,
    ...overrides,
  };
}

describe("store: appendResult / loadResults (JSONL round-trip)", () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("appends two rows and loadResults returns both in order, deep-equal", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bench-store-test-"));
    const filePath = join(tmpDir, "results.jsonl");

    const row1 = makeRow({ runId: "repo1__task1__T__r0", replicate: 0 });
    const row2 = makeRow({ runId: "repo1__task1__C__r1", arm: "C", replicate: 1, passed: false });

    await appendResult(filePath, row1);
    await appendResult(filePath, row2);

    const loaded = await loadResults(filePath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(row1);
    expect(loaded[1]).toEqual(row2);
  });

  it("loadResults on a non-existent path returns []", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bench-store-test-"));
    const filePath = join(tmpDir, "no-such-file.jsonl");

    const loaded = await loadResults(filePath);
    expect(loaded).toEqual([]);
  });

  it("loadResults skips blank lines in JSONL file", async () => {
    const { writeFile } = await import("node:fs/promises");
    tmpDir = await mkdtemp(join(tmpdir(), "bench-store-test-"));
    const filePath = join(tmpDir, "results-blank-lines.jsonl");

    const row1 = makeRow({ runId: "repo1__task1__T__r0", replicate: 0 });
    const row2 = makeRow({ runId: "repo1__task1__C__r1", arm: "C", replicate: 1 });

    // Write JSONL with a blank line between the two rows
    const content = JSON.stringify(row1) + "\n\n" + JSON.stringify(row2) + "\n";
    await writeFile(filePath, content, "utf-8");

    const loaded = await loadResults(filePath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(row1);
    expect(loaded[1]).toEqual(row2);
  });

  it("loadResults skips corrupt lines and warns, returning valid rows", async () => {
    const { writeFile } = await import("node:fs/promises");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    tmpDir = await mkdtemp(join(tmpdir(), "bench-store-test-"));
    const filePath = join(tmpDir, "results-corrupt.jsonl");

    const row1 = makeRow({ runId: "repo1__task1__T__r0", replicate: 0 });
    const row2 = makeRow({ runId: "repo1__task1__C__r1", arm: "C", replicate: 1 });

    // Write JSONL with one corrupt line between two valid ones
    const content = JSON.stringify(row1) + "\n" + "NOT VALID JSON{{" + "\n" + JSON.stringify(row2) + "\n";
    await writeFile(filePath, content, "utf-8");

    const loaded = await loadResults(filePath);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(row1);
    expect(loaded[1]).toEqual(row2);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});