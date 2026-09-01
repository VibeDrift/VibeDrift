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

  // Issue #104: this analyzer emits exactly ONE project-level finding however
  // many files deviate, and the engine's count branch divides by the number of
  // findings. Without itemCount, 1 stray CommonJS file and 40 score the same.
  it("carries the minority file count as itemCount on the project finding", async () => {
    const esm = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `/test/e${i}.js`, relativePath: `e${i}.js`, language: "javascript" as const,
        content: 'import foo from "foo";\n', lineCount: 1,
      }));
    const cjs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `/test/c${i}.js`, relativePath: `c${i}.js`, language: "javascript" as const,
        content: 'const bar = require("bar");\n', lineCount: 1,
      }));
    const run = async (nEsm: number, nCjs: number) => {
      const ctx: AnalysisContext = { ...BASE, files: [...esm(nEsm), ...cjs(nCjs)], totalLines: nEsm + nCjs };
      const findings = await importsAnalyzer.analyze(ctx);
      return findings.find((f) => f.message.includes("across project"));
    };

    // Minority is the CJS side.
    const few = await run(20, 1);
    expect(few?.itemCount).toBe(1);

    // Same single finding, forty times the deviating population.
    const many = await run(20, 40);
    expect(many?.itemCount).toBe(20); // minority flips to the ESM side at 20 vs 40
    expect(many?.locations.length).toBe(10); // locations still truncate; itemCount does not
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

  // Pinned on purpose: this analyzer's findings are cached by version, so a
  // behaviour change that forgets to bump it is served stale and will not
  // reproduce on a warm machine. v3 adds itemCount (issue #104).
  it("pins version to 3 (invalidates findings cache)", () => {
    expect(importsAnalyzer.version).toBe(3);
  });
});
