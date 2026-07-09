import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, writeBaseline, BASELINE_VERSION, type RepoDriftBaseline } from "../../../src/core/baseline.js";
import { getBaseline, __clearBaselineCache } from "../../../src/mcp/baseline-provider.js";
import { dominantPatternFor } from "../../../src/tools-core/tools/get-dominant-pattern.js";

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

// ── Issue #34 blocker 2: a persisted baseline from an older BASELINE_VERSION
// must be rebuilt, not served forever. Pre-v2 baselines carry no
// securitySubVotes, so serving one makes get_dominant_pattern("auth") answer
// the no-vote projection ("consistent, no deviations detected") even when the
// stale vote recorded deviators; and its version-prefixed key can never match
// the working tree again, so the status read "stale" on every call.
describe("baseline version gate", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "vd-vergate-"));
    // 4 authed + 1 unauthed mutating routes: a real "Auth middleware applied"
    // sub-vote (5 peers, at/above the scoring floor) with one recorded deviator.
    writeFileSync(
      join(repo, "api.ts"),
      [
        'router.post("/a", requireAuth, (req, res) => { res.json({}); });',
        'router.put("/b", requireAuth, (req, res) => { res.json({}); });',
        'router.patch("/c", requireAuth, (req, res) => { res.json({}); });',
        'router.delete("/d", requireAuth, (req, res) => { res.json({}); });',
        'router.post("/e", (req, res) => { res.json({}); });',
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  beforeEach(() => __clearBaselineCache());

  it("rebuilds a pre-versioned (v1-shaped) on-disk baseline instead of serving it", async () => {
    const built = await buildBaseline(repo);
    // Doctor the persisted shape into a faithful v1 baseline: no version
    // field, no securitySubVotes, and a key computed under the old version
    // prefix (any value the current computeBaselineKey can't reproduce).
    const v1 = { ...built, key: "0".repeat(64), builtAt: 12345 } as RepoDriftBaseline;
    delete v1.version;
    delete v1.securitySubVotes;
    await writeBaseline(v1);
    __clearBaselineCache();

    const { baseline, status } = await getBaseline(repo);
    expect(baseline).not.toBeNull();
    expect(baseline!.builtAt).not.toBe(12345); // rebuilt, not served
    expect(baseline!.version).toBe(BASELINE_VERSION);
    expect(status).toBe("ok"); // no perpetual "stale" from the version-prefixed key

    // The rebuilt baseline serves the auth sub-vote again: the projection is
    // the real vote, not the no-vote "consistent" answer the stale file gave.
    expect(baseline!.securitySubVotes?.["Auth middleware"]).toBeDefined();
    const projection = dominantPatternFor(baseline!, "auth");
    expect(projection.dominantPattern).toBe("Auth middleware applied");
  });

  it("serves an up-to-date on-disk baseline without rebuilding", async () => {
    const built = await buildBaseline(repo);
    await writeBaseline({ ...built, builtAt: 424242 }); // marker survives only if served from disk
    __clearBaselineCache();

    const { baseline, status } = await getBaseline(repo);
    expect(status).toBe("ok");
    expect(baseline!.builtAt).toBe(424242);
    expect(baseline!.version).toBe(BASELINE_VERSION);
  });
});
