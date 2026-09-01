import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import { runEditChecks } from "@/session/check";
import {
  recheckFile,
  detectRevert,
  mergeOutcomeState,
  readOutcomeState,
  writeOutcomeState,
  emptyOutcomeState,
  type OpenFinding,
  type OutcomeState,
} from "@/session/outcomes";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

const HELPER = `export function exponentialBackoff(attempt) {
  const base = 250;
  const cap = 30000;
  const jitter = Math.random() * 100;
  return Math.min(cap, base * 2 ** attempt) + jitter;
}`;

let repo: string;
let sessionsDir: string;
let baseline: RepoDriftBaseline;

beforeAll(async () => {
  repo = tmp("vd-out-repo-");
  sessionsDir = tmp("vd-out-sessions-");
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), "- Async: use async/await throughout. No .then() chains.\n");
  for (const n of ["a", "b", "c"]) {
    writeFileSync(join(repo, "src", `${n}.ts`), `export async function ${n}(){ return await fetch("/${n}"); }\n`);
  }
  writeFileSync(join(repo, "src", "lib", "backoff.ts"), `${HELPER}\n`);
  baseline = await buildBaseline(repo);
}, 60_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

/** Raise a finding the way the hook does, so the open finding carries the same
 *  anchor the real flag path produces. */
async function raise(sessionId: string, relFile: string, body: string): Promise<OpenFinding[]> {
  const out = await runEditChecks({
    rootDir: repo,
    projectHash: "feedfacefeedface",
    sessionId,
    sessionsDir,
    file: join(repo, relFile),
    body,
    loadBaselineFor: async () => baseline,
  });
  expect(out.flags.length).toBeGreaterThanOrEqual(1);
  return out.flags.map((f) => ({
    findingId: f.findingId!,
    file: f.detail.file!,
    category: f.detail.category!,
    anchor: out.anchors[f.findingId!],
  }));
}

const THEN = `export function loadReport(id) {
  return fetch("/x/" + id)
    .then((r) => r.json())
    .then((d) => d.rows);
}`;
const CLEAN = `export async function loadReport(id) {
  const r = await fetch("/x/" + id);
  const d = await r.json();
  return d.rows;
}`;

describe("recheckFile", () => {
  let open: OpenFinding[];
  beforeAll(async () => {
    open = await raise("s-then", "src/report.ts", THEN);
  });

  it("resolves a convention finding once the file is fixed", () => {
    const { resolved } = recheckFile(baseline, "src/report.ts", CLEAN, open);
    expect(resolved.map((f) => f.findingId)).toEqual(open.map((f) => f.findingId));
  });

  it("does NOT resolve while the finding still stands", () => {
    const { resolved } = recheckFile(baseline, "src/report.ts", THEN, open);
    expect(resolved).toEqual([]);
  });

  it("does NOT resolve a finding on a DIFFERENT file (cross-file safety)", () => {
    const { resolved } = recheckFile(baseline, "src/other.ts", CLEAN, open);
    expect(resolved).toEqual([]);
  });

  it("leaves scope findings alone (never auto-resolved here)", () => {
    const scopeOpen: OpenFinding[] = [{ findingId: "DF-scope-2", file: "src/report.ts", category: "scope" }];
    expect(recheckFile(baseline, "src/report.ts", CLEAN, scopeOpen).resolved).toEqual([]);
  });

  it("never resolves a finding that carries no anchor", () => {
    const legacy: OpenFinding[] = [{ findingId: "DF-legacy", file: "src/report.ts", category: "async_patterns" }];
    expect(recheckFile(baseline, "src/report.ts", CLEAN, legacy).resolved).toEqual([]);
  });

  it("does NOT falsely resolve a redundancy when the dup is still present in a multi-function file", async () => {
    const dupOpen = await raise("s-dup", "src/util.ts", HELPER);
    const multiFn = `export function unrelatedOne(a) { return a + 1; }
${HELPER}
export function unrelatedTwo(b) { return b - 1; }`;
    expect(recheckFile(baseline, "src/util.ts", multiFn, dupOpen).resolved).toEqual([]);
  });

  it("DOES resolve a redundancy once the duplicated function is gone", async () => {
    const dupOpen = await raise("s-dup2", "src/util.ts", HELPER);
    const noDup = `export function unrelatedOne(a) { return a + 1; }
export function unrelatedTwo(b) { return b - 1; }`;
    expect(recheckFile(baseline, "src/util.ts", noDup, dupOpen).resolved.map((f) => f.findingId)).toEqual(
      dupOpen.map((f) => f.findingId),
    );
  });
});

