import { describe, it, expect } from "vitest";
import { buildDriftContext } from "../../../src/drift/index.js";
import type { AnalysisContext } from "../../../src/core/types.js";
import { parseFile } from "../../../src/utils/ast.js";
import { phantomScaffolding } from "../../../src/drift/phantom-scaffolding.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

const mkCtx = (files: DriftFile[]): DriftContext => ({
  files,
  totalLines: files.reduce((s, f) => s + f.lineCount, 0),
  dominantLanguage: "typescript",
});

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

// Regression: the plumbing above stops one layer short. `buildDriftContext`
// carries the tree onto DriftFile, but a detector that rebuilds SourceFile
// objects to hand to `buildImportGraph` can drop it again, and the graph then
// silently falls back to regex parsing of raw file content. Regex export
// extraction matches inside string literals, so sample code embedded in a
// template literal registers as a real export (issue: phantom-scaffolding
// flagged its own test fixtures this way).
describe("phantom-scaffolding uses the AST import graph", () => {
  const mk = async (relativePath: string, content: string): Promise<DriftFile> => {
    const source = {
      path: `/r/${relativePath}`,
      relativePath,
      language: "typescript" as const,
      content,
      lineCount: content.split("\n").length,
    };
    const tree = await parseFile(source);
    expect(tree).not.toBeNull();
    return { ...source, tree: tree ?? undefined };
  };

  const phantomNames = (findings: { deviatingFiles: { evidence?: { code: string }[] }[] }[]): string[] =>
    findings
      .flatMap((f) => f.deviatingFiles)
      .flatMap((d) => d.evidence ?? [])
      .map((e) => /^export (\w+)\(\)/.exec(e.code)?.[1] ?? "")
      .filter(Boolean);

  it("ignores a CRUD export that only appears inside a template literal", async () => {
    // `createUser` is a real unrouted export. `getOrder` exists only as text
    // inside a string, so it is not an export of anything.
    const files = [
      await mk("src/handlers/real.ts", `export function createUser() {\n  return 1;\n}\n`),
      await mk(
        "src/docs/snippet.ts",
        "const sample = `export function getOrder() {\\n  return 2;\\n}`;\nexport const note = sample.length;\n",
      ),
    ];
    const names = phantomNames(phantomScaffolding.detect(mkCtx(files)));
    // Control: without this the test would pass on a detector that found nothing.
    expect(names).toContain("createUser");
    expect(names).not.toContain("getOrder");
  });

  it("ignores a CRUD export that only appears inside a line comment", async () => {
    const files = [
      await mk("src/handlers/real.ts", `export function createUser() {\n  return 1;\n}\n`),
      await mk(
        "src/docs/note.ts",
        "// export function deleteToken() {}\nexport const note = 1;\n",
      ),
    ];
    const names = phantomNames(phantomScaffolding.detect(mkCtx(files)));
    expect(names).toContain("createUser");
    expect(names).not.toContain("deleteToken");
  });
});
