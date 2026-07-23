import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import { runEditChecks, INLINE_CHECK_MAX_ENTRIES, COOLDOWN_MS } from "@/session/check";

const HELPER_BODY = `export function exponentialBackoff(attempt: number): number {
  const base = 250;
  const cap = 30_000;
  const jitter = Math.random() * 100;
  return Math.min(cap, base * 2 ** attempt) + jitter;
}`;

let repo: string;
let sessionsDir: string;
let baseline: RepoDriftBaseline;

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "vd-check-repo-")));
  sessionsDir = realpathSync(mkdtempSync(join(tmpdir(), "vd-check-sessions-")));
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  // Declared rule makes the async dominant binding regardless of vote thresholds.
  writeFileSync(join(repo, "CLAUDE.md"), "- Async: use async/await throughout. No .then() chains.\n");
  writeFileSync(join(repo, "src", "a.ts"), "export async function a(){ return await fetch('/a'); }\n");
  writeFileSync(join(repo, "src", "b.ts"), "export async function b(){ return await fetch('/b'); }\n");
  writeFileSync(join(repo, "src", "c.ts"), "export async function c(){ return await fetch('/c'); }\n");
  writeFileSync(join(repo, "src", "lib", "backoff.ts"), `${HELPER_BODY}\n`);
  baseline = await buildBaseline(repo);
}, 60_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

const loader = async () => baseline;

// Multi-line on purpose: the shared async classifier counts signal per line
// and needs >= 2 async operations to classify at all.
const THEN_BODY = `export function loadReport(id: string) {
  return fetch("/api/report/" + id)
    .then((res) => res.json())
    .then((data) => data.rows);
}`;

const opts = (over: Record<string, unknown> = {}) => ({
  rootDir: repo,
  projectHash: "feedfacefeedface",
  sessionId: "s-check",
  sessionsDir,
  file: join(repo, "src", "routes.ts"),
  body: THEN_BODY,
  loadBaselineFor: loader,
  ...over,
});

describe("runEditChecks", () => {
  it("flags a .then body against the async/await dominant and produces an FYI", async () => {
    const out = await runEditChecks(opts({ sessionId: "s-flag" }));
    expect(out.flags.length).toBeGreaterThanOrEqual(1);
    const flag = out.flags[0];
    expect(flag.type).toBe("flag");
    expect(flag.findingId).toMatch(/^DF-\d+$/);
    expect(flag.detail.file).toBe("src/routes.ts");
    expect(out.fyi).toBeTruthy();
    expect(out.fyi).toContain("[vibedrift]");
    expect(out.fyi!.toLowerCase()).not.toContain("prevented");
  });

  it("suppresses the FYI (but keeps flags) within the cooldown window", async () => {
    const first = await runEditChecks(opts({ sessionId: "s-cool" }));
    expect(first.fyi).toBeTruthy();
    const second = await runEditChecks(opts({ sessionId: "s-cool" }));
    expect(second.flags.length).toBeGreaterThanOrEqual(1);
    expect(second.fyi).toBeNull();
  });

  it("FYIs again once the cooldown has expired", async () => {
    let t = 1_000_000;
    const now = () => t;
    const first = await runEditChecks(opts({ sessionId: "s-exp", now }));
    expect(first.fyi).toBeTruthy();
    t += COOLDOWN_MS + 1;
    const third = await runEditChecks(opts({ sessionId: "s-exp", now }));
    expect(third.fyi).toBeTruthy();
  });

  it("flags a near-duplicate of an existing helper", async () => {
    const out = await runEditChecks(
      opts({ sessionId: "s-dup", file: join(repo, "src", "retry.ts"), body: HELPER_BODY }),
    );
    const dup = out.flags.find((f) => f.detail.category === "redundancy");
    expect(dup).toBeTruthy();
    expect(dup!.detail.similarTo).toContain("backoff.ts");
    expect(dup!.detail.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it("stays quiet when the baseline exceeds the inline threshold", async () => {
    const padded: RepoDriftBaseline = {
      ...baseline,
      minhashIndex: Array.from({ length: INLINE_CHECK_MAX_ENTRIES + 1 }, () => baseline.minhashIndex[0]),
    };
    const out = await runEditChecks(opts({ sessionId: "s-big", loadBaselineFor: async () => padded }));
    expect(out.flags).toEqual([]);
    expect(out.fyi).toBeNull();
  });

  it("stays quiet when no baseline exists", async () => {
    const out = await runEditChecks(opts({ sessionId: "s-none", loadBaselineFor: async () => null }));
    expect(out.flags).toEqual([]);
    expect(out.fyi).toBeNull();
  });

  it("numbers findings sequentially across calls in one session", async () => {
    const a = await runEditChecks(opts({ sessionId: "s-seq" }));
    const b = await runEditChecks(opts({ sessionId: "s-seq", file: join(repo, "src", "other.ts") }));
    const ids = [...a.flags, ...b.flags].map((f) => Number(f.findingId!.slice(3)));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
