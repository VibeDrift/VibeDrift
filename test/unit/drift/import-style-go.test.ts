import { describe, it, expect } from "vitest";
import { goImportClassifier } from "../../../src/drift/import-style/go.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { DriftFile } from "../../../src/drift/types.js";

const go = (path: string, src: string) => fileWithTree(path, src, "go");
// Tree-less DriftFile → forces the regex fallback.
function treeless(path: string, content: string): DriftFile {
  return { relativePath: path, language: "go", content, lineCount: content.split("\n").length };
}

describe("Go import grouping — AST path", () => {
  it("grouped: stdlib and external separated by a blank line", async () => {
    const f = await go("a.go", `package main\n\nimport (\n\t"fmt"\n\n\t"github.com/gin-gonic/gin"\n)\n`);
    const out = goImportClassifier.classify(f);
    expect(out).toHaveLength(1);
    expect(out[0].axis).toBe("go_grouping");
    expect(out[0].pattern).toBe("grouped");
  });

  it("flat: stdlib and external in one block, no blank line", async () => {
    const f = await go("b.go", `package main\n\nimport (\n\t"fmt"\n\t"github.com/gin-gonic/gin"\n)\n`);
    expect(goImportClassifier.classify(f)[0]?.pattern).toBe("flat");
  });

  it("not decidable: single origin (stdlib only) → no classification", async () => {
    const f = await go("c.go", `package main\n\nimport (\n\t"fmt"\n\t"net/http"\n)\n`);
    expect(goImportClassifier.classify(f)).toEqual([]);
  });

  it("not decidable: a single import", async () => {
    const f = await go("d.go", `package main\n\nimport "fmt"\n`);
    expect(goImportClassifier.classify(f)).toEqual([]);
  });
});

describe("Go import grouping — regex fallback (tree-less)", () => {
  it("grouped", () => {
    const f = treeless("a.go", `package main\n\nimport (\n\t"fmt"\n\n\t"github.com/x/y"\n)\n`);
    expect(goImportClassifier.classify(f)[0]?.pattern).toBe("grouped");
  });

  it("flat", () => {
    const f = treeless("b.go", `package main\n\nimport (\n\t"fmt"\n\t"github.com/x/y"\n)\n`);
    expect(goImportClassifier.classify(f)[0]?.pattern).toBe("flat");
  });

  it("single origin (stdlib only) → []", () => {
    const f = treeless("c.go", `package main\n\nimport (\n\t"fmt"\n\t"net/http"\n)\n`);
    expect(goImportClassifier.classify(f)).toEqual([]);
  });
});
