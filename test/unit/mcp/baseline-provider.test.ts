import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, writeBaseline, BASELINE_VERSION } from "../../../src/core/baseline.js";
import { getBaseline, __clearBaselineCache } from "../../../src/mcp/baseline-provider.js";

describe("baseline provider", () => {
  let repo: string;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "vd-provider-"));
    writeFileSync(join(repo, "a.ts"), "export async function a(){ return await fetch('/x'); }\n");
    writeFileSync(join(repo, "b.ts"), "export async function b(){ return await fetch('/y'); }\n");
    writeFileSync(join(repo, "c.ts"), "export function c(){ return fetch('/z').then(r => r.json()); }\n");
    await writeBaseline(await buildBaseline(repo));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  beforeEach(() => __clearBaselineCache());

  it("returns status 'ok' + the baseline for a freshly-scanned repo", async () => {
    const { baseline, status } = await getBaseline(repo);
    expect(status).toBe("ok");
    expect(baseline).not.toBeNull();
    expect(baseline!.rootDir).toBe(repo);
  });

  it("lazily BUILDS a baseline on first call for a repo with code but no prior scan", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "vd-lazy-"));
    try {
      writeFileSync(join(fresh, "x.ts"), "export async function x(){ return await fetch('/a'); }\n");
      writeFileSync(join(fresh, "y.ts"), "export async function y(){ return await fetch('/b'); }\n");
      // NOTE: no writeBaseline — simulating a user who never ran `vibedrift scan`.
      __clearBaselineCache();
      const { baseline, status } = await getBaseline(fresh);
      expect(status).toBe("ok");
      expect(baseline).not.toBeNull();
      expect(baseline!.rootDir).toBe(fresh);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("persists the lazily-built baseline so the next load comes from disk", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "vd-lazy2-"));
    try {
      writeFileSync(join(fresh, "x.ts"), "export function x(){ return fetch('/a').then(r => r.json()); }\n");
      __clearBaselineCache();
      await getBaseline(fresh); // builds + persists
      __clearBaselineCache(); // drop the in-memory copy so the next call must hit disk
      const { baseline, status } = await getBaseline(fresh);
      expect(status).toBe("ok");
      expect(baseline).not.toBeNull();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("returns 'no_baseline' (and null) for an empty dir with no code to analyze", async () => {
    const empty = mkdtempSync(join(tmpdir(), "vd-empty-"));
    try {
      const { baseline, status } = await getBaseline(empty);
      expect(status).toBe("no_baseline");
      expect(baseline).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("returns 'stale' but STILL serves the cached baseline when a tracked file changed", async () => {
    expect((await getBaseline(repo)).status).toBe("ok"); // fresh first
    __clearBaselineCache();
    writeFileSync(join(repo, "a.ts"), "export async function a(){ return await fetch('/CHANGED-NOW'); }\n");
    const { baseline, status } = await getBaseline(repo);
    expect(status).toBe("stale");
    expect(baseline).not.toBeNull(); // serve cached + tag, never hang/rebuild in-call
  });

  it("rebuilds once when the on-disk baseline predates BASELINE_VERSION, then serves the rebuilt baseline without rebuilding again", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "vd-version-"));
    try {
      writeFileSync(join(fresh, "x.ts"), "export async function x(){ return await fetch('/a'); }\n");
      writeFileSync(join(fresh, "y.ts"), "export async function y(){ return await fetch('/b'); }\n");
      const built = await buildBaseline(fresh);
      // Simulate a baseline persisted under an older BASELINE_VERSION (e.g.
      // missing securitySubVotes / the belowPeerFloor vote shape).
      await writeBaseline({ ...built, version: 1 });
      __clearBaselineCache();

      const rebuiltResult = await getBaseline(fresh);
      expect(rebuiltResult.status).toBe("ok");
      expect(rebuiltResult.baseline).not.toBeNull();
      expect(rebuiltResult.baseline!.version).toBe(BASELINE_VERSION);
      const firstBuiltAt = rebuiltResult.baseline!.builtAt;

      // Content is unchanged and the on-disk baseline is now at the current
      // version, so a second call (after dropping the mem cache, forcing a
      // disk load) must be SERVED, not rebuilt again: builtAt is identical.
      __clearBaselineCache();
      const servedResult = await getBaseline(fresh);
      expect(servedResult.status).toBe("ok");
      expect(servedResult.baseline).not.toBeNull();
      expect(servedResult.baseline!.version).toBe(BASELINE_VERSION);
      expect(servedResult.baseline!.builtAt).toBe(firstBuiltAt);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("a current-version baseline with content-only drift still returns 'stale' (cheap re-hash), not a rebuild", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "vd-version-content-"));
    try {
      writeFileSync(join(fresh, "x.ts"), "export async function x(){ return await fetch('/a'); }\n");
      await writeBaseline(await buildBaseline(fresh));
      __clearBaselineCache();
      const first = await getBaseline(fresh);
      expect(first.status).toBe("ok");
      const originalBuiltAt = first.baseline!.builtAt;

      __clearBaselineCache();
      writeFileSync(join(fresh, "x.ts"), "export async function x(){ return await fetch('/CHANGED'); }\n");
      const { baseline, status } = await getBaseline(fresh);
      expect(status).toBe("stale");
      expect(baseline).not.toBeNull();
      // Content-only drift never rebuilds: same version, same builtAt as the
      // originally-persisted baseline.
      expect(baseline!.version).toBe(BASELINE_VERSION);
      expect(baseline!.builtAt).toBe(originalBuiltAt);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
