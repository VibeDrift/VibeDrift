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
import { bodyAuthSignatureGo, resolveEffectiveBody } from "../../../src/drift/security-ast-go.js";

/** Build a virtual Go repo (array of DriftFiles with parsed trees) from
 *  [relativePath, source] pairs. Parsed SEQUENTIALLY (web-tree-sitter is not
 *  concurrency-safe). */
async function goRepo(files: [string, string][]): Promise<DriftFile[]> {
  const out: DriftFile[] = [];
  for (const [path, src] of files) out.push(await fileWithTree(path, src, "go"));
  return out;
}

// A gin-style factory whose closure verifiably 401s (bodyAuthSignatureGo === "reject").
const GO_REJECT_FACTORY = `package middleware

import "net/http"

func AuthMiddleware() Handler {
\treturn func(c *Ctx) {
\t\tif c.GetHeader("Authorization") == "" {
\t\t\tc.AbortWithStatus(http.StatusUnauthorized)
\t\t\treturn
\t\t}
\t\tc.Next()
\t}
}
`;

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

  it("stores the go module path and leaves the go half empty for a python-only repo", async () => {
    const index = buildXFileIndex(await repo([["a.py", `x = 1\n`]]), "example.com/app");
    expect(index.go.modulePath).toBe("example.com/app");
    expect(index.go.files.size).toBe(0);
    expect(index.go.packages.size).toBe(0);
    expect(index.go.fileImports.size).toBe(0);
    expect(index.go.valueBound.size).toBe(0);
  });

  it("go module path is undefined when not supplied (Go disabled)", async () => {
    const index = buildXFileIndex(await repo([["a.py", `x = 1\n`]]));
    expect(index.go.modulePath).toBeUndefined();
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

// ─── Go cross-package resolution (T3) ────────────────────────────────────────

describe("buildXFileIndex — Go half construction", () => {
  it("populates packages/fileImports/valueBound for a go module", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
    ]), "myapp");
    expect([...index.go.files].sort()).toEqual(["handlers/routes.go", "internal/middleware/auth.go"]);
    expect(index.go.packages.has("internal/middleware")).toBe(true);
    expect(index.go.packages.get("internal/middleware")!.pkgName).toBe("middleware");
    // fileImports keys the importer by the target's DECLARED package name.
    expect(index.go.fileImports.get("handlers/routes.go")!.get("middleware")).toBe("internal/middleware");
    // `r` (a param) is value-bound in the importer; `middleware` (the package) is NOT.
    expect(index.go.valueBound.get("handlers/routes.go")!.has("r")).toBe(true);
    expect(index.go.valueBound.get("handlers/routes.go")!.has("middleware")).toBe(false);
  });
});

