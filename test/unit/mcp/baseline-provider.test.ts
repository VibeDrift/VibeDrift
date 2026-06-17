import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, writeBaseline } from "../../../src/core/baseline.js";
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
});
