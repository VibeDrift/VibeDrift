import { describe, it, expect } from "vitest";
import { pythonImportClassifier } from "../../../src/drift/import-style/python.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { AxisClassification } from "../../../src/drift/import-style/types.js";
import type { DriftFile } from "../../../src/drift/types.js";

const py = (path: string, src: string) => fileWithTree(path, src, "python");
function treeless(path: string, content: string): DriftFile {
  return { relativePath: path, language: "python", content, lineCount: content.split("\n").length };
}
const axis = (out: AxisClassification[], a: string) => out.filter((c) => c.axis === a);

describe("Python path style (py_path_style) — AST path", () => {
  it("relative: ≥2 leading-dot imports", async () => {
    const f = await py("myapp/routes/users.py", `from .models import User\nfrom ..db import session\n`);
    const out = axis(pythonImportClassifier.classify(f), "py_path_style");
    expect(out).toHaveLength(1);
    expect(out[0].pattern).toBe("relative");
  });

  it("absolute: ≥2 intra-package absolute imports (first segment matches a path dir)", async () => {
    const f = await py("myapp/routes/users.py", `from myapp.models import User\nfrom myapp.db import session\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_path_style")[0]?.pattern).toBe("absolute");
  });

  it("majority wins when mixed", async () => {
    const f = await py("myapp/routes/users.py", `from .models import User\nfrom .db import session\nfrom myapp.util import x\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_path_style")[0]?.pattern).toBe("relative");
  });

  it("not decidable: only third-party / stdlib imports", async () => {
    const f = await py("myapp/routes/users.py", `from os import path\nimport sys\nfrom typing import List\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_path_style")).toEqual([]);
  });

  it("not decidable: a single local import", async () => {
    const f = await py("myapp/routes/users.py", `from .models import User\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_path_style")).toEqual([]);
  });
});

describe("Python path style — regex fallback (tree-less)", () => {
  it("relative", () => {
    const f = treeless("myapp/routes/users.py", `from .models import User\nfrom . import db\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_path_style")[0]?.pattern).toBe("relative");
  });
  it("absolute (intra-package)", () => {
    const f = treeless("myapp/routes/users.py", `from myapp.models import User\nfrom myapp.db import session\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_path_style")[0]?.pattern).toBe("absolute");
  });
});

describe("Python wildcard (py_wildcard)", () => {
  it("wildcard: a `from x import *`", async () => {
    const f = await py("myapp/a.py", `from os import *\nfrom .models import User\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_wildcard")[0]?.pattern).toBe("wildcard");
  });
  it("explicit: ≥2 from-imports, none wildcard", async () => {
    const f = await py("myapp/a.py", `from os import path\nfrom sys import argv\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_wildcard")[0]?.pattern).toBe("explicit");
  });
  it("not decidable: a single explicit from-import", async () => {
    const f = await py("myapp/a.py", `from os import path\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_wildcard")).toEqual([]);
  });
  it("regex fallback: wildcard", () => {
    const f = treeless("myapp/a.py", `from os import path\nfrom sys import *\n`);
    expect(axis(pythonImportClassifier.classify(f), "py_wildcard")[0]?.pattern).toBe("wildcard");
  });
});
