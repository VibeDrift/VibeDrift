import { describe, it, expect } from "vitest";
import { commentStyleConsistency } from "../../../src/drift/comment-style-consistency.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function makeCtx(files: Partial<DriftFile>[]): DriftContext {
  const fullFiles: DriftFile[] = files.map((f) => ({
    path: f.path ?? "src/test.ts",
    language: f.language ?? "typescript",
    content: f.content ?? "",
    lineCount: (f.content ?? "").split("\n").length,
  }));
  return {
    files: fullFiles,
    totalLines: fullFiles.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

describe("comment-style-consistency detector", () => {
  it("emits an info finding when JSDoc and plain // coexist across many files", () => {
    const jsdocFiles = Array.from({ length: 4 }, (_, i) => ({
      path: `src/j${i}.ts`,
      language: "typescript" as const,
      content: `/**\n * A documented function.\n * @returns number\n */\nexport function foo${i}() { return ${i}; }\n`,
    }));
    const lineCommentFiles = Array.from({ length: 3 }, (_, i) => ({
      path: `src/l${i}.ts`,
      language: "typescript" as const,
      content: `// does the thing\n// keep going\n// seriously\nexport function bar${i}() { return ${i}; }\n`,
    }));
    const ctx = makeCtx([...jsdocFiles, ...lineCommentFiles]);
    const findings = commentStyleConsistency.detect(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
  });

  it("returns nothing when every JS/TS file has the same comment style", () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `src/f${i}.ts`,
      language: "typescript" as const,
      content: `// simple file\nexport const x = ${i};\n`,
    }));
    const ctx = makeCtx(files);
    expect(commentStyleConsistency.detect(ctx)).toHaveLength(0);
  });
});
