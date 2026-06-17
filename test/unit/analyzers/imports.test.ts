import { describe, it, expect } from "vitest";
import { importsAnalyzer } from "../../../src/analyzers/imports.js";
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

describe("imports analyzer", () => {
  it("detects mixed ESM/CJS", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [
        { path: "/test/a.js", relativePath: "a.js", language: "javascript", content: 'import foo from "foo";\n', lineCount: 1 },
        { path: "/test/b.js", relativePath: "b.js", language: "javascript", content: 'const bar = require("bar");\n', lineCount: 1 },
      ],
      totalLines: 2,
    };
    const findings = await importsAnalyzer.analyze(ctx);
    expect(findings.some((f) => f.message.includes("Mixed ESM/CommonJS"))).toBe(true);
  });

  it("returns empty for consistent imports", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [
        { path: "/test/a.ts", relativePath: "a.ts", language: "typescript", content: 'import foo from "foo";\nexport const x = 1;\n', lineCount: 2 },
      ],
      totalLines: 2,
    };
    const findings = await importsAnalyzer.analyze(ctx);
    expect(findings).toEqual([]);
  });

  it("does NOT flag require() of Node built-ins alongside ESM imports", async () => {
    // A1 invariant: `require('fs')` and `require('path')` are idiomatic
    // even in ESM projects. Previously this pattern was flagged as drift.
    const ctx: AnalysisContext = {
      ...BASE,
      files: [
        {
          path: "/test/a.ts", relativePath: "a.ts", language: "typescript",
          content: 'import { x } from "./util";\nconst fs = require("fs");\nconst path = require("node:path");\n',
          lineCount: 3,
        },
      ],
      totalLines: 3,
    };
    const findings = await importsAnalyzer.analyze(ctx);
    expect(findings).toEqual([]);
  });

  it("still flags require() of non-builtin npm packages in ESM files", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [
        {
          path: "/test/a.ts", relativePath: "a.ts", language: "typescript",
          content: 'import { x } from "./util";\nconst lodash = require("lodash");\n',
          lineCount: 2,
        },
      ],
      totalLines: 2,
    };
    const findings = await importsAnalyzer.analyze(ctx);
    expect(findings.some((f) => f.message.includes("Mixed"))).toBe(true);
  });

  it("bumps version to 2 (invalidates findings cache)", () => {
    expect(importsAnalyzer.version).toBe(2);
  });
});
