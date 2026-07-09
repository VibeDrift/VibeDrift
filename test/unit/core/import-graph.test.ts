import { describe, it, expect } from "vitest";
import { parseImports, parseExports } from "../../../src/core/import-graph.js";
import type { SourceFile } from "../../../src/core/types.js";

function makeFile(content: string, relativePath = "test.ts"): SourceFile {
  return {
    path: "/test/" + relativePath,
    relativePath,
    language: "typescript",
    content,
    lineCount: content.split("\n").length,
  };
}

describe("parseImports — type-only imports", () => {
  it("captures names + source for `import type { Foo } from './x'`", () => {
    const { names, sources } = parseImports(
      makeFile(`import type { WorkerRequest, WorkerResponse } from './analysis-worker';\n`),
    );
    expect(names.has("WorkerRequest")).toBe(true);
    expect(names.has("WorkerResponse")).toBe(true);
    expect(sources.has("./analysis-worker")).toBe(true);
  });

  it("strips per-specifier `type` in `import { type Foo, Bar } from './y'`", () => {
    const { names, sources } = parseImports(
      makeFile(`import { type Foo, Bar } from './y';\n`),
    );
    expect(names.has("Foo")).toBe(true);
    expect(names.has("Bar")).toBe(true);
    expect(names.has("type Foo")).toBe(false);
    expect(sources.has("./y")).toBe(true);
  });

  it("captures default type import `import type Foo from './z'`", () => {
    const { names, sources } = parseImports(
      makeFile(`import type WorkerRequest from './z';\n`),
    );
    expect(names.has("WorkerRequest")).toBe(true);
    expect(sources.has("./z")).toBe(true);
  });

  it("still parses ordinary value imports unchanged", () => {
    const { names, sources } = parseImports(
      makeFile(`import { greet } from './utils';\nimport React from 'react';\n`),
    );
    expect(names.has("greet")).toBe(true);
    expect(names.has("React")).toBe(true);
    expect(sources.has("./utils")).toBe(true);
    expect(sources.has("react")).toBe(true);
  });
});

describe("parseExports — single-name re-export trimming", () => {
  it("trims a single-name barrel re-export so it matches a trimmed imported name", () => {
    const names = parseExports(
      makeFile("export { readErrorFromPayload } from './payload-error';\n"),
    ).map((e) => e.name);
    expect(names).toContain("readErrorFromPayload");
    expect(names).not.toContain(" readErrorFromPayload ");
  });

  it("trims an `as` alias in a single-name re-export", () => {
    const names = parseExports(
      makeFile("export { internalName as publicName } from './impl';\n"),
    ).map((e) => e.name);
    expect(names).toContain("internalName");
  });
});

describe("buildImportGraph — multi-component relative paths", () => {
  it("resolves incoming imports for files with directory-separated paths", async () => {
    const { buildImportGraph } = await import("../../../src/core/import-graph.js");

    const indexFile = makeFile(
      `import { complexityAnalyzer } from "./complexity.js";\nimport { namingAnalyzer } from "./naming.js";\n`,
      "src/analyzers/index.ts",
    );
    const complexityFile = makeFile(
      `export const complexityAnalyzer = {};\n`,
      "src/analyzers/complexity.ts",
    );
    const namingFile = makeFile(
      `export const namingAnalyzer = {};\n`,
      "src/analyzers/naming.ts",
    );

    const graph = buildImportGraph([indexFile, complexityFile, namingFile]);

    // complexity.ts and naming.ts should each have 1 incoming import from index.ts
    expect(graph.incomingCount.get("src/analyzers/complexity.ts")).toBe(1);
    expect(graph.incomingCount.get("src/analyzers/naming.ts")).toBe(1);
    // index.ts has no one importing it
    expect(graph.incomingCount.get("src/analyzers/index.ts")).toBe(0);
  });

  it("resolves barrel index files by parent directory name", async () => {
    const { buildImportGraph } = await import("../../../src/core/import-graph.js");

    const consumer = makeFile(
      `import { createRegistry } from "../../analyzers/index.js";\n`,
      "src/cli/commands/scan.ts",
    );
    const barrel = makeFile(
      `export function createRegistry() {}\n`,
      "src/analyzers/index.ts",
    );

    const graph = buildImportGraph([consumer, barrel]);

    // index.ts should be resolved via its parent dir name "analyzers"
    expect(graph.incomingCount.get("src/analyzers/index.ts")).toBe(1);
  });
});

