import { describe, it, expect } from "vitest";
import { countReimplementationCandidates } from "../../../src/output/tease.js";
import type { ExtractedFunction } from "../../../src/codedna/types.js";

function mkFn(p: Partial<ExtractedFunction>): ExtractedFunction {
  return {
    name: "fn",
    file: "/abs/x.ts",
    relativePath: "src/x.ts",
    line: 1,
    language: "typescript",
    params: [],
    paramCount: 0,
    rawBody: "return compute(a, b)",
    declarationCode: "",
    domainCategory: "general",
    bodyTokens: [],
    bodyTokenCount: 20,
    bodyHash: 0,
    ...p,
  };
}

describe("countReimplementationCandidates", () => {
  it("counts a name appearing in 2+ shipped files once", () => {
    expect(countReimplementationCandidates([
      mkFn({ name: "sendMessage", relativePath: "src/a.ts" }),
      mkFn({ name: "sendMessage", relativePath: "src/b.ts" }),
    ])).toBe(1);
  });

  it("does not count a name confined to one file", () => {
    expect(countReimplementationCandidates([
      mkFn({ name: "sendMessage", relativePath: "src/a.ts" }),
      mkFn({ name: "sendMessage", relativePath: "src/a.ts" }),
    ])).toBe(0);
  });

  it("excludes test/example paths (non-shipped)", () => {
    expect(countReimplementationCandidates([
      mkFn({ name: "sendMessage", relativePath: "test/a.test.ts" }),
      mkFn({ name: "sendMessage", relativePath: "src/b.ts" }),
    ])).toBe(0); // only one shipped occurrence remains
  });

  it("excludes generic names, short names, and trivial bodies", () => {
    expect(countReimplementationCandidates([
      mkFn({ name: "handle", relativePath: "src/a.ts" }),
      mkFn({ name: "handle", relativePath: "src/b.ts" }),
      mkFn({ name: "go", relativePath: "src/c.ts" }),
      mkFn({ name: "go", relativePath: "src/d.ts" }),
      mkFn({ name: "tinyHelper", relativePath: "src/e.ts", bodyTokenCount: 3 }),
      mkFn({ name: "tinyHelper", relativePath: "src/f.ts", bodyTokenCount: 3 }),
    ])).toBe(0);
  });

  it("counts multiple distinct reimplemented names", () => {
    expect(countReimplementationCandidates([
      mkFn({ name: "sendMessage", relativePath: "src/a.ts" }),
      mkFn({ name: "sendMessage", relativePath: "src/b.ts" }),
      mkFn({ name: "formatDate", relativePath: "src/a.ts" }),
      mkFn({ name: "formatDate", relativePath: "src/c.ts" }),
    ])).toBe(2);
  });
});
