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
  return { relativePath: path, language: "typescript", content, lineCount: content.split("\n").length };
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

  it("treats single-word lowercase filenames as convention-neutral (no file_names finding)", () => {
    // A directory of only single-word, separator-free, all-lowercase files.
    // Each such name is simultaneously valid camelCase, kebab-case AND
    // snake_case — it carries no convention signal, so there is nothing to
    // deviate from. No file_names finding (and no invented convention) should
    // be produced. Empty bodies keep the symbol axis silent.
    const files: DriftFile[] = [
      file("src/content/player/index.ts", "export const a = 1;\n"),
      file("src/content/player/render.ts", "export const b = 1;\n"),
      file("src/content/player/state.ts", "export const c = 1;\n"),
      file("src/content/player/utils.ts", "export const d = 1;\n"),
    ];
    const findings = conventionOscillation.detect(mkCtx(files));
    const fileNameFindings = findings.filter((f) => f.subCategory === "file_names");
    expect(fileNameFindings).toHaveLength(0);
  });

  it("flags only the genuinely-camelCase file when neutral single-word files mix with a kebab majority", () => {
    // A kebab-dominant directory whose remaining files are single-word neutral
    // names plus one genuinely-distinctive camelCase file (uppercase letter).
    // Only the real camelCase deviator should be flagged; the single-word
    // neutral files must never appear as deviators.
    const files: DriftFile[] = [
      // kebab majority
      file("src/bg/hpcp-parallel.ts", "export const a = 1;\n"),
      file("src/bg/hpcp-window-cache.ts", "export const b = 1;\n"),
      file("src/bg/prefilter-parallel.ts", "export const c = 1;\n"),
      file("src/bg/key-detection.ts", "export const d = 1;\n"),
      // single-word neutral files (must NOT be deviators)
      file("src/bg/aggregation.ts", "export const e = 1;\n"),
      file("src/bg/constants.ts", "export const f = 1;\n"),
      file("src/bg/evaluation.ts", "export const g = 1;\n"),
      // genuine camelCase deviator (contains an uppercase letter)
      file("src/bg/originBridge.ts", "export const h = 1;\n"),
    ];
    const findings = conventionOscillation.detect(mkCtx(files));
    const fileNameFindings = findings.filter((f) => f.subCategory === "file_names");
    expect(fileNameFindings.length).toBeGreaterThan(0);
    const deviatorPaths = fileNameFindings.flatMap((f) => (f.deviatingFiles ?? []).map((d) => d.path));
    // The genuine camelCase file is flagged...
    expect(deviatorPaths).toContain("src/bg/originBridge.ts");
    // ...and none of the single-word neutral files are.
    for (const neutral of ["aggregation.ts", "constants.ts", "evaluation.ts"]) {
      expect(deviatorPaths.some((p) => p.endsWith(neutral))).toBe(false);
    }
    // The invented "camelCase" majority must not appear; dominant should be kebab.
    for (const f of fileNameFindings) {
      expect(f.dominantPattern).toBe("kebab-case");
    }
  });

  it("regression: symbol-level camelCase-vs-snake_case drift still fires (single-word lowercase symbols are camelCase)", () => {
    const files: DriftFile[] = [];
    for (let i = 0; i < 10; i++) {
      // single-word lowercase symbol names — must classify as camelCase
      files.push(file(`src/svc${i}.ts`, `function process${i}() {}\nfunction handler${i}() {}\n`));
    }
    for (let i = 0; i < 3; i++) {
      files.push(file(`src/legacy${i}.ts`, `function do_thing_${i}() {}\n`));
    }
    const findings = conventionOscillation.detect(mkCtx(files));
    const symbolFindings = findings.filter((f) => f.subCategory === "function_names");
    expect(symbolFindings.length).toBeGreaterThan(0);
    expect(symbolFindings.some((f) => f.dominantPattern === "camelCase")).toBe(true);
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
