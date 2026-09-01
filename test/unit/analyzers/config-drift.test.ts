import { describe, it, expect } from "vitest";
import { configDriftAnalyzer } from "../../../src/analyzers/config-drift.js";
import type { AnalysisContext } from "../../../src/core/types.js";

const BASE: Omit<AnalysisContext, "files" | "envExample" | "totalLines"> = {
  rootDir: "/test",
  packageJson: null,
  goMod: null,
  cargoToml: null,
  requirementsTxt: null,
  languageBreakdown: new Map(),
  dominantLanguage: null,
};

describe("config-drift analyzer", () => {
  it("flags env vars missing from .env.example", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/app.ts", relativePath: "app.ts", language: "typescript",
        content: 'const url = process.env.DATABASE_URL;\nconst key = process.env.SECRET_KEY;\n',
        lineCount: 2,
      }],
      envExample: new Map([["DATABASE_URL", ""]]),
      totalLines: 2,
    };
    const findings = await configDriftAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.message.includes("SECRET_KEY"))).toBeDefined();
  });

  it("returns empty when all vars documented", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/app.ts", relativePath: "app.ts", language: "typescript",
        content: "const url = process.env.DATABASE_URL;\n",
        lineCount: 1,
      }],
      envExample: new Map([["DATABASE_URL", ""]]),
      totalLines: 1,
    };
    const findings = await configDriftAnalyzer.analyze(ctx);
    expect(findings).toEqual([]);
  });

  it("flags .env.example keys that are never referenced in code (B4 reverse direction)", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/app.ts", relativePath: "app.ts", language: "typescript",
        content: "const url = process.env.DATABASE_URL;\n",
        lineCount: 1,
      }],
      // STALE_VAR is declared but never read — should be flagged info-level.
      envExample: new Map([["DATABASE_URL", ""], ["STALE_VAR", ""]]),
      totalLines: 1,
    };
    const findings = await configDriftAnalyzer.analyze(ctx);
    const reverse = findings.find((f) => f.tags.includes("unused-declaration"));
    expect(reverse).toBeDefined();
    expect(reverse?.message).toContain("STALE_VAR");
  });

  it("detects bracket-subscript env var access (regression: process.env[\"KEY\"] / os.environ[\"KEY\"] were missed)", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [
        {
          path: "/test/app.ts", relativePath: "app.ts", language: "typescript",
          content: 'const a = process.env["DATABASE_URL"];\nconst b = process.env[\'SECRET_KEY\'];\nconst c = importMeta();\n',
          lineCount: 3,
        },
        {
          path: "/test/app.py", relativePath: "app.py", language: "python",
          content: 'import os\nvalue = os.environ["API_TOKEN"]\n',
          lineCount: 2,
        },
      ],
      // Only DATABASE_URL documented — SECRET_KEY (bracket, TS) and
      // API_TOKEN (bracket, Python) should both be flagged as undocumented,
      // which only happens if they were detected as env usages at all.
      envExample: new Map([["DATABASE_URL", ""]]),
      totalLines: 5,
    };
    const findings = await configDriftAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.message.includes("SECRET_KEY"))).toBeDefined();
    expect(findings.find((f) => f.message.includes("API_TOKEN"))).toBeDefined();
  });
});
