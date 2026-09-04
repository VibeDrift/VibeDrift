import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectHash } from "../../../src/core/baseline.js";

// history.ts's ROOT_DIR is a module-level const derived from
// vibedriftHome() at import time (see vibedrift-home.ts), so VIBEDRIFT_HOME
// must be set BEFORE the module is imported. Reset modules between tests and
// re-import fresh each time so each test gets its own sandboxed home.
describe("loadScanById — scanId path-traversal guard", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "vd-history-"));
    prevHome = process.env.VIBEDRIFT_HOME;
    process.env.VIBEDRIFT_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.VIBEDRIFT_HOME;
    else process.env.VIBEDRIFT_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("still loads a legitimate scan by id", async () => {
    const { loadScanById } = await importFresh();
    const rootDir = "/tmp/some-project";
    const dir = join(home, "scans", projectHash(rootDir));
    await mkdir(dir, { recursive: true });
    const saved = { timestamp: "t", rootDir, schemaVersion: 3, scores: {}, compositeScore: 42 };
    await writeFile(join(dir, "scan-1700000000000.json"), JSON.stringify(saved));

    const loaded = await loadScanById(rootDir, "1700000000000");
    expect(loaded?.compositeScore).toBe(42);

    const loadedFullName = await loadScanById(rootDir, "scan-1700000000000.json");
    expect(loadedFullName?.compositeScore).toBe(42);
  });

  it("rejects a scanId containing a path separator (traversal attempt)", async () => {
    const { loadScanById } = await importFresh();
    // Plant a real, readable file OUTSIDE the scans dir that a traversal
    // would reach if the guard were absent.
    const secretDir = join(home, "secret");
    await mkdir(secretDir, { recursive: true });
    await writeFile(join(secretDir, "leak.json"), JSON.stringify({ leaked: true }));

    // Four levels: the "scan-" prefix consumes the first "..", then two more
    // climb out of <home>/scans/<projectHash>. Fewer levels land back inside
    // the scans tree, where nothing is planted, so the assertion would pass
    // with the guard REMOVED and prove nothing.
    const traversalId = "../../../../secret/leak";
    const result = await loadScanById("/tmp/some-project", traversalId);
    expect(result).toBeNull();
  });

  it("rejects a scanId containing '..' even without a separator", async () => {
    const { loadScanById } = await importFresh();
    const result = await loadScanById("/tmp/some-project", "..");
    expect(result).toBeNull();
  });

  it("rejects a backslash-separated traversal attempt (Windows)", async () => {
    const { loadScanById } = await importFresh();
    const result = await loadScanById("/tmp/some-project", "..\\..\\secret\\leak");
    expect(result).toBeNull();
  });

  async function importFresh() {
    return await import("../../../src/core/history.js");
  }
});