describe("fileBasename — backslash path handling (Windows regression)", () => {
  it("resolves basename from a backslash-separated path", async () => {
    const { fileBasename } = await import("../../../src/core/import-graph.js");

    // On Windows, path.relative() produces backslash paths. fileBasename must
    // handle both separators so the import graph works regardless of OS.
    expect(fileBasename("src\\analyzers\\complexity.ts")).toBe("complexity");
    expect(fileBasename("src\\analyzers\\index.ts")).toBe("analyzers");
    expect(fileBasename("src/analyzers/complexity.ts")).toBe("complexity");
    expect(fileBasename("src/analyzers/index.ts")).toBe("analyzers");
  });

  it("resolves incomingCount even when relativePaths use backslashes", async () => {
    const { buildImportGraph } = await import("../../../src/core/import-graph.js");

    // Simulate Windows: relativePath has backslashes, but import sources in
    // code always use forward slashes. The graph must still match them.
    const indexFile = makeFile(
      `import { helper } from "./helper.js";\n`,
      "src\\utils\\index.ts",
    );
    const helperFile = makeFile(
      `export function helper() {}\n`,
      "src\\utils\\helper.ts",
    );

    const graph = buildImportGraph([indexFile, helperFile]);

    expect(graph.incomingCount.get("src\\utils\\helper.ts")).toBe(1);
    expect(graph.incomingCount.get("src\\utils\\index.ts")).toBe(0);
  });
});

describe("parseImports — dynamic await import()", () => {
  it("captures destructured names from `const { X } = await import('./mod')`", () => {
    const { names, sources } = parseImports(
      makeFile(`const { runAnalysis, buildGraph } = await import("./codedna/index.js");\n`),
    );
    expect(names.has("runAnalysis")).toBe(true);
    expect(names.has("buildGraph")).toBe(true);
    expect(sources.has("./codedna/index.js")).toBe(true);
  });

  it("captures dynamic imports with single quotes", () => {
    const { names, sources } = parseImports(
      makeFile(`const { checkForUpdate } = await import('../../core/update-check.js');\n`),
    );
    expect(names.has("checkForUpdate")).toBe(true);
    expect(sources.has("../../core/update-check.js")).toBe(true);
  });

  it("captures let and var destructured dynamic imports", () => {
    const { names, sources } = parseImports(
      makeFile(`let { openBrowser } = await import("../auth/browser.js");\n`),
    );
    expect(names.has("openBrowser")).toBe(true);
    expect(sources.has("../auth/browser.js")).toBe(true);
  });

  it("captures namespace form `const ns = await import('./mod')`", () => {
    const { names, sources } = parseImports(
      makeFile(`const utils = await import("./helpers.js");\n`),
    );
    expect(names.has("utils")).toBe(true);
    expect(sources.has("./helpers.js")).toBe(true);
  });

  it("captures multi-line destructured dynamic imports", () => {
    const { names, sources } = parseImports(
      makeFile(`const {\n  assembleBaseline,\n  writeBaseline\n} = await import("../../core/baseline.js");\n`),
    );
    expect(names.has("assembleBaseline")).toBe(true);
    expect(names.has("writeBaseline")).toBe(true);
    expect(sources.has("../../core/baseline.js")).toBe(true);
  });

  it("does NOT capture bare await import() with no assignment", () => {
    const { names, sources } = parseImports(
      makeFile(`await import("./register-globals.js");\n`),
    );
    expect(names.size).toBe(0);
    expect(sources.size).toBe(0);
  });
});

