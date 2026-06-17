import { describe, it, expect } from "vitest";
import { deadCodeAnalyzer } from "../../../src/analyzers/dead-code.js";
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
    dominantLanguage: "typescript",
  };
}

describe("dead-code analyzer (import-graph reachability)", () => {
  it("flags a file that no other file imports (A2 file-level)", async () => {
    const ctx = makeCtx([
      { relativePath: "src/index.ts", content: `import { greet } from './utils';\ngreet("hello");\n` },
      { relativePath: "src/utils.ts", content: `export function greet(s: string) { return s; }\n` },
      // orphan.ts is never imported.
      { relativePath: "src/orphan.ts", content: `export function dust() { return 1; }\nexport const lost = 42;\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    const orphan = findings.find((f) => f.tags.includes("orphan-file"));
    expect(orphan).toBeDefined();
    expect(orphan?.locations.some((l) => l.file.includes("orphan.ts"))).toBe(true);
  });

  it("does NOT flag entry-point files even with zero imports", async () => {
    const ctx = makeCtx([
      { relativePath: "src/index.ts", content: `export function main() { return 1; }\n` },
      { relativePath: "src/main.ts", content: `export function other() { return 2; }\n` },
      { relativePath: "src/app.config.ts", content: `export const config = { x: 1 };\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    const orphan = findings.find((f) => f.tags.includes("orphan-file"));
    // All files are entry-point-ish; no orphan finding expected.
    expect(orphan).toBeUndefined();
  });

  it("has a monotonically-bumped version so the findings cache invalidates", () => {
    expect(deadCodeAnalyzer.version).toBeGreaterThanOrEqual(2);
  });
});
