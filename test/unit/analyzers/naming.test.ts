import { describe, it, expect } from "vitest";
import { namingAnalyzer } from "../../../src/analyzers/naming.js";
import { parseFile } from "../../../src/utils/ast.js";
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

  it("bumps version to 3", () => {
    expect(namingAnalyzer.version).toBe(3);
  });

  it("is not blind to Python via the AST path (regression: targetTypes lacked function_definition)", async () => {
    // extractIdentifiers only walks a fixed set of AST node types. Before
    // the fix that set had no Python function-definition node, so — on a
    // REAL parsed tree (not the regex fallback, which already handled
    // `def` via a separate code path and would mask this bug) — every
    // Python file yielded zero identifiers and the analyzer produced no
    // findings at all for Python, regardless of naming convention.
    // Parsed sequentially (not Promise.all) — concurrent first-time calls
    // into parseFile's shared grammar-init/cache can race and return null
    // for some files; that's a pre-existing quirk of ast.ts's init guard,
    // unrelated to what this test is regression-checking, so sidestep it.
    const camelFiles: SourceFile[] = [];
    for (let i = 0; i < 8; i++) {
      const content = `def getUser${i}():\n    pass\n\ndef fetchOrder${i}():\n    pass\n`;
      const file: SourceFile = {
        path: `/test/cam${i}.py`, relativePath: `cam${i}.py`, language: "python",
        content, lineCount: content.split("\n").length,
      };
      file.tree = (await parseFile(file)) ?? undefined;
      camelFiles.push(file);
    }
    const snakeFiles: SourceFile[] = [];
    for (const name of ["s1", "s2"]) {
      const content = `def get_user():\n    pass\n\ndef fetch_order():\n    pass\n`;
      const file: SourceFile = {
        path: `/test/${name}.py`, relativePath: `${name}.py`, language: "python",
        content, lineCount: content.split("\n").length,
      };
      file.tree = (await parseFile(file)) ?? undefined;
      snakeFiles.push(file);
    }

    // Sanity: real trees loaded (not silently falling back to null).
    for (const f of [...camelFiles, ...snakeFiles]) expect(f.tree).toBeDefined();

    const ctx: AnalysisContext = {
      rootDir: "/test",
      files: [...camelFiles, ...snakeFiles],
      packageJson: null,
      goMod: null,
      cargoToml: null,
      requirementsTxt: null,
      envExample: null,
      totalLines: 0,
      languageBreakdown: new Map(),
      dominantLanguage: "python",
    };

    const findings = await namingAnalyzer.analyze(ctx);
    // Before the fix this was always [] for Python — extractIdentifiers
    // returned nothing for every file, so conventionCounts stayed empty.
    const dev = findings.find((f) => f.tags.includes("inconsistency"));
    expect(dev).toBeDefined();
    expect(dev!.message).toMatch(/snake_case|camelCase/);
  });

  it("a single all-lowercase word votes for neither convention (issue #114 root cause)", async () => {
    // `main`, `run`, `config` are valid in BOTH camelCase and snake_case, so
    // they carry no convention signal. The camelCase regex is tried first, so
    // without this they all counted as camelCase. That only started to matter
    // once Python `function_definition` entered the extractor above: `def
    // main` / `def run` / `def health` are overwhelmingly common, and on real
    // repos they flipped the whole vote — measured on
    // full-stack-fastapi-template, the analyzer reported "25 files use
    // snake_case while majority uses camelCase" for a Python project, which is
    // backwards.
    //
    // Binds: let a one-word name count as camelCase again and the eight
    // one-word files below become a camelCase "majority" that flags the three
    // genuinely snake_case ones.
    const oneWord = Array.from({ length: 8 }, (_, i) => ({
      relativePath: `one_word_${i}.py`,
      content: "def main():\n    pass\n\ndef run():\n    pass\n\ndef health():\n    pass\n",
      language: "python" as const,
    }));
    const snake = Array.from({ length: 3 }, (_, i) => ({
      relativePath: `snake_${i}.py`,
      content: "def load_user_profile():\n    pass\n\ndef save_user_profile():\n    pass\n",
      language: "python" as const,
    }));
    const findings = await namingAnalyzer.analyze(makeCtx([...oneWord, ...snake]));
    const naming = findings.find((f) => f.analyzerId === "naming");
    expect(naming?.message ?? "").not.toMatch(/majority uses camelCase/);
  });
});