describe("import-resolver — real path resolution", () => {
  it("resolves relative .js import to .ts file (extension mapping)", async () => {
    const { buildFileIndex, resolveImportSource } = await import("../../../src/core/import-resolver.js");
    const index = buildFileIndex(["src/utils/helpers.ts", "src/cli/scan.ts"]);

    const result = resolveImportSource("../utils/helpers.js", "src/cli/scan.ts", index);
    expect(result).toBe("src/utils/helpers.ts");
  });

  it("resolves extensionless import by trying .ts", async () => {
    const { buildFileIndex, resolveImportSource } = await import("../../../src/core/import-resolver.js");
    const index = buildFileIndex(["src/core/types.ts", "src/cli/scan.ts"]);

    const result = resolveImportSource("../core/types", "src/cli/scan.ts", index);
    expect(result).toBe("src/core/types.ts");
  });

  it("resolves directory import to index.ts", async () => {
    const { buildFileIndex, resolveImportSource } = await import("../../../src/core/import-resolver.js");
    const index = buildFileIndex(["src/analyzers/index.ts", "src/cli/scan.ts"]);

    const result = resolveImportSource("../analyzers", "src/cli/scan.ts", index);
    expect(result).toBe("src/analyzers/index.ts");
  });

  it("resolves @/ path alias to src/", async () => {
    const { buildFileIndex, resolveImportSource } = await import("../../../src/core/import-resolver.js");
    const index = buildFileIndex(["src/lib/foo.ts"]);
    const config = { pathAliases: { "@/*": "src/*" } };

    const result = resolveImportSource("@/lib/foo", "src/cli/scan.ts", index, config);
    expect(result).toBe("src/lib/foo.ts");
  });

  it("returns null for bare package imports", async () => {
    const { buildFileIndex, resolveImportSource } = await import("../../../src/core/import-resolver.js");
    const index = buildFileIndex(["src/cli/scan.ts"]);

    expect(resolveImportSource("react", "src/cli/scan.ts", index)).toBeNull();
    expect(resolveImportSource("@supabase/supabase-js", "src/cli/scan.ts", index)).toBeNull();
    expect(resolveImportSource("node:fs", "src/cli/scan.ts", index)).toBeNull();
    expect(resolveImportSource("zod", "src/cli/scan.ts", index)).toBeNull();
  });

  it("returns null for relative imports that point to non-existent files", async () => {
    const { buildFileIndex, resolveImportSource } = await import("../../../src/core/import-resolver.js");
    const index = buildFileIndex(["src/cli/scan.ts", "src/core/types.ts"]);

    expect(resolveImportSource("./nonexistent", "src/cli/scan.ts", index)).toBeNull();
    expect(resolveImportSource("../missing/module.js", "src/cli/scan.ts", index)).toBeNull();
  });

  it("two files with the same basename in different directories do NOT collide", async () => {
    const { buildImportGraph } = await import("../../../src/core/import-graph.js");

    // Two files named "helpers.ts" in different directories
    const utilsHelper = makeFile(
      `export function formatDate() {}\n`,
      "src/utils/helpers.ts",
    );
    const testHelper = makeFile(
      `export function mockDb() {}\n`,
      "test/helpers.ts",
    );
    // Only imports src/utils/helpers, NOT test/helpers
    const consumer = makeFile(
      `import { formatDate } from "../utils/helpers.js";\n`,
      "src/cli/scan.ts",
    );

    const graph = buildImportGraph([utilsHelper, testHelper, consumer]);

    // src/utils/helpers.ts should get 1 incoming (from scan.ts)
    expect(graph.incomingCount.get("src/utils/helpers.ts")).toBe(1);
    // test/helpers.ts should get 0 — the import resolves to src/utils, not test/
    expect(graph.incomingCount.get("test/helpers.ts")).toBe(0);
  });
});

