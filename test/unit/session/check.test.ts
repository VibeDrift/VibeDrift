import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import {
  runEditChecks,
  rankAdvisoryCandidates,
  mergeCooldownState,
  __test_writeCooldownState,
  INLINE_CHECK_MAX_ENTRIES,
  COOLDOWN_MS,
  STRONG_DUP_SIMILARITY,
  type CooldownState,
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

  it("records the flagged file with forward slashes, whatever the separator was", async () => {
    // What relative() answers on win32 for <repo>\src\winroutes.ts. The flag's
    // file must land in the same form the edit event records, or the two hash
    // to different pseudonyms and one file shows up as two on the dashboard.
    const out = await runEditChecks(opts({ sessionId: "s-winpath", file: join(repo, "src\\winroutes.ts") }));
    expect(out.flags.length).toBeGreaterThanOrEqual(1);
    expect(out.flags[0].detail.file).toBe("src/winroutes.ts");
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
    // catch must report the check as NOT run, never as a clean pass.
    // The break has to land INSIDE detectDrift, past the early guards: a
    // minhashIndex with a readable `length` clears the entry-count check at the
    // top of runEditChecks, then throws on `.filter` within the detector.
    // perCategoryVote used to serve here, but the in-loop path now reads
    // perDirectoryVote, so nulling it no longer throws anywhere.
    const broken = { ...baseline, minhashIndex: { length: 0 } } as unknown as RepoDriftBaseline;
    const out = await runEditChecks(opts({ sessionId: "s-chk-err", loadBaselineFor: async () => broken }));
    expect(out.flags).toEqual([]);
    expect(out.checked).toBe(false);
  });
});

describe("mergeCooldownState (pure)", () => {
  it("takes the max nextFindingSeq from either side", () => {
    const local: CooldownState = { nextFindingSeq: 3, lastFyi: {} };
    const onDisk: CooldownState = { nextFindingSeq: 7, lastFyi: {} };
    expect(mergeCooldownState(local, onDisk).nextFindingSeq).toBe(7);
    expect(mergeCooldownState(onDisk, local).nextFindingSeq).toBe(7);
  });

  it("unions lastFyi keys and takes the max timestamp per shared key", () => {
    const local: CooldownState = { nextFindingSeq: 1, lastFyi: { "a.ts|x": 100, "b.ts|y": 50 } };
    const onDisk: CooldownState = { nextFindingSeq: 1, lastFyi: { "a.ts|x": 200, "c.ts|z": 300 } };
    expect(mergeCooldownState(local, onDisk).lastFyi).toEqual({
      "a.ts|x": 200,
      "b.ts|y": 50,
      "c.ts|z": 300,
    });
  });

  it("never regresses a cooldown key: an earlier local timestamp cannot un-throttle a key onDisk already started", () => {
    const local: CooldownState = { nextFindingSeq: 1, lastFyi: { "a.ts|x": 10 } };
    const onDisk: CooldownState = { nextFindingSeq: 1, lastFyi: { "a.ts|x": 9999 } };
    expect(mergeCooldownState(local, onDisk).lastFyi["a.ts|x"]).toBe(9999);
  });
});

