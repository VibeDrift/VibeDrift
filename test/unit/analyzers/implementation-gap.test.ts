import { describe, it, expect } from "vitest";
import { implementationGapAnalyzer } from "../../../src/analyzers/implementation-gap.js";
import type { AnalysisContext, SourceFile } from "../../../src/core/types.js";

function mkFile(path: string, language: SourceFile["language"], content: string): SourceFile {
  return {
    path,
    relativePath: path,
    language,
    content,
    lineCount: content.split("\n").length,
  };
}

function mkCtx(files: SourceFile[]): AnalysisContext {
  return {
    rootDir: "/test",
    files,
    packageJson: null,
    goMod: null,
    cargoToml: null,
    requirementsTxt: null,
    envExample: null,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    languageBreakdown: new Map(),
    dominantLanguage: files[0]?.language ?? null,
  };
}

describe("implementation-gap analyzer", () => {
  it("flags the exact /v1/analyze stub that motivated this detector", async () => {
    // The Python code that shipped in production. Reproducing it
    // here — the test passes when the analyzer would have caught
    // it before merge.
    const file = mkFile(
      "api/routes/analyze.py",
      "python",
      `
for i, val in enumerate(body.llm_validations):
    response.llm_validations.append(LlmValidationResult(
        finding_index=i,
        verdict="unvalidated",
        explanation="LLM proxy not yet implemented",
    ))
`,
    );
    const findings = await implementationGapAnalyzer.analyze(mkCtx([file]));
    expect(findings.length).toBeGreaterThan(0);
    const msg = findings.map((f) => f.message).join(" ");
    expect(msg.toLowerCase()).toContain("placeholder return");
  });

  it("flags explicit NotImplementedError as error severity", async () => {
    const file = mkFile(
      "api/service.py",
      "python",
      `def do_the_thing():
    raise NotImplementedError("not yet")
`,
    );
    const findings = await implementationGapAnalyzer.analyze(mkCtx([file]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].tags).toContain("not-implemented");
  });

  it("flags JS/TS throw new Error('Not implemented')", async () => {
    const file = mkFile(
      "src/handler.ts",
      "typescript",
      `export function handle() {
  throw new Error("Not implemented");
}`,
    );
    const findings = await implementationGapAnalyzer.analyze(mkCtx([file]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
  });

  it("flags Rust unimplemented!() / todo!()", async () => {
    const file = mkFile(
      "src/lib.rs",
      "rust",
      `pub fn compute() -> i32 {
  unimplemented!()
}`,
    );
    const findings = await implementationGapAnalyzer.analyze(mkCtx([file]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
  });

  it("flags Go panic('not implemented')", async () => {
    const file = mkFile(
      "pkg/svc.go",
      "go",
      `func Compute() int {
  panic("not implemented")
}`,
    );
    const findings = await implementationGapAnalyzer.analyze(mkCtx([file]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
  });

  it("flags return 'unvalidated' as placeholder", async () => {
    const file = mkFile(
      "src/validate.ts",
      "typescript",
      `export function validate() {
  return "unvalidated";
}`,
    );
    const findings = await implementationGapAnalyzer.analyze(mkCtx([file]));
    expect(findings).toHaveLength(1);
    expect(findings[0].tags).toContain("placeholder");
  });

  it("does NOT flag normal code with real return values", async () => {
    const file = mkFile(
      "src/validate.ts",
      "typescript",
      `export function validate(x: number) {
  if (x > 0) return "valid";
  return "invalid";
}`,
    );
    expect(await implementationGapAnalyzer.analyze(mkCtx([file]))).toHaveLength(0);
  });

  it("does NOT flag the word 'todo' when it's unrelated vocab (whole-word rule)", async () => {
    const file = mkFile(
      "src/data.ts",
      "typescript",
      `export function loadTodoList() {
  return "items: todo-1, todo-2";
}`,
    );
    // "items: todo-1, todo-2" is not exactly "todo" (trimmed, whole
    // string). Should NOT flag.
    expect(await implementationGapAnalyzer.analyze(mkCtx([file]))).toHaveLength(0);
  });

  it("escalates to error severity at 3+ placeholder returns", async () => {
    const file = mkFile(
      "src/stubs.ts",
      "typescript",
      `export function a() { return "stub"; }
export function b() { return "TODO"; }
export function c() { return "placeholder"; }
export function d() { return "not implemented"; }
`,
    );
    const findings = await implementationGapAnalyzer.analyze(mkCtx([file]));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
  });

  it("handles empty files without crashing", async () => {
    const file = mkFile("src/empty.ts", "typescript", "");
    expect(await implementationGapAnalyzer.analyze(mkCtx([file]))).toHaveLength(0);
  });

  it("flags placeholder field assignments in Python Pydantic constructors (the original bug pattern)", async () => {
    const file = mkFile(
      "api/stub.py",
      "python",
      `result = LlmResult(
    verdict="unvalidated",
    explanation="not yet implemented",
)`,
    );
    const findings = await implementationGapAnalyzer.analyze(mkCtx([file]));
    // At least one finding for the placeholder_field hits.
    expect(findings.length).toBeGreaterThan(0);
  });

  it("does NOT flag long domain strings matching placeholder words within them", async () => {
    const file = mkFile(
      "src/msg.ts",
      "typescript",
      `export function err() {
  return "The server is under construction maintenance and not yet accepting requests.";
}`,
    );
    // 60-char cap + whole-string-only match means this long message
    // won't trigger. Documents current behavior.
    expect(await implementationGapAnalyzer.analyze(mkCtx([file]))).toHaveLength(0);
  });
});
