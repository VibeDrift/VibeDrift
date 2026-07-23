import { describe, it, expect } from "vitest";
import { goImportClassifier } from "../../../src/drift/import-style/go.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { AxisClassification } from "../../../src/drift/import-style/types.js";
import type { DriftFile } from "../../../src/drift/types.js";

const go = (path: string, src: string) => fileWithTree(path, src, "go");
// Tree-less DriftFile → forces the regex fallback.
function treeless(path: string, content: string): DriftFile {
  return { relativePath: path, language: "go", content, lineCount: content.split("\n").length };
}
const axis = (out: AxisClassification[], a: string) => out.filter((c) => c.axis === a);

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

describe("Go import ordering (go_ordering)", () => {
  it("ordered: a single group in byte-ascending order", async () => {
    const f = await go("a.go", `package main\n\nimport (\n\t"bytes"\n\t"fmt"\n\t"net/http"\n)\n`);
    expect(axis(goImportClassifier.classify(f), "go_ordering")[0]?.pattern).toBe("ordered");
  });

  it("unordered: out-of-order within the group", async () => {
    const f = await go("b.go", `package main\n\nimport (\n\t"net/http"\n\t"bytes"\n\t"fmt"\n)\n`);
    expect(axis(goImportClassifier.classify(f), "go_ordering")[0]?.pattern).toBe("unordered");
  });

  it("ordered: sorted within each blank-line group (not judged across groups)", async () => {
    const f = await go("c.go", `package main\n\nimport (\n\t"bytes"\n\t"fmt"\n\n\t"github.com/a/b"\n\t"github.com/x/y"\n)\n`);
    expect(axis(goImportClassifier.classify(f), "go_ordering")[0]?.pattern).toBe("ordered");
  });

  it("not decidable: fewer than 3 imports", async () => {
    const f = await go("d.go", `package main\n\nimport (\n\t"fmt"\n\t"bytes"\n)\n`);
    expect(axis(goImportClassifier.classify(f), "go_ordering")).toEqual([]);
  });

  it("regex fallback: unordered", () => {
    const f = treeless("e.go", `package main\n\nimport (\n\t"net/http"\n\t"bytes"\n\t"fmt"\n)\n`);
    expect(axis(goImportClassifier.classify(f), "go_ordering")[0]?.pattern).toBe("unordered");
  });
});

describe("Go multiple import blocks", () => {
  // Two separate `import ( … )` blocks in one file (legal Go; codegen/merges).
  it("AST: reads all blocks — a stdlib block + an external block classify as grouped", async () => {
    const f = await go("multi.go", `package main\n\nimport (\n\t"fmt"\n\t"net/http"\n)\n\nimport (\n\t"github.com/a/b"\n)\n`);
    // grouping needs >=2 origins; block #1 alone is stdlib-only, so this only
    // reaches "grouped" if the second (external) block is also read.
    expect(axis(goImportClassifier.classify(f), "go_grouping")[0]?.pattern).toBe("grouped");
  });

  it("AST: checks ordering within a later block, not just the first", async () => {
    // Block #1 sorted; block #2 out of order (z before a).
    const f = await go("multi2.go", `package main\n\nimport (\n\t"fmt"\n)\n\nimport (\n\t"github.com/z/z"\n\t"github.com/a/a"\n)\n`);
    expect(axis(goImportClassifier.classify(f), "go_ordering")[0]?.pattern).toBe("unordered");
  });

  it("regex fallback: reads all blocks too", () => {
    const f = treeless("multi.go", `package main\n\nimport (\n\t"fmt"\n)\n\nimport (\n\t"github.com/a/b"\n)\n`);
    expect(axis(goImportClassifier.classify(f), "go_grouping")[0]?.pattern).toBe("grouped");
  });
});
