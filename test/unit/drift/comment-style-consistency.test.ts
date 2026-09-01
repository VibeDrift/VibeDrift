import { describe, it, expect } from "vitest";
import { commentStyleConsistency } from "../../../src/drift/comment-style-consistency.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function makeCtx(files: Partial<DriftFile>[]): DriftContext {
  const fullFiles: DriftFile[] = files.map((f) => ({
    relativePath: f.relativePath ?? "src/test.ts",
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
      relativePath: `src/j${i}.ts`,
      language: "typescript" as const,
      content: `/**\n * A documented function.\n * @returns number\n */\nexport function foo${i}() { return ${i}; }\n`,
    }));
    const lineCommentFiles = Array.from({ length: 3 }, (_, i) => ({
      relativePath: `src/l${i}.ts`,
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

describe("comment-style-consistency: the denominator is the peer group", () => {
  it("scores 6 JSDoc vs 4 line-comment files as 60, not 6", () => {
    // 90 files with no comments at all express no comment-style choice, so they
    // are not deviations from one. Dividing by every analyzed file made this
    // repo score 6/100, which the scoring engine reads as a 94% deviation rate
    // on an axis where exactly 10 files ever voted.
    const files = [
      ...Array.from({ length: 90 }, (_, i) => ({
        relativePath: `src/plain${i}.ts`,
        language: "typescript" as const,
        content: `export function plain${i}() { return ${i}; }\n`,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        relativePath: `src/doc${i}.ts`,
        language: "typescript" as const,
        content: `/**\n * Documented.\n */\nexport function doc${i}() { return ${i}; }\n`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        relativePath: `src/line${i}.ts`,
        language: "typescript" as const,
        content: `// terse\n// aside\nexport function line${i}() { return ${i}; }\n`,
      })),
    ];
    const findings = commentStyleConsistency.detect(makeCtx(files));
    expect(findings).toHaveLength(1);
    expect(findings[0].dominantCount).toBe(6);
    expect(findings[0].totalRelevantFiles).toBe(10);
    expect(findings[0].consistencyScore).toBe(60);
  });

  it("does not read a JS private class field as a hash comment", () => {
    // `#count = 0;` is a private field, not a `#` comment. Counting it could
    // hand a class-heavy file to the `hash_comment` style, inventing a third
    // coexisting style in a codebase that has two.
    const files = [
      ...Array.from({ length: 4 }, (_, i) => ({
        relativePath: `src/klass${i}.ts`,
        language: "typescript" as const,
        content: `export class K${i} {\n  #count = 0;\n  #limit = 10;\n  #seen = new Set();\n  bump() { this.#count++; }\n}\n`,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        relativePath: `src/doc${i}.ts`,
        language: "typescript" as const,
        content: `/**\n * Documented.\n */\nexport function doc${i}() { return ${i}; }\n`,
      })),
    ];
    const findings = commentStyleConsistency.detect(makeCtx(files));
    // The four class files carry no comments at all, so only one style has
    // content and there is nothing to compare it against.
    expect(findings).toHaveLength(0);
  });
});
