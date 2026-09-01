import { describe, it, expect } from "vitest";
import { errorHandlingAnalyzer } from "../../../src/analyzers/error-handling.js";
import type { AnalysisContext } from "../../../src/core/types.js";

const BASE: Omit<AnalysisContext, "files" | "totalLines"> = {
  rootDir: "/test",
  packageJson: null,
  goMod: null,
  cargoToml: null,
  requirementsTxt: null,
  envExample: null,
  languageBreakdown: new Map(),
  dominantLanguage: null,
};

describe("error-handling analyzer", () => {
  it("detects empty catch blocks", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/a.ts", relativePath: "a.ts", language: "typescript",
        content: "try { foo(); } catch (e) {}\ntry { bar(); } catch (e) {}\n",
        lineCount: 2,
      }],
      totalLines: 2,
    };
    const findings = await errorHandlingAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("empty-catch"))).toBeDefined();
    expect(findings[0].message).toContain("2 empty catch");
  });

  it("analyzes async functions with an inline object return type (regression: type brace mistaken for body brace)", async () => {
    // The old ASYNC_FN_PATTERN's `(?::\s*[^{]*)?` stopped at the FIRST `{`
    // after the params, which for `Promise<{ ok: boolean }>` is the return
    // type's own brace, not the function body's. Brace-depth counting then
    // started from the wrong place and mislocated (effectively skipped) the
    // real body — an await with no error handling went undetected.
    const dirUnhandled = "src/api";
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `/test/${dirUnhandled}/f${i}.ts`,
      relativePath: `${dirUnhandled}/f${i}.ts`,
      language: "typescript" as const,
      content: `export async function fetchStatus${i}(): Promise<{ ok: boolean }> {\n  const res = await fetch("/status");\n  return { ok: res.ok };\n}\n`,
      lineCount: 4,
    }));
    const ctx: AnalysisContext = { ...BASE, files, totalLines: files.length * 4 };
    const findings = await errorHandlingAnalyzer.analyze(ctx);
    const unhandled = findings.find((f) => f.tags.includes("unhandled-async"));
    expect(unhandled).toBeDefined();
    expect(unhandled?.message).toContain(`4 async functions without error handling in ${dirUnhandled}/`);
  });
});