describe("resolveGoMiddlewareBody — RESOLVE cases", () => {
  it("resolves an imported package factory whose closure verifiably rejects", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
    ]), "myapp");
    const r = resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index);
    expect(r).not.toBeNull();
    expect(r!.def.childForFieldName("name")!.text).toBe("AuthMiddleware");
    expect(bodyAuthSignatureGo(resolveEffectiveBody(r!.def, r!.defs)!, r!.defs)).toBe("reject");
  });

  it("resolves through an ALIAS qualifier (alias is authoritative)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport mw "myapp/auth"\n\nfunc Register(r Router) {\n\tr.Use(mw.Require)\n}\n`],
      ["auth/auth.go", `package auth\n\nfunc Require() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(401)\n\t\tc.Next()\n\t}\n}\n`],
    ]), "myapp");
    const r = resolveGoMiddlewareBody("handlers/routes.go", "mw.Require", index);
    expect(r).not.toBeNull();
    expect(r!.def.childForFieldName("name")!.text).toBe("Require");
  });

  it("resolves a symbol in a package that SPANS multiple files", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
      ["internal/middleware/logging.go", `package middleware\n\nfunc LogRequests() {}\n`],
      ["internal/middleware/types.go", `package middleware\n\ntype Handler func()\n`],
    ]), "myapp");
    const r = resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index);
    expect(r).not.toBeNull();
    expect(r!.def.childForFieldName("name")!.text).toBe("AuthMiddleware");
  });

  it("resolves when the DECLARED package name is NOT the import path's last segment (package auth in authz/)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/authz"\n\nfunc Register(r Router) {\n\tr.Use(auth.RequireAuth())\n}\n`],
      ["authz/guard.go", `package auth\n\nfunc RequireAuth() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(401)\n\t\tc.Next()\n\t}\n}\n`],
    ]), "myapp");
    // The call-site qualifier is `auth` (the declared package), NOT `authz` (the dir).
    expect(resolveGoMiddlewareBody("handlers/routes.go", "authz.RequireAuth", index)).toBeNull();
    const r = resolveGoMiddlewareBody("handlers/routes.go", "auth.RequireAuth", index);
    expect(r).not.toBeNull();
    expect(r!.def.childForFieldName("name")!.text).toBe("RequireAuth");
  });

  it("resolves despite a co-located _test.go (excluded wholesale from the package index)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", `package middleware\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(401)\n\t\tc.Next()\n\t}\n}\n`],
      // A `package middleware_test` clause AND an in-test duplicate helper: both
      // would poison the package index if _test.go were not excluded.
      ["internal/middleware/auth_test.go", `package middleware_test\n\nfunc AuthMiddleware() {}\n`],
    ]), "myapp");
    expect(index.go.packages.get("internal/middleware")!.pkgName).toBe("middleware");
    const r = resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index);
    expect(r).not.toBeNull();
    expect(r!.def.childForFieldName("name")!.text).toBe("AuthMiddleware");
  });

  it("carries the def's OWN defining-file defs for the in-file one-hop (multi-file package)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      // AuthMiddleware returns the same-file helper `authImpl`, which REJECTS.
      ["internal/middleware/auth.go", `package middleware\n\nimport "net/http"\n\nfunc AuthMiddleware() http.Handler { return authImpl }\n\nfunc authImpl(c *Ctx) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\treturn\n\t}\n\tc.Next()\n}\n`],
      // A DIFFERENT sibling authImpl that does NOT reject. If the wrong file's
      // defs travelled, the one-hop would resolve to THIS non-rejecting body.
      ["internal/middleware/helpers.go", `package middleware\n\nfunc authImpl(c *Ctx) {\n\tc.Next()\n}\n`],
    ]), "myapp");
    const r = resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index);
    expect(r).not.toBeNull();
    // The one-hop must resolve authImpl against auth.go's OWN defs -> reject.
    expect(bodyAuthSignatureGo(resolveEffectiveBody(r!.def, r!.defs)!, r!.defs)).toBe("reject");
  });
});

describe("resolveGoMiddlewareBody — REFUSE cases (never-false-bless)", () => {
  it("refuses an EXTERNAL package (not under the module path)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "github.com/foo/mw"\n\nfunc Register(r Router) {\n\tr.Use(mw.Auth)\n}\n`],
    ]), "myapp");
    expect(resolveGoMiddlewareBody("handlers/routes.go", "mw.Auth", index)).toBeNull();
  });

  it("refuses ALL Go resolution when goModulePath is null (no go.mod)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
    ]), null);
    expect(index.go.packages.size).toBe(0);
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
  });

  it("refuses ALL Go resolution when a replace directive forced goModulePath null", async () => {
    // The plumbing collapses goModulePath to null on a `replace`; at this layer
    // that is simply a null module path -> Go disabled.
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
    ]), null);
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
  });

  it("refuses ANY selector in a file that has a DOT import", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport (\n\t"myapp/internal/middleware"\n\t. "myapp/helpers"\n)\n\nfunc Register(r Router) {}\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
    ]), "myapp");
    expect(index.go.dotImports.has("handlers/routes.go")).toBe(true);
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
  });

  for (const [label, importer] of [
    [":= (short_var_declaration)", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tmiddleware := getMW()\n\tr.Use(middleware.Wrap())\n}\n`],
    ["method RECEIVER", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc (middleware *Server) Register(r Router) {\n\tr.Use(middleware.AuthMiddleware())\n}\n`],
    ["const (const_spec)", `package handlers\n\nimport "myapp/internal/middleware"\n\nconst middleware = 0\n`],
    ["named RETURN", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc provide() (middleware Handler) {\n\treturn nil\n}\n`],
  ] as const) {
    it(`refuses a VALUE-SHADOWED qualifier — ${label}`, async () => {
      const index = buildXFileIndex(await goRepo([
        ["handlers/routes.go", importer],
        ["internal/middleware/auth.go", GO_REJECT_FACTORY],
      ]), "myapp");
      // The middleware package DOES define AuthMiddleware, so the ONLY reason to
      // refuse is the value-shadowed qualifier.
      expect(index.go.valueBound.get("handlers/routes.go")!.has("middleware")).toBe(true);
      expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
    });
  }

  it("refuses a PACKAGE-NAME mismatch (plain import, declared package != qualifier)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", `package authpkg\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(401)\n\t}\n}\n`],
    ]), "myapp");
    // The declared package is `authpkg`, so `middleware.` is not a live qualifier.
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
    // But the real qualifier resolves (proves only the mismatch refuses).
    expect(resolveGoMiddlewareBody("handlers/routes.go", "authpkg.AuthMiddleware", index)).not.toBeNull();
  });

  it("refuses a symbol that is a METHOD (not a package-level function_declaration)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", `package middleware\n\ntype Mw struct{}\n\nfunc (m *Mw) AuthMiddleware() {}\n`],
    ]), "myapp");
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
  });

  it("refuses a symbol defined in TWO files of the package (sticky-null duplicate)", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
      ["internal/middleware/legacy.go", `package middleware\n\nfunc AuthMiddleware() Handler {\n\treturn nil\n}\n`],
    ]), "myapp");
    expect(index.go.packages.get("internal/middleware")!.defs.get("AuthMiddleware")).toBeNull();
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
  });

  it("refuses an UNEXPORTED (lowercase) cross-package symbol", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/auth"\n`],
      ["auth/auth.go", `package auth\n\nfunc check() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(401)\n\t}\n}\n`],
    ]), "myapp");
    expect(resolveGoMiddlewareBody("handlers/routes.go", "auth.check", index)).toBeNull();
  });

  it("refuses a symbol whose ONLY definition is in a parse-errored file", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/other.go", `package middleware\n\nfunc Other() {}\n`],
      // AuthMiddleware lives ONLY in this deliberately-unparseable file.
      ["internal/middleware/auth.go", `package middleware\n\nfunc AuthMiddleware( {\n`],
    ]), "myapp");
    const broken = (await goRepo([["x.go", `package middleware\n\nfunc AuthMiddleware( {\n`]]))[0];
    expect(broken.tree!.rootNode.hasError).toBe(true); // sanity: the fixture IS broken
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
    // The clean sibling def in the same package still resolves.
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.Other", index)).not.toBeNull();
  });

  it("refuses a bare (non-qualified) name and a deeper field chain", async () => {
    const index = buildXFileIndex(await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
    ]), "myapp");
    expect(resolveGoMiddlewareBody("handlers/routes.go", "AuthMiddleware", index)).toBeNull();
    expect(resolveGoMiddlewareBody("handlers/routes.go", "s.middleware.AuthMiddleware", index)).toBeNull();
  });
});

