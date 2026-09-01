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
  return { relativePath: path, language: "typescript", content, lineCount: content.split("\n").length };
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

describe("test-structure-consistency: mocha classification", () => {
  const MOCHA = [
    `const { expect } = require("chai");`,
    ``,
    `describe("UserService", function () {`,
    `  before(function () { setup(); });`,
    `  it("creates a user", function () { expect(create()).to.be.ok; });`,
    `});`,
  ].join("\n");

  it("classifies a real mocha suite as mocha, not bdd_nested", () => {
    // The old regex `describe\s*\([^)]*\)\s*,\s*function` required a CLOSING
    // paren before the comma — `describe("x")` , `function` — a shape no test
    // file has. Every mocha suite therefore fell through to the bdd_nested
    // branch below it, so `mocha` was unreachable and a mocha/vitest split read
    // as unanimous BDD.
    const mochaFiles = Array.from({ length: 5 }, (_, i) =>
      file(`test/m${i}.test.js`, MOCHA),
    );
    const vitestFiles = Array.from({ length: 2 }, (_, i) =>
      file(`test/v${i}.test.ts`, `describe("thing", () => {\n  it("works", () => {});\n});\n`),
    );
    const findings = testStructureConsistency.detect(mkCtx([...mochaFiles, ...vitestFiles]));
    const fw = findings.find((f) => f.subCategory === "framework");
    expect(fw).toBeDefined();
    expect(fw!.dominantPattern).toBe("mocha");
    expect(fw!.dominantCount).toBe(5);
    expect(fw!.deviatingFiles.map((d) => d.path).sort()).toEqual(["test/v0.test.ts", "test/v1.test.ts"]);
  });

  it("does not call a vitest suite mocha just because it uses `function`", () => {
    // `beforeEach`/`beforeAll` are not `before(`, which is what keeps the
    // framework-agnostic `function` callback from being read as mocha.
    const vitest = `describe("thing", function () {\n  beforeEach(function () {});\n  it("works", function () {});\n});\n`;
    const files = Array.from({ length: 5 }, (_, i) => file(`test/v${i}.test.ts`, vitest));
    const findings = testStructureConsistency.detect(mkCtx(files));
    expect(findings.every((f) => f.dominantPattern !== "mocha")).toBe(true);
  });
});
