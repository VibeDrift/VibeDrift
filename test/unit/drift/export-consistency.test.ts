import { describe, it, expect } from "vitest";
import { exportConsistency } from "../../../src/drift/export-consistency.js";
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

describe("export-consistency detector", () => {
  it("flags a default-export file when named exports dominate", () => {
    const files: DriftFile[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(file(`src/a${i}.ts`, `export const foo${i} = 1;\nexport function bar${i}() {}\n`));
    }
    files.push(file(`src/odd.ts`, `function thing() {}\nexport default thing;\n`));
    const findings = exportConsistency.detect(mkCtx(files));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.driftCategory === "export_style")).toBe(true);
  });

  it("no finding when the project unanimously uses default exports", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file(`src/a${i}.ts`, `function thing${i}() {}\nexport default thing${i};\n`),
    );
    expect(exportConsistency.detect(mkCtx(files))).toHaveLength(0);
  });
});