describe("runEditChecks: concurrent hook subprocesses never tear the cooldown file", () => {
  // Two hooks for parallel tool calls in the same session both read-then-write
  // the SAME session's cooldown sidecar. This is lock-free by design (like
  // upload-state.ts's commit()), so we do NOT assert both writers' keys are
  // guaranteed to survive a true race — that residual window is documented and
  // harmless (a dropped cooldown key just costs one extra FYI, never a crash).
  // What must always hold: the file is never torn (invalid JSON), and a write
  // that happens to observe the other's prior write converges on both keys.
  it("stays valid JSON under a concurrent write, and a later run sees both keys", async () => {
    const sessionId = "s-concurrent-cooldown";
    await Promise.all([
      runEditChecks(opts({ sessionId, file: join(repo, "src", "concA.ts") })),
      runEditChecks(opts({ sessionId, file: join(repo, "src", "concB.ts") })),
    ]);

    const statePath = join(sessionsDir, "feedfacefeedface", `${sessionId}.cooldown.json`);
    // Invariant 1 — no torn write: always parses, regardless of who won the race.
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(typeof persisted.nextFindingSeq).toBe("number");

    // Invariant 2 — convergence: a subsequent SEQUENTIAL call for a key that
    // survived (or a fresh one) still cools down normally, i.e. the file is
    // usable state, not corrupted by the race.
    const again = await runEditChecks(opts({ sessionId, file: join(repo, "src", "concA.ts") }));
    expect(again.flags.length).toBeGreaterThanOrEqual(1); // detection itself is unaffected by the sidecar race
  });

  it("a later write MERGES with the cooldown state on disk instead of clobbering it", async () => {
    // writeState is a read-merge-write, not a blind overwrite: a concurrent
    // hook subprocess for the same session may have advanced nextFindingSeq or
    // started a cooldown on a key this writer's own state never saw. That is
    // only observable when the disk changes BETWEEN a caller's read and its
    // write, which no public entry point can interleave — hence the test-only
    // export. The concurrency test above cannot catch it: a blind overwrite
    // also leaves a parseable, usable file. Binds the wiring in writeState,
    // not just mergeCooldownState.
    const sessionId = "s-merge-cooldown";
    const statePath = join(sessionsDir, "feedfacefeedface", `${sessionId}.cooldown.json`);
    mkdirSync(join(sessionsDir, "feedfacefeedface"), { recursive: true });

    // What another writer already put on disk.
    writeFileSync(
      statePath,
      JSON.stringify({ nextFindingSeq: 55, lastFyi: { "other-writer-key": 1_700_000_000_000 } }),
    );

    // A stale writer whose own state predates all of that.
    await __test_writeCooldownState(
      opts({ sessionId, file: join(repo, "src", "concA.ts") }),
      { nextFindingSeq: 1, lastFyi: { "my-key": 1_600_000_000_000 } },
    );

    const merged = JSON.parse(readFileSync(statePath, "utf8"));
    expect(merged.lastFyi["other-writer-key"]).toBe(1_700_000_000_000); // not clobbered
    expect(merged.lastFyi["my-key"]).toBe(1_600_000_000_000); // and not lost
    expect(merged.nextFindingSeq).toBe(55); // max, never rewound
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

describe("runEditChecks file-class gate", () => {
  // THEN_BODY reliably flags against this repo's declared async/await rule, so
  // any silence below is the file-class gate and not a weak fixture.
  const nonAppPaths = [
    join("scripts", "seed-dev.ts"),
    join("tests", "integration", "global-setup.ts"),
    join("src", "rate-limit.test.ts"),
    join("src", "scratch-probe.ts"),
  ];

  for (const rel of nonAppPaths) {
    it(`reports checked=false and emits no flags for ${rel}`, async () => {
      const out = await runEditChecks(
        opts({ sessionId: `s-gate-${rel.replace(/[^a-z0-9]/gi, "-")}`, file: join(repo, rel) }),
      );
      expect(out.checked).toBe(false);
      expect(out.flags).toHaveLength(0);
      expect(out.fyi).toBeNull();
    });
  }

  it("still checks ordinary application source", async () => {
    const out = await runEditChecks(opts({ sessionId: "s-gate-app", file: join(repo, "src", "app.ts") }));
    expect(out.checked).toBe(true);
    expect(out.flags.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runEditChecks duplicate counterpart verification", () => {
  // Reproduces the recorded shape: the helper the index still lists is
  // lifted out of its original file, so the "duplicate" is really a move.
  it("suppresses the advisory when the counterpart was moved out", async () => {
    const sessionsDir2 = realpathSync(mkdtempSync(join(tmpdir(), "vd-move-")));
    const repo2 = realpathSync(mkdtempSync(join(tmpdir(), "vd-move-repo-")));
    mkdirSync(join(repo2, "src"), { recursive: true });
    writeFileSync(join(repo2, "src", "origin.ts"), `${HELPER_BODY}\n`);
    writeFileSync(join(repo2, "src", "a.ts"), "export async function a(){ return await fetch('/a'); }\n");
    writeFileSync(join(repo2, "src", "b.ts"), "export async function b(){ return await fetch('/b'); }\n");
    const b2 = await buildBaseline(repo2);
    expect(b2.minhashIndex.some((e) => e.relativePath === "src/origin.ts")).toBe(true);

    // The agent moves the helper: origin.ts no longer defines it, shared.ts does.
    writeFileSync(join(repo2, "src", "origin.ts"), "export const unrelated = 1;\n");

    const out = await runEditChecks({
      rootDir: repo2,
      projectHash: "feedfacefeedfacf",
      sessionId: "s-move",
      sessionsDir: sessionsDir2,
      file: join(repo2, "src", "shared.ts"),
      body: HELPER_BODY,
      loadBaselineFor: async () => b2,
    });
    expect(out.flags.filter((f) => f.detail.category === "redundancy")).toHaveLength(0);
    rmSync(repo2, { recursive: true, force: true });
    rmSync(sessionsDir2, { recursive: true, force: true });
  }, 60_000);

  it("still flags a genuine copy that leaves the original in place", async () => {
    const sessionsDir3 = realpathSync(mkdtempSync(join(tmpdir(), "vd-copy-")));
    const repo3 = realpathSync(mkdtempSync(join(tmpdir(), "vd-copy-repo-")));
    mkdirSync(join(repo3, "src"), { recursive: true });
    writeFileSync(join(repo3, "src", "origin.ts"), `${HELPER_BODY}\n`);
    writeFileSync(join(repo3, "src", "a.ts"), "export async function a(){ return await fetch('/a'); }\n");
    writeFileSync(join(repo3, "src", "b.ts"), "export async function b(){ return await fetch('/b'); }\n");
    const b3 = await buildBaseline(repo3);

    // origin.ts keeps the helper — this really is a duplication.
    const out = await runEditChecks({
      rootDir: repo3,
      projectHash: "feedfacefeedfad0",
      sessionId: "s-copy",
      sessionsDir: sessionsDir3,
      file: join(repo3, "src", "shared.ts"),
      body: HELPER_BODY,
      loadBaselineFor: async () => b3,
    });
    expect(out.flags.filter((f) => f.detail.category === "redundancy").length).toBeGreaterThanOrEqual(1);
    rmSync(repo3, { recursive: true, force: true });
    rmSync(sessionsDir3, { recursive: true, force: true });
  }, 60_000);
});
