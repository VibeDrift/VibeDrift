import { describe, it, expect } from "vitest";
import { jsImportClassifier } from "../../../src/drift/import-style/js.js";
import type { DriftFile } from "../../../src/drift/types.js";

const js = (path: string, content: string): DriftFile => ({
  relativePath: path,
  language: "javascript",
  content,
  lineCount: content.split("\n").length,
});

describe("JS/TS import path style (path_style)", () => {
  it("ES modules: relative imports classify as relative", () => {
    const f = js("src/a.ts", `import a from "./a";\nimport b from "./b";\nimport c from "./c";\n`);
    expect(jsImportClassifier.classify(f)[0]?.pattern).toBe("relative");
  });

  it("ES modules: alias imports classify as alias", () => {
    const f = js("src/a.ts", `import a from "@/a";\nimport b from "@/b";\nimport c from "@/c";\n`);
    expect(jsImportClassifier.classify(f)[0]?.pattern).toBe("alias");
  });

  it("CommonJS: require() relative specifiers are counted", () => {
    const f = js("src/a.js", `const a = require("./a");\nconst b = require("./b");\nconst c = require("./c");\n`);
    expect(jsImportClassifier.classify(f)[0]?.pattern).toBe("relative");
  });

  it("CommonJS: require() alias specifiers classify as alias", () => {
    const f = js("src/a.js", `const a = require("@/a");\nconst b = require("@/b");\nconst c = require("@/c");\n`);
    expect(jsImportClassifier.classify(f)[0]?.pattern).toBe("alias");
  });

  it("external / bare specifiers are ignored (no local path-style choice)", () => {
    const f = js("src/a.js", `const e = require("express");\nconst r = require("react");\nconst l = require("lodash");\n`);
    expect(jsImportClassifier.classify(f)).toEqual([]);
  });

  it("comment lines are skipped (2 commented + 1 real require = below threshold)", () => {
    // If comments were counted, this would be 3 relative → a finding; skipping them leaves 1 → none.
    const f = js("src/a.js", `// const a = require("./a");\n// const b = require("./b");\nconst c = require("./c");\n`);
    expect(jsImportClassifier.classify(f)).toEqual([]);
  });
});
