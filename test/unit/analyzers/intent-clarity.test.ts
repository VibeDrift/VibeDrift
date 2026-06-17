import { describe, it, expect } from "vitest";
import { intentClarityAnalyzer } from "../../../src/analyzers/intent-clarity.js";
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

describe("intent-clarity analyzer", () => {
  it("flags a validate* function with no throw and no boolean return (A4 verb-AST)", async () => {
    const ctx = makeCtx([
      {
        relativePath: "bad.ts",
        content: `export function validateUser(u: { id: string }) {
  const normalized = u.id.trim();
  const result = { userId: normalized, loadedAt: Date.now() };
  return result;
}
`,
      },
    ]);
    const findings = await intentClarityAnalyzer.analyze(ctx);
    const mismatch = findings.find((f) => f.tags.includes("verb-mismatch"));
    expect(mismatch).toBeDefined();
    expect(mismatch?.locations[0].snippet).toMatch(/validateUser/);
  });

  it("does NOT flag a verb-matching function", async () => {
    const ctx = makeCtx([
      {
        relativePath: "ok.ts",
        content: `export function validateEmail(email: string) {
  if (!email.includes("@")) throw new Error("invalid email");
  return true;
}
`,
      },
    ]);
    const findings = await intentClarityAnalyzer.analyze(ctx);
    const mismatch = findings.find((f) => f.tags.includes("verb-mismatch"));
    expect(mismatch).toBeUndefined();
  });

  it("bumps version to 2", () => {
    expect(intentClarityAnalyzer.version).toBe(2);
  });
});
