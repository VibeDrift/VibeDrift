import { describe, it, expect } from "vitest";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { DriftFile } from "../../../src/drift/types.js";
import type { SyntaxNode } from "../../../src/core/types.js";
import {
  buildXFileIndex,
  resolvePyHookBody,
  resolveGoMiddlewareBody,
} from "../../../src/drift/security-xfile-index.js";
import { bodyAuthSignature } from "../../../src/drift/security-ast-python.js";

/** Build a virtual repo (array of DriftFiles with parsed trees) from
 *  [relativePath, source] pairs. Parsed SEQUENTIALLY — web-tree-sitter is not
 *  safe to drive concurrently (a Promise.all race yields undefined trees). */
async function repo(files: [string, string][]): Promise<DriftFile[]> {
  const out: DriftFile[] = [];
  for (const [path, src] of files) out.push(await fileWithTree(path, src, "python"));
  return out;
}

/** Shuffle a copy with a fixed permutation (reverse) — enough to prove the
 *  index build is order-independent without RNG flakiness. */
function reversed<T>(xs: T[]): T[] {
  return [...xs].reverse();
}

const REJECT_AUTH = `def authenticate():\n    if not session.get("user_id"):\n        abort(401)\n`;

describe("buildXFileIndex — construction", () => {
  it("builds one index over all files: py.files holds every python path", async () => {
    const files = await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth.py", REJECT_AUTH],
    ]);
    const index = buildXFileIndex(files);
    expect([...index.py.files].sort()).toEqual(["app/auth.py", "app/routes.py"]);
    expect(index.py.fileDefs.has("app/auth.py")).toBe(true);
    expect(index.py.fileDefs.get("app/auth.py")!.has("authenticate")).toBe(true);
  });

  it("a broken (parse-error) file stays in py.files but gets NO fileDefs entry", async () => {
    const files = await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      // Deliberately unparseable: unterminated def.
      ["app/auth.py", `def authenticate(\n    if if if\n`],
    ]);
    const index = buildXFileIndex(files);
    const broken = files.find((f) => f.relativePath === "app/auth.py")!;
    expect(broken.tree!.rootNode.hasError).toBe(true);
    expect(index.py.files.has("app/auth.py")).toBe(true);
    expect(index.py.fileDefs.has("app/auth.py")).toBe(false);
  });

  it("stores the go module path and stubs the go half empty (T1)", async () => {
    const index = buildXFileIndex(await repo([["a.py", `x = 1\n`]]), "example.com/app");
    expect(index.go.modulePath).toBe("example.com/app");
    expect(index.go.files.size).toBe(0);
    expect(index.go.packageFuncs.size).toBe(0);
  });

  it("go module path is undefined when not supplied (Go disabled)", async () => {
    const index = buildXFileIndex(await repo([["a.py", `x = 1\n`]]));
    expect(index.go.modulePath).toBeUndefined();
  });

  it("resolveGoMiddlewareBody is stubbed to null in T1", () => {
    expect(resolveGoMiddlewareBody()).toBeNull();
  });
});

describe("buildXFileIndex — determinism (order-independence)", () => {
  it("produces an identical py index regardless of file ordering", async () => {
    const files = await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth.py", REJECT_AUTH],
      ["app/mw/auth.py", `def require_auth():\n    abort(401)\n`],
      ["app/helpers.py", `def helpers():\n    return 1\n`],
      ["broken.py", `def x(\n`],
    ]);
    const a = buildXFileIndex(files);
    const b = buildXFileIndex(reversed(files));

    // Same member set for py.files.
    expect([...a.py.files].sort()).toEqual([...b.py.files].sort());

    // Same keys for fileDefs, and every (rel,name) maps to the SAME underlying
    // node (or the same null) in both builds — no last-wins drift. web-tree-
    // sitter hands out a fresh JS wrapper per access, so identity is compared
    // via the stable underlying-node `.id`, not object reference.
    const nodeKey = (n: SyntaxNode | null | undefined) => (n == null ? String(n) : n.id);
    expect([...a.py.fileDefs.keys()].sort()).toEqual([...b.py.fileDefs.keys()].sort());
    for (const [rel, defsA] of a.py.fileDefs) {
      const defsB = b.py.fileDefs.get(rel)!;
      expect([...defsA.keys()].sort()).toEqual([...defsB.keys()].sort());
      for (const [name, nodeA] of defsA) {
        expect(nodeKey(defsB.get(name))).toBe(nodeKey(nodeA));
      }
    }
  });

  it("a symbol defined twice in one file is poisoned to null (not last-wins)", async () => {
    const files = await repo([
      ["app/auth.py", `def authenticate():\n    abort(401)\n\ndef authenticate():\n    return 1\n`],
    ]);
    const a = buildXFileIndex(files);
    const b = buildXFileIndex(reversed(files));
    expect(a.py.fileDefs.get("app/auth.py")!.get("authenticate")).toBeNull();
    expect(b.py.fileDefs.get("app/auth.py")!.get("authenticate")).toBeNull();
  });
});

