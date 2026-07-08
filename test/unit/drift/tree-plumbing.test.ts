import { describe, it, expect } from "vitest";
import { buildDriftContext } from "../../../src/drift/index.js";
import type { AnalysisContext } from "../../../src/core/types.js";
import { parseFile } from "../../../src/utils/ast.js";

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
