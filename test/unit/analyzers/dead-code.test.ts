import { describe, it, expect } from "vitest";
import { deadCodeAnalyzer } from "../../../src/analyzers/dead-code.js";
import type { AnalysisContext, SourceFile } from "../../../src/core/types.js";

function makeCtx(files: Partial<SourceFile>[]): AnalysisContext {
  const fullFiles = files.map((f) => ({
    path: f.path ?? "/test/" + f.relativePath,
    relativePath: f.relativePath ?? "test.ts",
    language: f.language ?? "typescript" as const,
    content: f.content ?? "",
    lineCount: (f.content ?? "").split("\n").length,
  }));
  return {
    rootDir: "/test",
    files: fullFiles,
    packageJson: null,
    goMod: null,
    cargoToml: null,
    requirementsTxt: null,
    envExample: null,
    totalLines: fullFiles.reduce((s, f) => s + f.lineCount, 0),
    languageBreakdown: new Map(),
    dominantLanguage: "typescript",
  };
}

describe("dead-code analyzer (import-graph reachability)", () => {
  it("flags a file that no other file imports (A2 file-level)", async () => {
    const ctx = makeCtx([
      { relativePath: "src/index.ts", content: `import { greet } from './utils';\ngreet("hello");\n` },
      { relativePath: "src/utils.ts", content: `export function greet(s: string) { return s; }\n` },
      // orphan.ts is never imported.
      { relativePath: "src/orphan.ts", content: `export function dust() { return 1; }\nexport const lost = 42;\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    const orphan = findings.find((f) => f.tags.includes("orphan-file"));
    expect(orphan).toBeDefined();
    expect(orphan?.locations.some((l) => l.file.includes("orphan.ts"))).toBe(true);
  });

  it("does NOT flag entry-point files even with zero imports", async () => {
    const ctx = makeCtx([
      { relativePath: "src/index.ts", content: `export function main() { return 1; }\n` },
      { relativePath: "src/main.ts", content: `export function other() { return 2; }\n` },
      { relativePath: "src/app.config.ts", content: `export const config = { x: 1 };\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    const orphan = findings.find((f) => f.tags.includes("orphan-file"));
    // All files are entry-point-ish; no orphan finding expected.
    expect(orphan).toBeUndefined();
  });

  it("does NOT flag an export used only via a type-only import as unused", async () => {
    // Build enough genuinely-dead exports so the deadExports finding fires
    // (threshold is > 3), then assert the type-only-imported symbol is absent.
    const ctx = makeCtx([
      {
        relativePath: "src/worker-pool.ts",
        content: `import type { WorkerRequest } from './analysis-worker';\nfunction send(r: WorkerRequest) { return r; }\nexport function pool() { return send; }\n`,
      },
      {
        relativePath: "src/analysis-worker.ts",
        content: `export type WorkerRequest = { id: number };\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n`,
      },
      { relativePath: "src/index.ts", content: `import { pool } from './worker-pool';\npool();\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    const unused = findings.find((f) => f.tags.includes("unused-export"));
    expect(unused).toBeDefined();
    // WorkerRequest is imported (type-only) so it must NOT appear in the unused list.
    const names = unused?.locations.map((l) => l.snippet) ?? [];
    expect(names.some((s) => s?.includes("WorkerRequest"))).toBe(false);
  });

  it("does NOT flag a *.worker.ts entry file as orphan even with zero imports", async () => {
    const ctx = makeCtx([
      { relativePath: "src/index.ts", content: `import { greet } from './utils';\ngreet("x");\n` },
      { relativePath: "src/utils.ts", content: `export function greet(s: string) { return s; }\n` },
      // analysis-worker is a webpack/web-worker entry: no static importers by design.
      { relativePath: "src/audio/analysis-worker.worker.ts", content: `self.onmessage = () => {};\nexport type WorkerRequest = { id: number };\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    const orphan = findings.find((f) => f.tags.includes("orphan-file"));
    if (orphan) {
      expect(orphan.locations.some((l) => l.file.includes("analysis-worker.worker.ts"))).toBe(false);
    }
  });

  it("does NOT flag a file loaded via runtime.getURL(...) as orphan", async () => {
    const ctx = makeCtx([
      {
        relativePath: "src/worker-pool.ts",
        content: `const url = browserApi.runtime.getURL('background/analysis-worker.js');\nexport function pool() { return new Worker(url); }\n`,
      },
      { relativePath: "src/index.ts", content: `import { pool } from './worker-pool';\npool();\n` },
      // analysis-worker.ts is referenced only via getURL string → not orphan.
      { relativePath: "src/background/audio/analysis-worker.ts", content: `self.onmessage = () => {};\nexport const handler = 1;\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    const orphan = findings.find((f) => f.tags.includes("orphan-file"));
    if (orphan) {
      expect(orphan.locations.some((l) => l.file.includes("analysis-worker.ts"))).toBe(false);
    }
  });

  it("has a monotonically-bumped version so the findings cache invalidates", () => {
    expect(deadCodeAnalyzer.version).toBeGreaterThanOrEqual(2);
  });
});

// Regression for the bandcamp deep-scan gate.
describe("dead-code precision (audit fixes)", () => {
  it("does not flag an export that is used within its own file (same-file type usage)", async () => {
    const ctx = makeCtx([
      { relativePath: "src/index.ts", content: `import { run } from './worker';\nrun();\n` },
      {
        relativePath: "src/worker.ts",
        content:
          `export interface WorkerResult { ok: boolean; }\n` +
          `function build(): WorkerResult { return { ok: true }; }\n` +
          `export function run(): WorkerResult { return build(); }\n` +
          // genuinely-dead exports to cross the >3 threshold
          `export const A1 = 1;\nexport const A2 = 2;\nexport const A3 = 3;\nexport const A4 = 4;\n`,
      },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    const unused = findings.find((f) => f.tags.includes("unused-export"));
    expect(unused).toBeDefined();
    // WorkerResult is used same-file (two return-type positions) — must not be "unused".
    expect(unused!.message).not.toContain("WorkerResult");
    // ...but the genuinely-unused exports are still reported.
    expect(unused!.message).toContain("A1");
  });

  it("does not count a multi-line return object literal as unreachable code", async () => {
    const ctx = makeCtx([
      { relativePath: "src/a.ts", content: `function make() {\n  return {\n    a: 1,\n    b: 2,\n  };\n}\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("unreachable"))).toBeUndefined();
  });

  it("does not count a multi-line operator/ternary return as unreachable", async () => {
    const ctx = makeCtx([
      { relativePath: "src/c.ts", content: `function g() {\n  return a &&\n    b &&\n    c;\n}\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("unreachable"))).toBeUndefined();
  });

  it("still flags genuinely unreachable code after a complete return", async () => {
    const ctx = makeCtx([
      { relativePath: "src/b.ts", content: `function f() {\n  return 1;\n  doStuff();\n}\n` },
    ]);
    const findings = await deadCodeAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("unreachable"))).toBeDefined();
  });
});
