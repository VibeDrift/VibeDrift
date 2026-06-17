import { describe, it, expect } from "vitest";
import { dependenciesAnalyzer } from "../../../src/analyzers/dependencies.js";
import type { AnalysisContext } from "../../../src/core/types.js";

const BASE: Omit<AnalysisContext, "files" | "packageJson" | "totalLines"> = {
  rootDir: "/test",
  goMod: null,
  cargoToml: null,
  requirementsTxt: null,
  envExample: null,
  languageBreakdown: new Map(),
  dominantLanguage: null,
};

describe("dependencies analyzer", () => {
  it("detects phantom dependencies", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/index.ts", relativePath: "index.ts", language: "typescript",
        content: 'import express from "express";\n', lineCount: 1,
      }],
      packageJson: { dependencies: { express: "^4.0.0", lodash: "^4.0.0" } },
      totalLines: 1,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("phantom"))).toBeDefined();
  });

  it("detects missing dependencies", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/index.ts", relativePath: "index.ts", language: "typescript",
        content: 'import axios from "axios";\n', lineCount: 1,
      }],
      packageJson: { dependencies: {} },
      totalLines: 1,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("missing"))).toBeDefined();
  });
});
