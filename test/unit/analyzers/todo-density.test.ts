import { describe, it, expect } from "vitest";
import { todoDensityAnalyzer } from "../../../src/analyzers/todo-density.js";
import type { AnalysisContext, SourceFile } from "../../../src/core/types.js";

function makeCtx(files: Partial<SourceFile>[]): AnalysisContext {
  const fullFiles = files.map((f) => ({
    path: f.path ?? "/test/" + f.relativePath,
    relativePath: f.relativePath ?? "test.ts",
    language: f.language ?? "typescript" as const,
    content: f.content ?? "",
    lineCount: (f.content ?? "").split("\n").length,
  }));
  return {
    rootDir: "/test",
    files: fullFiles,
    packageJson: null,
    goMod: null,
    cargoToml: null,
    requirementsTxt: null,
    envExample: null,
    totalLines: fullFiles.reduce((s, f) => s + f.lineCount, 0),
    languageBreakdown: new Map(),
    dominantLanguage: null,
  };
}

describe("todo-density analyzer", () => {
  it("finds TODO/FIXME/HACK patterns", async () => {
    const ctx = makeCtx([
      {
        relativePath: "a.ts",
        content: "// TODO: fix\n// FIXME: broken\n// HACK: temp\nconst x = 1;\n",
      },
    ]);
    const findings = await todoDensityAnalyzer.analyze(ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].message).toContain("TODOs");
  });

  it("returns empty for clean code", async () => {
    const ctx = makeCtx([
      { relativePath: "a.ts", content: "const x = 1;\nconst y = 2;\n" },
    ]);
    const findings = await todoDensityAnalyzer.analyze(ctx);
    expect(findings).toEqual([]);
  });

  it("flags a file as a Poisson outlier when it far exceeds the project rate", async () => {
    // Project: 10 files, 9 have 1 TODO each, 1 file has 12 TODOs.
    // λ = 21/10 = 2.1 per file. P(X ≥ 12 | 2.1) is vanishingly small.
    const files: { relativePath: string; content: string }[] = [];
    for (let i = 0; i < 9; i++) {
      files.push({ relativePath: `f${i}.ts`, content: "// TODO: later\nconst x = 1;\n" });
    }
    const manyTodos = Array.from({ length: 12 }, (_, i) => `// FIXME item ${i}`).join("\n");
    files.push({ relativePath: "big.ts", content: `${manyTodos}\nconst z = 2;\n` });
    const ctx = makeCtx(files);
    const findings = await todoDensityAnalyzer.analyze(ctx);
    const outlier = findings.find((f) => f.tags.includes("poisson-outlier"));
    expect(outlier).toBeDefined();
    expect(outlier?.message).toContain("big.ts");
  });

  it("does NOT flag a uniform distribution of TODOs", async () => {
    // Every file has exactly 1 TODO — λ=1, no outliers.
    const files = Array.from({ length: 10 }, (_, i) => ({
      relativePath: `f${i}.ts`,
      content: "// TODO: x\nconst x = 1;\n",
    }));
    const ctx = makeCtx(files);
    const findings = await todoDensityAnalyzer.analyze(ctx);
    const outliers = findings.filter((f) => f.tags.includes("poisson-outlier"));
    expect(outliers).toHaveLength(0);
  });
});
