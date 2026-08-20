import { describe, it, expect } from "vitest";
import { semanticDuplication } from "../../../src/drift/semantic-duplication.js";
import { driftFindingToFinding } from "../../../src/drift/index.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string): DriftFile {
  return { relativePath: path, language: "typescript", content, lineCount: content.split("\n").length };
}

describe("semantic-duplication detector", () => {
  it("flags cross-file near-duplicate functions via MinHash+LCS", () => {
    // Two functions that are nearly identical in structure but in
    // different files — standard drift signal.
    const body = `
      const id = args.id;
      const row = await repo.findById(id);
      if (!row) throw new NotFoundError();
      return row;
    `;
    const files = [
      file("src/handlers/getUser.ts", `export async function getUser(args) {${body}}`),
      file("src/handlers/getOrder.ts", `export async function getOrder(args) {${body}}`),
      file("src/handlers/getAccount.ts", `export async function getAccount(args) {${body}}`),
    ];
    const findings = semanticDuplication.detect(mkCtx(files));
    // Expect at least one finding flagging the near-duplicate group.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.driftCategory === "semantic_duplication")).toBe(true);
  });

  it("no finding when all functions are structurally distinct", () => {
    const files = [
      file("src/a.ts", `export function a() { return 1; }`),
      file("src/b.ts", `export function b() { for (let i = 0; i < 10; i++) emit(i); }`),
      file("src/c.ts", `export function c() { return Math.sqrt(42); }`),
    ];
    expect(semanticDuplication.detect(mkCtx(files))).toHaveLength(0);
  });

  it("marks every finding countBased so the engine size-normalizes it (no driftSignal)", () => {
    const body = `
      const id = args.id;
      const row = await repo.findById(id);
      if (!row) throw new NotFoundError();
      return row;
    `;
    const files = [
      file("src/handlers/getUser.ts", `export async function getUser(args) {${body}}`),
      file("src/handlers/getOrder.ts", `export async function getOrder(args) {${body}}`),
      file("src/handlers/getAccount.ts", `export async function getAccount(args) {${body}}`),
    ];
    const findings = semanticDuplication.detect(mkCtx(files));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.countBased).toBe(true);
    }
    const wired = findings.map(driftFindingToFinding);
    for (const f of wired) {
      expect(f.driftSignal).toBeUndefined();
    }
  });

  it("grades a near-identical body copied across 3+ files in one directory as error", () => {
    // Identical body, 3 cross-file copies in the same directory → maxSim≈1.0
    // AND a 3-member cluster → error.
    const body = `
      const id = args.id;
      const row = await repo.findById(id);
      if (!row) throw new NotFoundError();
      return row;
    `;
    const files = [
      file("src/handlers/getUser.ts", `export async function getUser(args) {${body}}`),
      file("src/handlers/getOrder.ts", `export async function getOrder(args) {${body}}`),
      file("src/handlers/getAccount.ts", `export async function getAccount(args) {${body}}`),
    ];
    const findings = semanticDuplication.detect(mkCtx(files));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.severity === "error")).toBe(true);
  });

  it("does not grade an isolated 2-file duplicate pair as error", () => {
    const body = `
      const id = args.id;
      const row = await repo.findById(id);
      if (!row) throw new NotFoundError();
      return row;
    `;
    const files = [
      file("src/handlers/getUser.ts", `export async function getUser(args) {${body}}`),
      file("src/services/getOrder.ts", `export async function getOrder(args) {${body}}`),
    ];
    const findings = semanticDuplication.detect(mkCtx(files));
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      // 2-file clusters across directories must not reach the error ceiling.
      expect(f.severity).not.toBe("error");
    }
  });
});

describe("semantic-duplication dupGroupSize (issue #102)", () => {
  // Bodies that MinHash treats as duplicates: identical structure, differing
  // only in a string literal (tokenize collapses literals to STR).
  const clone = (name: string, marker: string) => `export function ${name}(input: string, acc: number): string {
  const s0 = stageAlpha(acc, input);
  const s1 = stageBravo(acc, s0);
  const s2 = stageCharlie(acc, s1);
  const label = "${marker}";
  return finish(s2, label);
}`;

  it("carries redundant-copy count so duplicate VOLUME reaches the scoring engine", () => {
    // Three mutually-duplicate functions in one directory = 1 original + 2 copies.
    const ctx = mkCtx([
      file("src/svc/a.ts", clone("alpha", "m-a")),
      file("src/svc/b.ts", clone("bravo", "m-b")),
      file("src/svc/c.ts", clone("charlie", "m-c")),
    ]);
    const findings = semanticDuplication.detect(ctx);
    expect(findings.length).toBeGreaterThan(0);

    // The engine's duplicate-fraction branch is gated on dupGroupSize > 1
    // (src/scoring/engine.ts). Without it the detector falls through to the
    // count branch, where findings.length is the DIRECTORY count and duplicate
    // volume is discarded.
    const total = findings.reduce((n, f) => n + ((f.dupGroupSize ?? 0) > 1 ? f.dupGroupSize! - 1 : 0), 0);
    expect(total).toBe(2);

    // and it must survive the conversion into a scoring Finding
    const converted = findings.map((f) => driftFindingToFinding(f));
    expect(converted.some((f) => (f.dupGroupSize ?? 0) > 1)).toBe(true);
  });

  it("scales with duplicate volume rather than with directory count", () => {
    const two = semanticDuplication.detect(
      mkCtx([file("src/svc/a.ts", clone("alpha", "m-a")), file("src/svc/b.ts", clone("bravo", "m-b"))]),
    );
    const four = semanticDuplication.detect(
      mkCtx([
        file("src/svc/a.ts", clone("alpha", "m-a")),
        file("src/svc/b.ts", clone("bravo", "m-b")),
        file("src/svc/c.ts", clone("charlie", "m-c")),
        file("src/svc/d.ts", clone("delta", "m-d")),
      ]),
    );
    const copies = (fs: ReturnType<typeof semanticDuplication.detect>) =>
      fs.reduce((n, f) => n + Math.max(0, (f.dupGroupSize ?? 1) - 1), 0);
    expect(copies(two)).toBe(1);
    expect(copies(four)).toBe(3);
  });

  it("does not double-count a cluster that spans two directories", () => {
    // One pair, two directories. The detector emits a finding for EACH
    // directory, so a naive sum would report two redundant copies for one
    // duplicated function. Exactly one copy is redundant.
    const findings = semanticDuplication.detect(
      mkCtx([file("src/one/a.ts", clone("alpha", "m-a")), file("src/two/b.ts", clone("bravo", "m-b"))]),
    );
    expect(findings.length).toBe(2);
    const total = findings.reduce((n, f) => n + Math.max(0, (f.dupGroupSize ?? 1) - 1), 0);
    expect(total).toBe(1);
  });
});