describe("resolveGoMiddlewareBody — determinism (order-independence)", () => {
  it("builds an equal go.packages map regardless of file order (duplicate -> null)", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n`],
      ["internal/middleware/auth.go", GO_REJECT_FACTORY],
      ["internal/middleware/legacy.go", `package middleware\n\nfunc AuthMiddleware() Handler { return nil }\n\nfunc LegacyOnly() {}\n`],
      ["internal/mw2/other.go", `package mw2\n\nfunc Guard() {}\n`],
    ]);
    const a = buildXFileIndex(files, "myapp");
    const b = buildXFileIndex(reversed(files), "myapp");

    expect([...a.go.packages.keys()].sort()).toEqual([...b.go.packages.keys()].sort());
    const nodeKey = (n: SyntaxNode | null | undefined) => (n == null ? String(n) : n.id);
    for (const [dir, pkgA] of a.go.packages) {
      const pkgB = b.go.packages.get(dir)!;
      expect(pkgB.pkgName).toBe(pkgA.pkgName);
      expect([...pkgA.defs.keys()].sort()).toEqual([...pkgB.defs.keys()].sort());
      for (const [name, entryA] of pkgA.defs) {
        const entryB = pkgB.defs.get(name)!;
        // A duplicated symbol is sticky-null in BOTH orders (never first-wins).
        expect(nodeKey(entryA?.def)).toBe(nodeKey(entryB?.def));
        expect(entryA?.file).toBe(entryB?.file);
        expect([...(entryA?.fileDefs.keys() ?? [])].sort()).toEqual([...(entryB?.fileDefs.keys() ?? [])].sort());
      }
    }
    // The duplicated symbol is null; the unique sibling survives.
    expect(a.go.packages.get("internal/middleware")!.defs.get("AuthMiddleware")).toBeNull();
    expect(b.go.packages.get("internal/middleware")!.defs.get("AuthMiddleware")).toBeNull();
    expect(a.go.packages.get("internal/middleware")!.defs.get("LegacyOnly")).not.toBeNull();
  });
});
