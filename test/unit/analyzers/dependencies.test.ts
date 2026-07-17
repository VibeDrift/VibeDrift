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

  it("keeps bare side-effect imports after other imports via AST", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");

    const fileContent = [
      'import express from "express";',
      'import "reflect-metadata";',
    ].join("\n");
    const file: SourceFile = {
      path: "/test/src/index.ts",
      relativePath: "src/index.ts",
      language: "typescript" as const,
      content: fileContent,
      lineCount: 2,
    };
    file.tree = (await parseFile(file)) ?? undefined;
    expect(file.tree).toBeDefined();

    const ctx: AnalysisContext = {
      ...BASE,
      files: [file],
      packageJson: {
        dependencies: { express: "^4.0.0", "reflect-metadata": "^0.2.2" },
      },
      totalLines: 2,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const phantom = findings.find((f) => f.tags.includes("phantom"));
    expect(phantom).toBeUndefined();
  });

  it("does not let regex quotes or JSX apostrophes hide later imports via AST", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");

    const fileContent = [
      "const re = /['\"]/;",
      'import fsExtra from "fs-extra";',
      "const Note = () => <p>don't forget</p>;",
      'const chalk = require("chalk");',
    ].join("\n");
    const file: SourceFile = {
      path: "/test/src/index.tsx",
      relativePath: "src/index.tsx",
      language: "typescript" as const,
      content: fileContent,
      lineCount: 4,
    };
    file.tree = (await parseFile(file)) ?? undefined;
    expect(file.tree).toBeDefined();

    const ctx: AnalysisContext = {
      ...BASE,
      files: [file],
      packageJson: { dependencies: {} },
      totalLines: 4,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));
    expect(missing?.message).toContain("fs-extra");
    expect(missing?.message).toContain("chalk");
  });

  it("Go: does not flag imports declared in a NESTED module's go.mod (chi _examples case)", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "github.com/go-chi/chi/v5",
        require: [],
        hasNestedModule: true,
        nestedModules: [{
          dir: "_examples/rest",
          module: "github.com/go-chi/chi/_examples/rest",
          require: [
            { path: "github.com/go-chi/docgen", version: "v1.2.0" },
            { path: "github.com/go-chi/render", version: "v1.0.1" },
          ],
        }],
      },
      files: [
        {
          path: "/test/mux.go", relativePath: "mux.go", language: "go",
          content: 'package chi\n\nimport (\n\t"net/http"\n)\n', lineCount: 5,
        },
        {
          path: "/test/_examples/rest/main.go", relativePath: "_examples/rest/main.go", language: "go",
          content: 'package main\n\nimport (\n\t"github.com/go-chi/chi/v5"\n\t"github.com/go-chi/docgen"\n\t"github.com/go-chi/render"\n)\n',
          lineCount: 7,
        },
      ],
      totalLines: 12,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
  });

  it("Go: matches multi-segment declared module paths by prefix (terraform go-azure-sdk case)", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/backend",
        require: [
          { path: "github.com/hashicorp/go-azure-sdk/resource-manager", version: "v0.20250131.1134653" },
          { path: "github.com/hashicorp/go-azure-sdk/sdk", version: "v0.20250131.1134653" },
        ],
      },
      files: [{
        path: "/test/api_client.go", relativePath: "api_client.go", language: "go",
        content: 'package azure\n\nimport (\n\t"github.com/hashicorp/go-azure-sdk/resource-manager/storage/accounts"\n\t"github.com/hashicorp/go-azure-sdk/sdk/auth"\n)\n',
        lineCount: 6,
      }],
      totalLines: 6,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
    expect(findings.find((f) => f.tags.includes("phantom"))).toBeUndefined();
  });

  it("Go: matches /vN major-version module paths by prefix", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/app",
        require: [{ path: "github.com/golang-jwt/jwt/v5", version: "v5.2.0" }],
      },
      files: [{
        path: "/test/auth.go", relativePath: "auth.go", language: "go",
        content: 'package app\n\nimport "github.com/golang-jwt/jwt/v5/request"\n', lineCount: 3,
      }],
      totalLines: 3,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
    expect(findings.find((f) => f.tags.includes("phantom"))).toBeUndefined();
  });

  it("Go: a module nested inside another module wins for its own files (deepest ancestor)", async () => {
    // root at "", nested at "a", deeper nested at "a/b". Each file must resolve
    // to its NEAREST enclosing module, and each module's own import is declared,
    // so nothing is missing.
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/root",
        require: [{ path: "github.com/root/dep", version: "v1.0.0" }],
        hasNestedModule: true,
        nestedModules: [
          { dir: "a", module: "example.com/a", require: [{ path: "github.com/a/dep", version: "v1.0.0" }] },
          { dir: "a/b", module: "example.com/a/b", require: [{ path: "github.com/b/dep", version: "v1.0.0" }] },
        ],
      },
      files: [
        {
          path: "/test/main.go", relativePath: "main.go", language: "go",
          content: 'package main\n\nimport "github.com/root/dep"\n', lineCount: 3,
        },
        {
          path: "/test/a/svc.go", relativePath: "a/svc.go", language: "go",
          content: 'package a\n\nimport "github.com/a/dep"\n', lineCount: 3,
        },
        {
          path: "/test/a/b/deep.go", relativePath: "a/b/deep.go", language: "go",
          content: 'package b\n\nimport "github.com/b/dep"\n', lineCount: 3,
        },
      ],
      totalLines: 9,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    // Every import resolves against its own module — no missing, no phantom.
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
    expect(findings.find((f) => f.tags.includes("phantom"))).toBeUndefined();
  });

  it("Go: a file under a module nested in an OPAQUE module is skipped (deepest opaque wins)", async () => {
    // "a" is unparseable (opaque); "a/b" parses. A file at a/b/x.go belongs to
    // the parsed a/b module (deeper than the opaque "a") and is analyzed; a file
    // directly under the opaque "a" is skipped, not blamed on root.
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/root",
        require: [],
        hasNestedModule: true,
        opaqueModuleDirs: ["a"],
        nestedModules: [
          { dir: "a/b", module: "example.com/a/b", require: [{ path: "github.com/b/dep", version: "v1.0.0" }] },
        ],
      },
      files: [
        {
          path: "/test/a/legacy.go", relativePath: "a/legacy.go", language: "go",
          content: 'package a\n\nimport "github.com/opaque/thing"\n', lineCount: 3,
        },
        {
          path: "/test/a/b/ok.go", relativePath: "a/b/ok.go", language: "go",
          content: 'package b\n\nimport "github.com/b/dep"\n', lineCount: 3,
        },
      ],
      totalLines: 6,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    // a/legacy.go excluded (opaque); a/b/ok.go's import is declared in a/b.
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
    expect(findings.find((f) => f.tags.includes("phantom"))).toBeUndefined();
  });

  it("Go: still flags a genuinely undeclared import inside a nested module, at that module's go.mod", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/app",
        require: [],
        hasNestedModule: true,
        nestedModules: [{ dir: "tools", module: "example.com/app/tools", require: [] }],
      },
      files: [{
        path: "/test/tools/gen.go", relativePath: "tools/gen.go", language: "go",
        content: 'package main\n\nimport "github.com/spf13/cobra"\n', lineCount: 3,
      }],
      totalLines: 3,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));
    expect(missing).toBeDefined();
    expect(missing!.message).toContain("github.com/spf13/cobra");
    expect(missing!.locations).toEqual([{ file: "tools/go.mod" }]);
  });

  it("Go: imports of a sibling in-repo module are never missing", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/app",
        require: [],
        hasNestedModule: true,
        nestedModules: [{ dir: "services/auth", module: "example.com/auth", require: [] }],
      },
      files: [{
        path: "/test/main.go", relativePath: "main.go", language: "go",
        content: 'package main\n\nimport "example.com/auth/tokens"\n', lineCount: 3,
      }],
      totalLines: 3,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
  });

  it("Go: phantom accounting is per module — a root dep used only by a nested module's files is unused at root", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/app",
        require: [{ path: "github.com/pkg/errors", version: "v0.9.1" }],
        hasNestedModule: true,
        nestedModules: [{
          dir: "tools",
          module: "example.com/app/tools",
          require: [{ path: "github.com/pkg/errors", version: "v0.9.1" }],
        }],
      },
      files: [
        {
          path: "/test/main.go", relativePath: "main.go", language: "go",
          content: 'package main\n\nimport "fmt"\n', lineCount: 3,
        },
        {
          path: "/test/tools/gen.go", relativePath: "tools/gen.go", language: "go",
          content: 'package main\n\nimport "github.com/pkg/errors"\n', lineCount: 3,
        },
      ],
      totalLines: 6,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const phantom = findings.find((f) => f.tags.includes("phantom"));
    expect(phantom).toBeDefined();
    expect(phantom!.message).toContain("1 potentially unused");
    expect(phantom!.locations).toEqual([{ file: "go.mod" }]);
  });

  it("Go: `// indirect` requires are never flagged as unused, but still satisfy imports", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/app",
        require: [
          { path: "github.com/gorilla/mux", version: "v1.8.0" },
          { path: "github.com/ajg/form", version: "v1.5.1", indirect: true },
        ],
      },
      files: [{
        path: "/test/main.go", relativePath: "main.go", language: "go",
        content: 'package main\n\nimport "github.com/gorilla/mux"\n', lineCount: 3,
      }],
      totalLines: 3,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    // ajg/form is unused but marked indirect — not a phantom.
    expect(findings.find((f) => f.tags.includes("phantom"))).toBeUndefined();
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
  });

  it("Go: a nested module whose .go files were filtered out (gitignore/cap) is NOT phantom-flagged", async () => {
    // The nested-go.mod walk ignores .gitignore and the file-count cap, so a
    // nested module can exist with none of its files in ctx.files. Its declared
    // deps must not all be reported as unused.
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "github.com/org/root",
        require: [{ path: "github.com/root/dep", version: "v1.0.0" }],
        hasNestedModule: true,
        nestedModules: [{
          dir: "sandbox",
          module: "github.com/org/sandbox",
          require: [{ path: "github.com/only/here", version: "v1.0.0" }],
        }],
      },
      files: [{
        path: "/test/main.go", relativePath: "main.go", language: "go",
        content: 'package main\n\nimport "github.com/root/dep"\n', lineCount: 3,
      }],
      // note: no file under sandbox/ (filtered out) — sandbox scope is empty
      totalLines: 3,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("phantom"))).toBeUndefined();
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
  });

  it("Go: files under an UNPARSEABLE nested go.mod are excluded, not blamed on root", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/app",
        require: [],
        hasNestedModule: true,
        opaqueModuleDirs: ["legacy"],
      },
      files: [{
        path: "/test/legacy/old.go", relativePath: "legacy/old.go", language: "go",
        content: 'package legacy\n\nimport "github.com/some/thirdparty"\n', lineCount: 3,
      }],
      totalLines: 3,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    // thirdparty belongs to the unparseable module, not root — no false missing.
    expect(findings.find((f) => f.tags.includes("missing"))).toBeUndefined();
  });

  it("Go: single-module repos keep the existing behavior (declared used dep clean, undeclared flagged)", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      packageJson: null,
      goMod: {
        module: "example.com/app",
        require: [{ path: "github.com/gorilla/mux", version: "v1.8.0" }],
      },
      files: [{
        path: "/test/main.go", relativePath: "main.go", language: "go",
        content: 'package main\n\nimport (\n\t"fmt"\n\t"github.com/gorilla/mux"\n\t"github.com/stretchr/testify/assert"\n)\n',
        lineCount: 7,
      }],
      totalLines: 7,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));
    expect(missing).toBeDefined();
    expect(missing!.message).toContain("github.com/stretchr/testify");
    expect(missing!.message).not.toContain("gorilla");
    expect(findings.find((f) => f.tags.includes("phantom"))).toBeUndefined();
  });

  it("detects literal template dynamic imports without counting docs in templates", async () => {
    const { parseFile } = await import("../../../src/utils/ast.js");

    const fileContent = [
      'const docs = `await import("not-a-real-dep")`;',
      "const zod = await import(`zod`);",
    ].join("\n");
    const file: SourceFile = {
      path: "/test/src/index.ts",
      relativePath: "src/index.ts",
      language: "typescript" as const,
      content: fileContent,
      lineCount: 2,
    };
    file.tree = (await parseFile(file)) ?? undefined;
    expect(file.tree).toBeDefined();

    const ctx: AnalysisContext = {
      ...BASE,
      files: [file],
      packageJson: { dependencies: {} },
      totalLines: 2,
    };
    const findings = await dependenciesAnalyzer.analyze(ctx);
    const missing = findings.find((f) => f.tags.includes("missing"));
    expect(missing?.message).toContain("zod");
    expect(missing?.message).not.toContain("not-a-real-dep");
  });
});
