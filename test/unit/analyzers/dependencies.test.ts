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

  it("ignores import-like text in comments and string literals", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/index.ts", relativePath: "index.ts", language: "typescript",
        content: [
          "import express from \"express\";",
          "// import { renderHtmlReport } from \"@vibedrift/cli/render\"",
          "/** `require('lodash')` should not count as an import. */",
          "const prose = 'the shift from \"interesting\" to actionable';",
          "const docs = \"require('pkg') is shown in documentation\";",
          "const pattern = /require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)/g;",
          "const dynamicImportDocs = `await import(\"not-a-real-dep\")`;",
        ].join("\n"),
        lineCount: 7,
      }],
      packageJson: { dependencies: { express: "^4.0.0" } },
      totalLines: 7,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));
    expect(missing).toBeUndefined();
  });

  it("does not report the current package name as a missing dependency", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/index.ts", relativePath: "index.ts", language: "typescript",
        content: 'const tools = await import("@scope/current-package/tools");\n', lineCount: 1,
      }],
      packageJson: { name: "@scope/current-package", dependencies: {} },
      totalLines: 1,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
  });

  it("still detects static require and dynamic import calls", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/index.ts", relativePath: "index.ts", language: "typescript",
        content: [
          'const chalk = require("chalk");',
          'const zod = await import("zod");',
        ].join("\n"),
        lineCount: 2,
      }],
      packageJson: { dependencies: {} },
      totalLines: 2,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));
    expect(missing?.message).toContain("chalk");
    expect(missing?.message).toContain("zod");
  });

  it("keeps bare side-effect imports after other imports", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/index.ts", relativePath: "index.ts", language: "typescript",
        content: [
          'import express from "express";',
          'import "reflect-metadata";',
        ].join("\n"),
        lineCount: 2,
      }],
      packageJson: {
        dependencies: { express: "^4.0.0", "reflect-metadata": "^0.2.2" },
      },
      totalLines: 2,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const phantom = findings.find((f) => f.tags.includes("phantom"));
    expect(phantom).toBeUndefined();
  });

  it("does not let regex quotes or JSX apostrophes hide later imports", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/index.tsx", relativePath: "index.tsx", language: "typescript",
        content: [
          "const re = /['\"]/;",
          'import fsExtra from "fs-extra";',
          "const Note = () => <p>don't forget</p>;",
          'const chalk = require("chalk");',
        ].join("\n"),
        lineCount: 4,
      }],
      packageJson: { dependencies: {} },
      totalLines: 4,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));
    expect(missing?.message).toContain("fs-extra");
    expect(missing?.message).toContain("chalk");
  });

  it("detects literal template dynamic imports without counting docs in templates", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/index.ts", relativePath: "index.ts", language: "typescript",
        content: [
          'const docs = `await import("not-a-real-dep")`;',
          "const zod = await import(`zod`);",
        ].join("\n"),
        lineCount: 2,
      }],
      packageJson: { dependencies: {} },
      totalLines: 2,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));
    expect(missing?.message).toContain("zod");
    expect(missing?.message).not.toContain("not-a-real-dep");
  });
});
