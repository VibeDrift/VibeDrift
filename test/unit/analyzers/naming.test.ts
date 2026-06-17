import { describe, it, expect } from "vitest";
import { namingAnalyzer } from "../../../src/analyzers/naming.js";
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

describe("naming analyzer (entropy gate)", () => {
  it("flags deviators with HIGH confidence when one convention strongly dominates", async () => {
    // ~19:1 camelCase:snake_case → normalized H ≈ 0.29 → confidence ≈ 0.71
    const camelFiles = Array.from({ length: 19 }, (_, i) => ({
      relativePath: `cam${i}.ts`,
      content: `const userName${i} = 1;\nconst orderId${i} = 2;\nfunction getUser${i}() { return 1; }\n`,
    }));
    const snakeFiles = [
      { relativePath: "snake1.ts", content: "const user_name = 1;\nconst order_id = 2;\nfunction get_user() { return 1; }\n" },
      { relativePath: "snake2.ts", content: "const first_one = 1;\nconst last_name = 2;\nfunction find_user() { return 1; }\n" },
    ];
    const ctx = makeCtx([...camelFiles, ...snakeFiles]);
    const findings = await namingAnalyzer.analyze(ctx);
    const dev = findings.find((f) => f.tags.includes("inconsistency"));
    expect(dev).toBeDefined();
    // Strong dominance → confidence should exceed the 0.3 "no convention" floor.
    expect(dev!.confidence).toBeGreaterThan(0.5);
  });

  it("applies the 0.3 floor on a merely 80/20 split", async () => {
    // 8 files camelCase vs 2 files snake_case × 3 IDs each.
    // H normalized ≈ 0.72 → raw confidence ≈ 0.28 → clamped to 0.3 floor.
    const camelFiles = Array.from({ length: 8 }, (_, i) => ({
      relativePath: `cam${i}.ts`,
      content: `const userName${i} = 1;\nconst orderId${i} = 2;\nfunction getUser${i}() {}\n`,
    }));
    const snakeFiles = [
      { relativePath: "s1.ts", content: "const user_name = 1;\nconst order_id = 2;\nfunction get_user() {}\n" },
      { relativePath: "s2.ts", content: "const first_one = 1;\nconst last_name = 2;\nfunction find_user() {}\n" },
    ];
    const ctx = makeCtx([...camelFiles, ...snakeFiles]);
    const findings = await namingAnalyzer.analyze(ctx);
    const dev = findings.find((f) => f.tags.includes("inconsistency"));
    expect(dev).toBeDefined();
    expect(dev!.confidence).toBeGreaterThanOrEqual(0.3);
    expect(dev!.confidence).toBeLessThan(0.5);
  });

  it("emits 'no convention' info instead of flagging deviators on a 50/50 split", async () => {
    // 3 files each → H normalized ~ 1.0 → no dominant convention.
    const camel = Array.from({ length: 3 }, (_, i) => ({
      relativePath: `cam${i}.ts`,
      content: `const userName${i} = 1;\nconst orderId${i} = 2;\nfunction getUser${i}() {}\n`,
    }));
    const snake = Array.from({ length: 3 }, (_, i) => ({
      relativePath: `sn${i}.ts`,
      content: `const user_name${i} = 1;\nconst order_id${i} = 2;\nfunction get_user${i}() {}\n`,
    }));
    const ctx = makeCtx([...camel, ...snake]);
    const findings = await namingAnalyzer.analyze(ctx);
    const noConv = findings.find((f) => f.tags.includes("no-convention"));
    expect(noConv).toBeDefined();
    expect(noConv!.severity).toBe("info");
  });

  it("bumps version to 2", () => {
    expect(namingAnalyzer.version).toBe(2);
  });
});
