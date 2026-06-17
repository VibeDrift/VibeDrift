import { describe, it, expect } from "vitest";
import { semanticDuplication } from "../../../src/drift/semantic-duplication.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string): DriftFile {
  return { path, language: "typescript", content, lineCount: content.split("\n").length };
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
});
