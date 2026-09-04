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

  it("does not scan past a body-less TS overload signature into the next function (regression: overload body counted twice)", async () => {
    // findFunctionBodyBrace used to scan up to 500 chars for the first `{`
    // at depth 0. An overload signature (`async load(id: string): Promise<User>;`)
    // has no body, so the scan walked past the `;` and returned the NEXT
    // function's brace — the implementation's unhandled-await body was then
    // analyzed twice (once attributed to the overload, once to itself).
    // With 3 classes of [overload + impl] that double-count produced 6
    // (> 3, a finding); the correct count of 3 stays below the threshold.
    // A 4th file with a plain implementation tips the correct count to 4
    // so we can assert the exact count rather than just absence.
    const dir = "src/repo";
    const overloadClass = (i: number) => `export class Repo${i} {
  async load(id: string): Promise<User>;
  async load(id: number): Promise<User>;
  async load(id: string | number): Promise<User> {
    const row = await this.db.get(id);
    return toUser(row);
  }
}
`;
    const files = [0, 1, 2].map((i) => ({
      path: `/test/${dir}/repo${i}.ts`,
      relativePath: `${dir}/repo${i}.ts`,
      language: "typescript" as const,
      content: overloadClass(i),
      lineCount: 9,
    }));
    files.push({
      path: `/test/${dir}/plain.ts`,
      relativePath: `${dir}/plain.ts`,
      language: "typescript" as const,
      content: `export async function ping(): Promise<void> {\n  await fetch("/ping");\n}\n`,
      lineCount: 3,
    });
    const ctx: AnalysisContext = { ...BASE, files, totalLines: 30 };
    const findings = await errorHandlingAnalyzer.analyze(ctx);
    const unhandled = findings.find((f) => f.tags.includes("unhandled-async"));
    expect(unhandled).toBeDefined();
    // 3 real implementations + 1 plain function = 4. Two overload
    // signatures per class contribute nothing — they have no body.
    expect(unhandled?.message).toContain(`4 async functions without error handling in ${dir}/`);
  });

  it("still finds the body when a return type contains `;` inside an inline object type", async () => {
    // `;` is only a terminator at depth 0 — inside `Promise<{ a: string; b: number }>`
    // it's a property separator and must not abort the body search.
    const dir = "src/api";
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `/test/${dir}/g${i}.ts`,
      relativePath: `${dir}/g${i}.ts`,
      language: "typescript" as const,
      content: `export async function get${i}(): Promise<{ a: string; b: number }> {\n  const r = await fetch("/x");\n  return { a: "", b: r.status };\n}\n`,
      lineCount: 4,
    }));
    const ctx: AnalysisContext = { ...BASE, files, totalLines: 16 };
    const findings = await errorHandlingAnalyzer.analyze(ctx);
    const unhandled = findings.find((f) => f.tags.includes("unhandled-async"));
    expect(unhandled?.message).toContain(`4 async functions without error handling in ${dir}/`);
  });
});