describe("parseImportsAst — real tree-sitter parsing", () => {
  it("extracts static imports from a parsed tree", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseImportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `import { foo, bar } from "./utils.js";\nimport type { Baz } from "./types.js";\nimport * as ns from "./namespace.js";\n`,
      "src/test.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const { names, sources } = parseImportsAst(tree!);
    expect(sources.has("./utils.js")).toBe(true);
    expect(sources.has("./types.js")).toBe(true);
    expect(sources.has("./namespace.js")).toBe(true);
    expect(names.has("foo")).toBe(true);
    expect(names.has("bar")).toBe(true);
    expect(names.has("Baz")).toBe(true);
    expect(names.has("ns")).toBe(true);
  });

  it("extracts dynamic imports nested inside functions", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseImportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `async function run() {\n  const { analyze } = await import("./analyzer.js");\n  const mod = await import("./module.js");\n}\n`,
      "src/runner.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const { names, sources } = parseImportsAst(tree!);
    expect(sources.has("./analyzer.js")).toBe(true);
    expect(sources.has("./module.js")).toBe(true);
    expect(names.has("analyze")).toBe(true);
    expect(names.has("mod")).toBe(true);
  });

  it("extracts require() calls", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseImportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `const { readFile } = require("fs");\nfunction init() { const cfg = require("./config"); }\n`,
      "src/legacy.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const { sources } = parseImportsAst(tree!);
    expect(sources.has("fs")).toBe(true);
    expect(sources.has("./config")).toBe(true);
  });

  it("extracts re-export sources", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseImportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `export { foo } from "./foo.js";\nexport * from "./all.js";\nexport * as utils from "./utils.js";\n`,
      "src/barrel.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const { sources } = parseImportsAst(tree!);
    expect(sources.has("./foo.js")).toBe(true);
    expect(sources.has("./all.js")).toBe(true);
    expect(sources.has("./utils.js")).toBe(true);
  });
});

describe("parseExportsAst — real tree-sitter parsing", () => {
  it("extracts named function and const exports", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseExportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `export function hello() {}\nexport const MY_CONST = 1;\nexport class MyClass {}\n`,
      "src/mod.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const exports = parseExportsAst(tree!, "src/mod.ts");
    const names = exports.map((e) => e.name);
    expect(names).toContain("hello");
    expect(names).toContain("MY_CONST");
    expect(names).toContain("MyClass");
    expect(exports.every((e) => !e.isDefault)).toBe(true);
  });

  it("extracts default exports", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseExportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `export default function main() {}\n`,
      "src/entry.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const exports = parseExportsAst(tree!, "src/entry.ts");
    expect(exports.length).toBe(1);
    expect(exports[0].name).toBe("main");
    expect(exports[0].isDefault).toBe(true);
  });

  it("extracts export clause (re-exports)", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseExportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `export { alpha, beta as b } from "./multi.js";\n`,
      "src/barrel.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const exports = parseExportsAst(tree!, "src/barrel.ts");
    const names = exports.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("extracts export * as namespace", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseExportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `export * as util from "./y.js";\n`,
      "src/ns.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const exports = parseExportsAst(tree!, "src/ns.ts");
    const names = exports.map((e) => e.name);
    expect(names).toContain("util");
  });

  it("does NOT produce names for bare export * (star re-export)", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { parseExportsAst } = await import("../../../src/core/import-graph-ast.js");

    const file = makeFile(
      `export * from "./everything.js";\n`,
      "src/barrel.ts",
    );
    const tree = await parseFile(file);
    expect(tree).not.toBeNull();

    const exports = parseExportsAst(tree!, "src/barrel.ts");
    // export * has no named export — it re-exports everything from the source
    expect(exports.length).toBe(0);
  });
});

describe("buildImportGraph — AST path (with file.tree)", () => {
  it("uses AST parsing when tree is available", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");
    const { buildImportGraph } = await import("../../../src/core/import-graph.js");

    const consumer = makeFile(
      `import { helper } from "./helper.js";\n`,
      "src/main.ts",
    );
    const helperFile = makeFile(
      `export function helper() {}\n`,
      "src/helper.ts",
    );

    // Parse both files to get real trees
    consumer.tree = (await parseFile(consumer)) ?? undefined;
    helperFile.tree = (await parseFile(helperFile)) ?? undefined;
    expect(consumer.tree).toBeDefined();
    expect(helperFile.tree).toBeDefined();

    const graph = buildImportGraph([consumer, helperFile]);
    expect(graph.incomingCount.get("src/helper.ts")).toBe(1);
    expect(graph.incomingCount.get("src/main.ts")).toBe(0);
  });
});
