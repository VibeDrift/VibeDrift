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
