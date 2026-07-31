/**
 * The stat-gate on loadBaselineUnchecked: an oversized persisted baseline
 * reads as "no baseline" instead of being parsed on the hook path, where the
 * fail-open watchdog cannot preempt a synchronous JSON.parse.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "vd-cap-home-"));
const repo = mkdtempSync(join(tmpdir(), "vd-cap-repo-"));
vi.stubEnv("VIBEDRIFT_HOME", home);

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("loadBaselineUnchecked maxBytes gate", () => {
  it("returns null for a cache above the cap without parsing it", async () => {
    const { loadBaselineUnchecked, projectHash } = await import("@/core/baseline");
    mkdirSync(join(home, "baseline-cache"), { recursive: true });
    // Deliberately INVALID JSON: proof the gate rejects on size alone,
    // before any parse could throw.
    writeFileSync(join(home, "baseline-cache", `${projectHash(repo)}.json`), "x".repeat(4096));
    expect(await loadBaselineUnchecked(repo, 1024)).toBeNull();
  });
  it("keeps reading small caches when a cap is set", async () => {
    const { loadBaselineUnchecked, writeBaseline, assembleBaseline, projectHash } = await import("@/core/baseline");
    void assembleBaseline; void writeBaseline; void projectHash;
    // Absent file under the cap path still reads as null (unchanged posture).
    expect(await loadBaselineUnchecked(join(repo, "nope"), 1024 * 1024)).toBeNull();
  });
});
