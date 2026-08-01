import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import {
  runEditChecks,
  rankAdvisoryCandidates,
  INLINE_CHECK_MAX_ENTRIES,
  COOLDOWN_MS,
  STRONG_DUP_SIMILARITY,
} from "@/session/check";
import type { SessionEvent } from "@/session/types";

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

  // ---- `checked` (P1.7 wire gate): true only when detectDrift actually ran ----

  it("reports checked=true on a checked edit that flags", async () => {
    const out = await runEditChecks(opts({ sessionId: "s-chk-flag" }));
    expect(out.flags.length).toBeGreaterThanOrEqual(1);
    expect(out.checked).toBe(true);
  });

  it("reports checked=true on a checked edit that stays clean", async () => {
    const clean = 'export async function ok(){ const r = await fetch("/ok"); return await r.json(); }';
    const out = await runEditChecks(opts({ sessionId: "s-chk-clean", body: clean }));
    expect(out.flags).toEqual([]);
    expect(out.checked).toBe(true);
  });

  it("reports checked=false when the baseline exceeds the size gate", async () => {
    const padded: RepoDriftBaseline = {
      ...baseline,
      minhashIndex: Array.from({ length: INLINE_CHECK_MAX_ENTRIES + 1 }, () => baseline.minhashIndex[0]),
    };
    const out = await runEditChecks(opts({ sessionId: "s-chk-big", loadBaselineFor: async () => padded }));
    expect(out.checked).toBe(false);
  });

  it("reports checked=false when no baseline exists", async () => {
    const out = await runEditChecks(opts({ sessionId: "s-chk-none", loadBaselineFor: async () => null }));
    expect(out.checked).toBe(false);
  });

  it("reports checked=false when the baseline loader throws", async () => {
    const out = await runEditChecks(
      opts({
        sessionId: "s-chk-loaderr",
        loadBaselineFor: async () => {
          throw new Error("corrupt cache");
        },
      }),
    );
    expect(out.checked).toBe(false);
  });

  it("reports checked=false when the detector itself errors", async () => {
    // a structurally broken baseline makes detectDrift throw; the fail-open
    // catch must report the check as NOT run, never as a clean pass
    const broken = { ...baseline, perCategoryVote: undefined } as unknown as RepoDriftBaseline;
    const out = await runEditChecks(opts({ sessionId: "s-chk-err", loadBaselineFor: async () => broken }));
    expect(out.flags).toEqual([]);
    expect(out.checked).toBe(false);
  });
});

describe("rankAdvisoryCandidates (pure)", () => {
  const mk = (key: string, detail: SessionEvent["detail"]) => ({
    key,
    message: `msg:${key}`,
    event: {
      v: 1,
      sid: "s",
      aid: key,
      ts: new Date().toISOString(),
      agent: "claude-code",
      projectHash: "x",
      channel: "hook",
      type: "flag",
      mode: "passive",
      findingId: "DF-1",
      detail,
      outcome: null,
    } as SessionEvent,
  });
  const conflict = (dim: string) => mk(`f.ts|${dim}`, { file: "f.ts", category: dim, dominant: "a", observed: "b" });
  const dup = (similarity: number) => mk("f.ts|redundancy", { file: "f.ts", category: "redundancy", similarTo: "g.ts:1", similarity });

  it("moves a high-similarity duplicate ahead of conflicts", () => {
    const ranked = rankAdvisoryCandidates([conflict("async_patterns"), conflict("return_shape_consistency"), dup(0.98)]);
    expect(ranked.map((c) => c.key)).toEqual([
      "f.ts|redundancy",
      "f.ts|async_patterns",
      "f.ts|return_shape_consistency",
    ]);
  });

  it("treats the threshold itself as strong", () => {
    const ranked = rankAdvisoryCandidates([conflict("async_patterns"), dup(STRONG_DUP_SIMILARITY)]);
    expect(ranked[0].key).toBe("f.ts|redundancy");
  });

  it("keeps conflicts first when the duplicate is below the threshold", () => {
    const ranked = rankAdvisoryCandidates([conflict("async_patterns"), dup(0.82)]);
    expect(ranked.map((c) => c.key)).toEqual(["f.ts|async_patterns", "f.ts|redundancy"]);
  });

  it("returns a single candidate unchanged", () => {
    const only = [conflict("async_patterns")];
    expect(rankAdvisoryCandidates(only)).toEqual(only);
    const onlyDup = [dup(0.95)];
    expect(rankAdvisoryCandidates(onlyDup)).toEqual(onlyDup);
  });
});

describe("advisory pick: strongest finding is the one messaged", () => {
  // One edit that both near-clones an indexed helper AND conflicts with the
  // declared async dominant: the near-clone is the more actionable advisory.
  const BOTH_BODY = `${THEN_BODY}\n\n${HELPER_BODY}`;

  it("messages the near-clone duplicate over the conflict, still records both", async () => {
    const out = await runEditChecks(opts({ sessionId: "s-rank", body: BOTH_BODY }));
    const cats = out.flags.map((f) => f.detail.category);
    expect(cats).toContain("redundancy");
    expect(cats.some((c) => c !== "redundancy")).toBe(true); // conflict still RECORDED
    const dupFlag = out.flags.find((f) => f.detail.category === "redundancy")!;
    expect(dupFlag.detail.similarity).toBeGreaterThanOrEqual(STRONG_DUP_SIMILARITY);
    expect(out.fyi).toContain("duplicates"); // ...but the dup is what gets MESSAGED
    expect(dupFlag.msgToAgent).toBe(out.fyi);
  });

  it("cooldown still respected: falls back to the conflict once the dup is cooled", async () => {
    const first = await runEditChecks(opts({ sessionId: "s-rank-cool", body: BOTH_BODY }));
    expect(first.fyi).toContain("duplicates");
    const second = await runEditChecks(opts({ sessionId: "s-rank-cool", body: BOTH_BODY }));
    expect(second.fyi).toBeTruthy();
    expect(second.fyi).not.toContain("duplicates");
  });
});

describe("non-code edits are a skip class (P1 contract)", () => {
  it("reports checked=false with no flags for prose", async () => {
    const out = await runEditChecks(
      opts({ sessionId: "s-md", file: join(repo, "README.md"), body: "# Payments demo\n\nHow refunds work.\n" }),
    );
    expect(out.checked).toBe(false);
    expect(out.flags).toEqual([]);
  });

  it("never flags a code snippet inside a non-code file", async () => {
    const out = await runEditChecks(
      opts({ sessionId: "s-md2", file: join(repo, "docs.md"), body: `Example:\n\n${"```"}js\n${THEN_BODY}\n${"```"}\n` }),
    );
    expect(out.checked).toBe(false);
    expect(out.flags).toEqual([]);
  });
});