describe("resolvePyHookBody — RESOLVE cases", () => {
  it("resolves a single-dot relative import to the defining file's body", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth.py", REJECT_AUTH],
    ]));
    const r = resolvePyHookBody(index, "app/routes.py", "authenticate");
    expect(r).not.toBeNull();
    expect(r!.originalName).toBe("authenticate");
    expect(r!.body!.text).toContain("abort(401)");
    expect(bodyAuthSignature(r!.body!, r!.defs)).toBe("reject");
  });

  it("resolves a double-dot import with a subpackage", async () => {
    const index = buildXFileIndex(await repo([
      ["app/sub/routes.py", `from ..mw.auth import require_auth\n`],
      ["app/mw/auth.py", `def require_auth():\n    abort(401)\n`],
    ]));
    const r = resolvePyHookBody(index, "app/sub/routes.py", "require_auth");
    expect(r).not.toBeNull();
    expect(r!.originalName).toBe("require_auth");
    expect(r!.body!.text).toContain("abort(401)");
  });

  it("follows ONE __init__ re-export hop to the real defining file", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth/__init__.py", `from .impl import authenticate\n`],
      ["app/auth/impl.py", REJECT_AUTH],
    ]));
    const r = resolvePyHookBody(index, "app/routes.py", "authenticate");
    expect(r).not.toBeNull();
    expect(r!.body!.text).toContain("abort(401)");
  });

  it("resolves an aliased import back to the target's true symbol name", async () => {
    const index = buildXFileIndex(await repo([
      ["app/sub/routes.py", `from ..auth import verify as v\n`],
      ["app/auth.py", `def verify():\n    abort(401)\n`],
    ]));
    const r = resolvePyHookBody(index, "app/sub/routes.py", "v");
    expect(r).not.toBeNull();
    expect(r!.originalName).toBe("verify");
    expect(r!.body!.text).toContain("abort(401)");
  });
});

describe("resolvePyHookBody — REFUSE cases (never-false-bless)", () => {
  it("refuses an absolute (dotted) import even when the file exists", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from app.auth import authenticate\n`],
      ["app/auth.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses a relative import that reaches beyond the repo root", async () => {
    const index = buildXFileIndex(await repo([
      ["routes.py", `from ..auth import authenticate\n`],
      ["auth.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(index, "routes.py", "authenticate")).toBeNull();
  });

  it("refuses when BOTH module.py and package/__init__.py exist (ambiguous)", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth.py", REJECT_AUTH],
      ["app/auth/__init__.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses a symbol defined twice in the target file", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth.py", `def authenticate():\n    abort(401)\n\ndef authenticate():\n    return 1\n`],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("NEVER picks a same-name symbol from a sibling file (symbol-not-defined)", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth.py", `def helpers():\n    return 1\n`],
      ["app/other.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses a wildcard import (name never enters the table)", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import *\n`],
      ["app/auth.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses ALL resolution in a file that has any wildcard import (blanket)", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .other import *\nfrom .auth import authenticate\n`],
      ["app/auth.py", REJECT_AUTH],
      ["app/other.py", `def other():\n    return 1\n`],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses when a re-export would need MORE than one hop (depth exceeded)", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth/__init__.py", `from .a import authenticate\n`],
      ["app/auth/a.py", `from .b import authenticate\n`],
      ["app/auth/b.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses when the target file has a parse error (no fileDefs entry)", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth.py", `def authenticate(\n    if if if\n`],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses a name bound by a relative AND a non-relative import (poisoned)", async () => {
    const absPoison = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\nfrom thirdparty import authenticate\n`],
      ["app/auth.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(absPoison, "app/routes.py", "authenticate")).toBeNull();

    const aliasPoison = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\nimport x as authenticate\n`],
      ["app/auth.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(aliasPoison, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses when a same-file def shadows the imported name (local shadow)", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n\ndef authenticate():\n    return 1\n`],
      ["app/auth.py", REJECT_AUTH],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("refuses when the target symbol is only a nested (non-importable) def", async () => {
    const index = buildXFileIndex(await repo([
      ["app/routes.py", `from .auth import authenticate\n`],
      ["app/auth.py", `def outer():\n    def authenticate():\n        abort(401)\n    return authenticate\n`],
    ]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });

  it("returns null when the importer is not a known python file", async () => {
    const index = buildXFileIndex(await repo([["app/auth.py", REJECT_AUTH]]));
    expect(resolvePyHookBody(index, "app/routes.py", "authenticate")).toBeNull();
  });
});
