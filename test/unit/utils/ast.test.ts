import { describe, it, expect } from "vitest";
import { parseFile, parseFiles, disposeTrees } from "../../../src/utils/ast.js";
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

  // Regression guard for the WASM Parser leak: parseFile now deletes its
  // internal Parser in a finally block once it has produced a Tree. The
  // Tree it hands back must stay fully usable afterward — Parser.delete()
  // must not invalidate Trees it already produced.
  it("returns a still-usable tree after the internal Parser is deleted", async () => {
    const tree = await parseFile(src("typescript", "const x = 1;"));
    expect(tree).not.toBeNull();
    // If parser.delete() had corrupted the tree, this would throw or
    // return garbage instead of the real root node.
    expect(tree!.rootNode.type).toBe("program");
    expect(tree!.rootNode.text).toContain("const x = 1;");
  });

  it("parseFile does not throw when called many times in a row (no parser exhaustion)", async () => {
    for (let i = 0; i < 25; i++) {
      const tree = await parseFile(src("javascript", `const n = ${i};`));
      expect(tree).not.toBeNull();
    }
  });
});

describe("disposeTrees", () => {
  it("clears file.tree after parseFiles populated it", async () => {
    const files: SourceFile[] = [src("typescript", "const a = 1;"), src("python", "a = 1")];
    await parseFiles(files);
    expect(files[0]!.tree).toBeDefined();
    expect(files[1]!.tree).toBeDefined();

    disposeTrees(files);

    expect(files[0]!.tree).toBeUndefined();
    expect(files[1]!.tree).toBeUndefined();
  });

  it("is a no-op for files with no tree (unsupported language / parse failure)", () => {
    const files: SourceFile[] = [src(null, "x")];
    expect(() => disposeTrees(files)).not.toThrow();
    expect(files[0]!.tree).toBeUndefined();
  });

  it("is idempotent — calling it twice does not throw", async () => {
    const files: SourceFile[] = [src("go", "package main")];
    await parseFiles(files);
    disposeTrees(files);
    expect(() => disposeTrees(files)).not.toThrow();
  });
});
