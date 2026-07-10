import { describe, it, expect } from "vitest";
import { dependenciesAnalyzer } from "../../../src/analyzers/dependencies.js";
import type { AnalysisContext, SourceFile } from "../../../src/core/types.js";

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

  it("does not flag deps used only in build config (require.resolve + loader string)", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [
        {
          path: "/test/src/index.ts", relativePath: "src/index.ts", language: "typescript",
          content: 'import express from "express";\n', lineCount: 1,
        },
        {
          path: "/test/webpack.config.js", relativePath: "webpack.config.js", language: "javascript",
          content: [
            "module.exports = {",
            "  module: { rules: [{ test: /\\.ts$/, loader: 'ts-loader' }] },",
            "  resolve: {",
            "    fallback: {",
            "      buffer: require.resolve('buffer/'),",
            "      process: require.resolve('process/browser'),",
            "    },",
            "  },",
            "};",
          ].join("\n"),
          lineCount: 9,
        },
      ],
      packageJson: {
        dependencies: { express: "^4.0.0" },
        devDependencies: { "ts-loader": "^9.5.1", buffer: "^6.0.3", process: "^0.11.10" },
      },
      totalLines: 10,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const phantom = findings.find((f) => f.tags.includes("phantom"));
    if (phantom) {
      expect(phantom.message).not.toContain("buffer");
      expect(phantom.message).not.toContain("process");
      expect(phantom.message).not.toContain("ts-loader");
    }
    expect(phantom).toBeUndefined();
  });

  it("still flags a genuinely-unused dep even when a build config is present", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [
        {
          path: "/test/src/index.ts", relativePath: "src/index.ts", language: "typescript",
          content: 'import express from "express";\n', lineCount: 1,
        },
        {
          path: "/test/webpack.config.js", relativePath: "webpack.config.js", language: "javascript",
          content: "module.exports = { module: { rules: [{ loader: 'ts-loader' }] } };",
          lineCount: 1,
        },
      ],
      packageJson: {
        dependencies: { express: "^4.0.0", "totally-unused-lib": "^1.0.0" },
        devDependencies: { "ts-loader": "^9.5.1" },
      },
      totalLines: 2,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const phantom = findings.find((f) => f.tags.includes("phantom"));
    expect(phantom).toBeDefined();
    expect(phantom!.message).toContain("totally-unused-lib");
    expect(phantom!.message).not.toContain("ts-loader");
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

  it("does NOT flag import-like text inside comments or JSDoc as missing deps (AST path)", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");

    // This file has "import" patterns in comments and strings that the regex
    // would match, but the AST path should ignore them.
    const fileContent = `/**
 * Usage:
 *   import { renderReport } from "@vibedrift/cli/render";
 */
import { readFile } from "fs";

// require('lodash') is mentioned here as documentation
const msg = 'the shift from "interesting" to "I should fix this"';
export function run() { return readFile("./x"); }
`;
    const file: SourceFile = {
      path: "/test/src/example.ts",
      relativePath: "src/example.ts",
      language: "typescript" as const,
      content: fileContent,
      lineCount: fileContent.split("\n").length,
    };
    // Parse to get a real tree so the AST path is exercised
    file.tree = (await parseFile(file)) ?? undefined;

    const ctx: AnalysisContext = {
      ...BASE,
      files: [file],
      packageJson: { name: "@vibedrift/cli", dependencies: {} },
      totalLines: file.lineCount,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));

    // Should NOT report @vibedrift/cli (self-reference), lodash (in comment),
    // or "interesting" (prose in a string) as missing
    expect(missing).toBeUndefined();
  });

  it("still detects genuinely missing packages via AST", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");

    const fileContent = `import chalk from "chalk";\nimport { z } from "zod";\n`;
    const file: SourceFile = {
      path: "/test/src/real.ts",
      relativePath: "src/real.ts",
      language: "typescript" as const,
      content: fileContent,
      lineCount: 2,
    };
    file.tree = (await parseFile(file)) ?? undefined;

    const ctx: AnalysisContext = {
      ...BASE,
      files: [file],
      packageJson: { dependencies: { chalk: "^5.0.0" } }, // zod is NOT declared
      totalLines: 2,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));

    // Should detect zod as missing (it's a real import, not in package.json)
    expect(missing).toBeDefined();
    expect(missing!.message).toContain("zod");
    // chalk should NOT be flagged (it's declared)
    expect(missing!.message).not.toContain("chalk");
  });
});
