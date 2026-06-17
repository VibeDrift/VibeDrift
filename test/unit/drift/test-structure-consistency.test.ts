import { describe, it, expect } from "vitest";
import { testStructureConsistency } from "../../../src/drift/test-structure-consistency.js";
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

describe("test-structure-consistency detector", () => {
  it("flags a lone flat-test() file when BDD describe/it dominates", () => {
    const files: DriftFile[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(file(
        `src/feature${i}.test.ts`,
        `describe("feature ${i}", () => {\n  it("works", () => { expect(1).toBe(1); });\n  it("works again", () => {});\n});\n`,
      ));
    }
    files.push(file(
      `src/odd.test.ts`,
      `test("odd one out", () => { expect(2).toBe(2); });\ntest("again", () => {});\n`,
    ));
    const findings = testStructureConsistency.detect(mkCtx(files));
    // May be none if detector requires ≥5 profiles — we had 5 describe
    // and 1 test, which meets the threshold.
    expect(findings.some((f) => f.driftCategory === "test_structure_consistency")).toBe(true);
  });

  it("no finding on a codebase with no test files at all", () => {
    const files = Array.from({ length: 5 }, (_, i) =>
      file(`src/svc${i}.ts`, `export function svc${i}() {}`),
    );
    expect(testStructureConsistency.detect(mkCtx(files))).toHaveLength(0);
  });
});
