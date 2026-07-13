import { describe, it, expect } from "vitest";
import { parseFile } from "../../../src/utils/ast.js";
import type { SourceFile } from "../../../src/core/types.js";

function src(language: SourceFile["language"], content: string): SourceFile {
  return { path: "a", relativePath: "a", language, content, lineCount: content.split("\n").length };
}

describe("parseFile (tree-sitter grammar loading)", () => {
  // Regression guard for the broken AST loader: web-tree-sitter 0.26 could not
  // load tree-sitter-wasms grammars (dylink ABI mismatch, tree-sitter #5171) and
  // the package main was broken, so parseFile silently returned null everywhere
  // and every "AST" analyzer degraded to regex. This asserts a real tree loads.
  it("returns a real parse tree for TypeScript", async () => {
    const tree = await parseFile(src("typescript", 'router.post("/x", requireAuth, h);'));
    expect(tree).not.toBeNull();
    const calls = tree!.rootNode.descendantsOfType("call_expression");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.childForFieldName("function")?.text).toBe("router.post");
  });

  it("loads every supported grammar without a dylink error", async () => {
    for (const lang of ["javascript", "typescript", "python", "go", "rust"] as const) {
      const tree = await parseFile(src(lang, "x = 1\n"));
      expect(tree, `grammar for ${lang} should load`).not.toBeNull();
    }
  });

  it("returns null for an unsupported/absent language", async () => {
    expect(await parseFile(src(null, "x"))).toBeNull();
  });
});
