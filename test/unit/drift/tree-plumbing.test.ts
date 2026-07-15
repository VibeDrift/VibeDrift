import { describe, it, expect } from "vitest";
import { buildDriftContext } from "../../../src/drift/index.js";
import type { AnalysisContext } from "../../../src/core/types.js";
import { parseFile } from "../../../src/utils/ast.js";

describe("buildDriftContext tree plumbing", () => {
  it("carries the parsed tree onto DriftFile", async () => {
    const source = {
      path: "/r/a.ts", relativePath: "a.ts", language: "typescript" as const,
      content: "const x = 1;\n", lineCount: 1,
    };
    const tree = await parseFile(source);
    expect(tree).not.toBeNull();
    const ctx = {
      rootDir: "/r", files: [{ ...source, tree: tree ?? undefined }],
      packageJson: null, goMod: null, cargoToml: null, requirementsTxt: null, envExample: null,
      totalLines: 1, languageBreakdown: new Map([["typescript", { files: 1, lines: 1 }]]),
      dominantLanguage: "typescript",
    } as unknown as AnalysisContext;
    const drift = buildDriftContext(ctx);
    expect(drift.files[0].tree).toBe(tree);
  });
});

describe("buildDriftContext goModulePath threading", () => {
  const base = {
    rootDir: "/r", files: [], packageJson: null, cargoToml: null,
    requirementsTxt: null, envExample: null, totalLines: 0,
    languageBreakdown: new Map(), dominantLanguage: "go",
  };

  const ctxWith = (goMod: unknown): AnalysisContext =>
    ({ ...base, goMod } as unknown as AnalysisContext);

  it("threads the root module path from go.mod", () => {
    const drift = buildDriftContext(ctxWith({ module: "example.com/app", require: [] }));
    expect(drift.goModulePath).toBe("example.com/app");
  });

  it("is undefined when there is no go.mod (Go cross-file disabled)", () => {
    const drift = buildDriftContext(ctxWith(null));
    expect(drift.goModulePath).toBeUndefined();
  });

  it("is undefined when go.mod declares a replace directive", () => {
    const drift = buildDriftContext(
      ctxWith({ module: "example.com/app", require: [], hasReplace: true }),
    );
    expect(drift.goModulePath).toBeUndefined();
  });

  it("is undefined when a nested go.mod exists under the scan root", () => {
    const drift = buildDriftContext(
      ctxWith({ module: "example.com/app", require: [], hasNestedModule: true }),
    );
    expect(drift.goModulePath).toBeUndefined();
  });

  it("is undefined when go.mod has an empty module path", () => {
    const drift = buildDriftContext(ctxWith({ module: "", require: [] }));
    expect(drift.goModulePath).toBeUndefined();
  });
});
