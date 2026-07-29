import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import { runEditChecks } from "@/session/check";
import { recheckFile, detectRevert, type OpenFinding } from "@/session/outcomes";

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
