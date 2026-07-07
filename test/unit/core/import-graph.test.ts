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
