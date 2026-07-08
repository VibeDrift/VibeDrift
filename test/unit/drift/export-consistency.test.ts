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
  return { relativePath: path, language: "typescript", content, lineCount: content.split("\n").length };
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

  it("emits one plurality-based 'no convention' finding when there is no export convention", () => {
    // 50/50 split of default vs named across many files → entropy gate returns
    // no_convention. For a self-consistency score, having NO dominant pattern is
    // the floor of consistency, so the detector emits ONE category-level finding
    // whose deviation is 1 - plurality share (smooth + granular: 50/50 → 0.5,
    // a 4-way even split → 0.75), naming no specific deviating files.
    const files: DriftFile[] = [];
    for (let i = 0; i < 6; i++) {
      files.push(file(`src/named${i}.ts`, `export const v${i} = 1;\nexport function f${i}() {}\n`));
    }
    for (let i = 0; i < 6; i++) {
      files.push(file(`src/def${i}.ts`, `function thing${i}() {}\nexport default thing${i};\n`));
    }
    const findings = exportConsistency.detect(mkCtx(files));
    expect(findings).toHaveLength(1);
    expect(findings[0].dominantPattern).toBe("no dominant convention");
    expect(findings[0].deviatingFiles).toHaveLength(0);
    // perfect 50/50 split → plurality share 0.5 → consistencyScore 50 → deviation 0.5
    // (smooth/granular; a more-fragmented split would score lower, i.e. more drift)
    expect(findings[0].consistencyScore).toBe(50);
    expect(findings[0].severity).toBe("warning");
  });

  it("emits no 'no convention' finding when the sample is too small to distinguish chaos from sparse data", () => {
    // 1-vs-1 split: high entropy but below the minimum sample — insufficient
    // data, not chaos, so no finding.
    const files: DriftFile[] = [
      file("src/a.ts", `export const a = 1;\n`),
      file("src/b.ts", `function t() {}\nexport default t;\n`),
      file("src/c.ts", `export const c = 1;\n`),
    ];
    expect(exportConsistency.detect(mkCtx(files))).toHaveLength(0);
  });
});
