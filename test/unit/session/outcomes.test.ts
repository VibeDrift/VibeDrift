import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBaseline, type RepoDriftBaseline } from "@/core/baseline";
import { recheckFile, detectRevert, type OpenFinding } from "@/session/outcomes";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

const HELPER = `export function exponentialBackoff(attempt) {
  const base = 250;
  const cap = 30000;
  const jitter = Math.random() * 100;
  return Math.min(cap, base * 2 ** attempt) + jitter;
}`;

let baseline: RepoDriftBaseline;
beforeAll(async () => {
  const repo = tmp("vd-out-repo-");
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  writeFileSync(join(repo, "CLAUDE.md"), "- Async: use async/await throughout. No .then() chains.\n");
  for (const n of ["a", "b", "c"]) {
    writeFileSync(join(repo, "src", `${n}.ts`), `export async function ${n}(){ return await fetch("/${n}"); }\n`);
  }
  writeFileSync(join(repo, "src", "lib", "backoff.ts"), `${HELPER}\n`);
  baseline = await buildBaseline(repo);
}, 60_000);

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
  const open: OpenFinding[] = [{ findingId: "DF-1", file: "src/report.ts", category: "async_patterns" }];

  it("resolves a convention finding once the file is fixed", () => {
    const { resolved } = recheckFile(baseline, "src/report.ts", CLEAN, open);
    expect(resolved.map((f) => f.findingId)).toEqual(["DF-1"]);
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

  it("does NOT falsely resolve a redundancy when the dup is still present in a multi-function file", () => {
    // the whole-file query dilutes below threshold, but the per-function query
    // (via detectDrift) still catches the untouched clone — so no false resolve
    const dupOpen: OpenFinding[] = [{ findingId: "DF-dup", file: "src/util.ts", category: "redundancy" }];
    const multiFn = `export function unrelatedOne(a) { return a + 1; }
${HELPER}
export function unrelatedTwo(b) { return b - 1; }`;
    expect(recheckFile(baseline, "src/util.ts", multiFn, dupOpen).resolved).toEqual([]);
  });

  it("DOES resolve a redundancy once the duplicated function is gone", () => {
    const dupOpen: OpenFinding[] = [{ findingId: "DF-dup", file: "src/util.ts", category: "redundancy" }];
    const noDup = `export function unrelatedOne(a) { return a + 1; }
export function unrelatedTwo(b) { return b - 1; }`;
    expect(recheckFile(baseline, "src/util.ts", noDup, dupOpen).resolved.map((f) => f.findingId)).toEqual(["DF-dup"]);
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