describe("mergeOutcomeState (pure)", () => {
  const finding = (id: string, over: Partial<OpenFinding> = {}): OpenFinding => ({
    findingId: id,
    file: "src/x.ts",
    category: "async_patterns",
    ...over,
  });

  it("unions open findings present on only one side", () => {
    const local: OutcomeState = { open: [finding("DF-1")], hashes: {} };
    const onDisk: OutcomeState = { open: [finding("DF-2")], hashes: {} };
    const merged = mergeOutcomeState(local, onDisk);
    expect(merged.open.map((f) => f.findingId).sort()).toEqual(["DF-1", "DF-2"]);
  });

  it("prefers local's entry on a genuine findingId conflict", () => {
    const local: OutcomeState = { open: [finding("DF-1", { category: "naming" })], hashes: {} };
    const onDisk: OutcomeState = { open: [finding("DF-1", { category: "async_patterns" })], hashes: {} };
    const merged = mergeOutcomeState(local, onDisk);
    expect(merged.open).toHaveLength(1);
    expect(merged.open[0].category).toBe("naming");
  });

  it("does NOT resurrect a finding local deliberately dropped (resolved) when onDisk never had it either", () => {
    const local: OutcomeState = { open: [], hashes: {} };
    const onDisk: OutcomeState = { open: [], hashes: {} };
    expect(mergeOutcomeState(local, onDisk).open).toEqual([]);
  });

  it("unions per-file revert hashes from both sides without duplicating shared entries", () => {
    const local: OutcomeState = { open: [], hashes: { "a.ts": ["h1", "h2"] } };
    const onDisk: OutcomeState = { open: [], hashes: { "a.ts": ["h2", "h3"] } };
    const merged = mergeOutcomeState(local, onDisk);
    expect(new Set(merged.hashes["a.ts"])).toEqual(new Set(["h1", "h2", "h3"]));
  });

  it("unions hashes across files present on only one side", () => {
    const local: OutcomeState = { open: [], hashes: { "a.ts": ["h1"] } };
    const onDisk: OutcomeState = { open: [], hashes: { "b.ts": ["h2"] } };
    const merged = mergeOutcomeState(local, onDisk);
    expect(merged.hashes).toEqual({ "a.ts": ["h1"], "b.ts": ["h2"] });
  });
});

describe("writeOutcomeState: read-merge-write", () => {
  function finding(id: string): OpenFinding {
    return { findingId: id, file: "src/x.ts", category: "naming" };
  }

  // Sequential (deterministic) demonstration of the actual fix contract: a
  // SECOND write for the same session, whose caller computed its local state
  // from an earlier read, must not blindly clobber what the FIRST write
  // already committed. This is exactly what a blind writeFile() used to do.
  it("a later write merges with, rather than clobbers, what an earlier write committed", async () => {
    const dir = tmp("vd-out-merge-");
    const hash = "feedfacefeedfaaa";
    const sid = "s-seq";

    await writeOutcomeState(dir, hash, sid, { ...emptyOutcomeState(), open: [finding("DF-a")] });
    // stateB was computed from a stale (pre-DF-a) read, as a concurrent
    // writer's would be — it does not know about DF-a at all.
    await writeOutcomeState(dir, hash, sid, { ...emptyOutcomeState(), open: [finding("DF-b")] });

    const final = await readOutcomeState(dir, hash, sid);
    expect(final.open.map((f) => f.findingId).sort()).toEqual(["DF-a", "DF-b"]);

    rmSync(dir, { recursive: true, force: true });
  });

  // True concurrency is lock-free by design (like upload-state.ts's
  // commit()), so a genuine race's outcome is not fully deterministic — we do
  // NOT assert both findings are guaranteed to survive. What must always
  // hold: the sidecar is never torn (invalid JSON), and at least one write's
  // finding is durably present.
  it("never tears the file under a concurrent write, and at least one finding survives", async () => {
    const dir = tmp("vd-out-concurrent-");
    const hash = "feedfacefeedfaaa";
    const sid = "s-conc";

    await Promise.all([
      writeOutcomeState(dir, hash, sid, { ...emptyOutcomeState(), open: [finding("DF-a")] }),
      writeOutcomeState(dir, hash, sid, { ...emptyOutcomeState(), open: [finding("DF-b")] }),
    ]);

    const final = await readOutcomeState(dir, hash, sid);
    const ids = final.open.map((f) => f.findingId);
    expect(ids.every((id) => id === "DF-a" || id === "DF-b")).toBe(true);
    expect(ids.length).toBeGreaterThan(0);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("detectRevert", () => {
  it("flags a byte-exact restore but NOT a reformatted body", () => {
    const seen: Record<string, string[]> = {};
    expect(detectRevert("f.ts", "const x = 1;", seen).reverted).toBe(false); // first sight
    expect(detectRevert("f.ts", "const y = 2;", seen).reverted).toBe(false); // new content
    expect(detectRevert("f.ts", "const x = 1;", seen).reverted).toBe(true); // byte-exact restore
    // a reformatted variant (extra spaces) has a different hash -> not a revert
    expect(detectRevert("f.ts", "const  x  =  1;", seen).reverted).toBe(false);
  });
});
