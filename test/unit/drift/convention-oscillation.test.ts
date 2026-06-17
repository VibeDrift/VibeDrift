import { describe, it, expect } from "vitest";
import { conventionOscillation } from "../../../src/drift/convention-oscillation.js";
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

describe("convention-oscillation detector", () => {
  it("flags symbol-naming drift when most functions are camelCase and a few are snake_case", () => {
    const files: DriftFile[] = [];
    // 10 camelCase functions across 10 files
    for (let i = 0; i < 10; i++) {
      files.push(file(`src/service${i}.ts`, `function myFunction${i}() {}\nfunction helperCall${i}() {}\n`));
    }
    // 3 snake_case functions in 3 files
    for (let i = 0; i < 3; i++) {
      files.push(file(`src/helper${i}.ts`, `function my_helper_${i}() {}\n`));
    }
    const findings = conventionOscillation.detect(mkCtx(files));
    // Expect at least one naming finding citing the snake_case deviators.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.driftCategory === "naming_conventions")).toBe(true);
  });

  it("no finding when the project is unanimously one convention", () => {
    const files: DriftFile[] = [];
    for (let i = 0; i < 8; i++) {
      files.push(file(`src/f${i}.ts`, `function fn${i}() {}\nfunction helper${i}() {}\n`));
    }
    expect(conventionOscillation.detect(mkCtx(files))).toHaveLength(0);
  });

  it("ignores idiomatic PascalCase class names (not counted as drift)", () => {
    const files: DriftFile[] = [];
    // 6 camelCase functions + 4 PascalCase classes. PascalCase classes
    // are idiomatic for TypeScript and should not be flagged.
    for (let i = 0; i < 6; i++) {
      files.push(file(`src/f${i}.ts`, `function fn${i}() {}\n`));
    }
    for (let i = 0; i < 4; i++) {
      files.push(file(`src/model${i}.ts`, `class UserModel${i} {}\nclass DataStore${i} {}\n`));
    }
    const findings = conventionOscillation.detect(mkCtx(files));
    // PascalCase classes should not register as snake_case / kebab-case
    // deviation. Any finding would have to come from another axis.
    for (const f of findings) {
      expect(f.dominantPattern).not.toMatch(/snake_case/);
    }
  });
});
