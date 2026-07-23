import { describe, it, expect } from "vitest";
import { goRouteExtractor } from "../../../src/drift/route-extractors/go.js";
import { jsRouteExtractor } from "../../../src/drift/route-extractors/js.js";
import { pythonRouteExtractor } from "../../../src/drift/route-extractors/python.js";
import { rustRouteExtractor } from "../../../src/drift/route-extractors/rust.js";
import type { FileMiddleware, ExtractDeps } from "../../../src/drift/route-extractors/types.js";
import type { CrossFileIndex } from "../../../src/drift/security-xfile-index.js";
import type { DriftFile } from "../../../src/drift/types.js";

/**
 * Boundary tests for the per-language route extractors (PR #70 review).
 *
 * These call each extractor DIRECTLY on tree-less files (no `file.tree` → the
 * regex fallback path) and assert the WHOLE `RouteInfo` via `toEqual`, not just
 * one field. That closes the coverage gap the reviewer found: deleting the
 * comment-skip lines or gutting `inheritedValidation`/`inheritedRateLimit`
 * previously left the full suite green. Each case below turns red under exactly
 * those breakages.
 */

// A tree-less DriftFile: omitting `tree` forces the regex fallback in every extractor.
function file(relativePath: string, language: string, content: string): DriftFile {
  return { relativePath, language, content, lineCount: content.split("\n").length };
}

// xfile is only touched on the AST path, which tree-less files never reach.
function deps(fileMw?: Map<string, FileMiddleware>): ExtractDeps {
  return { fileMw: fileMw ?? new Map(), xfile: {} as unknown as CrossFileIndex };
}

describe("route-extractors: Go (regex fallback)", () => {
  it("extracts an Echo/Gin route with no signals", () => {
    const f = file("routes.go", "go", `package main\nr.GET("/health", healthCheck)`);
    expect(goRouteExtractor.extract(f, deps())).toEqual([
      { method: "GET", path: "/health", file: "routes.go", line: 2, hasAuth: false, hasValidation: false, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });

  it("detects auth (context) + captures Gorilla method from .Methods()", () => {
    const f = file("routes.go", "go", `authMiddleware(r)\nr.HandleFunc("/admin", h).Methods("PUT")`);
    expect(goRouteExtractor.extract(f, deps())).toEqual([
      { method: "PUT", path: "/admin", file: "routes.go", line: 2, hasAuth: true, hasValidation: false, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });

  it("detects validation + error handling from the handler body", () => {
    const f = file("routes.go", "go", `r.POST("/orders", h)\nfunc h(c *gin.Context){ c.Bind(&o); if err != nil {} }`);
    expect(goRouteExtractor.extract(f, deps())).toEqual([
      { method: "POST", path: "/orders", file: "routes.go", line: 1, hasAuth: false, hasValidation: true, hasRateLimit: false, hasErrorHandler: true },
    ]);
  });

  it("skips a commented-out route (the #66 fix — C-style)", () => {
    const f = file("routes.go", "go", `// r.POST("/admin", adminHandler)\nr.POST("/admin", adminHandler)`);
    // Exactly one route (line 2). If the comment-skip regressed, this would be two.
    expect(goRouteExtractor.extract(f, deps())).toEqual([
      { method: "POST", path: "/admin", file: "routes.go", line: 2, hasAuth: false, hasValidation: false, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });
});

describe("route-extractors: JS/TS (regex fallback)", () => {
  it("extracts an Express route with no signals", () => {
    const f = file("app.js", "javascript", `router.get('/x', handler)`);
    expect(jsRouteExtractor.extract(f, deps())).toEqual([
      { method: "GET", path: "/x", file: "app.js", line: 1, hasAuth: false, hasValidation: false, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });

  it("detects inline auth + validation", () => {
    const f = file("app.js", "javascript", `router.use(requireAuth)\nrouter.post('/secure', validate(schema), handler)`);
    expect(jsRouteExtractor.extract(f, deps())).toEqual([
      { method: "POST", path: "/secure", file: "app.js", line: 2, hasAuth: true, hasValidation: true, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });

  it("inherits validation + rate-limit from file-level middleware", () => {
    // No inline val/rate signal on the route; both come from fileMw → exercises
    // inheritedValidation / inheritedRateLimit specifically.
    const mw = new Map<string, FileMiddleware>([["app.js", { hasAuth: false, hasValidation: true, hasRateLimit: true }]]);
    const f = file("app.js", "javascript", `router.get('/x', handler)`);
    expect(jsRouteExtractor.extract(f, deps(mw))).toEqual([
      { method: "GET", path: "/x", file: "app.js", line: 1, hasAuth: false, hasValidation: true, hasRateLimit: true, hasErrorHandler: false },
    ]);
  });

  it("skips a commented-out route (the #66 fix — C-style)", () => {
    const f = file("app.js", "javascript", `// router.post('/admin/delete', h)\nrouter.post('/admin/delete', h)`);
    expect(jsRouteExtractor.extract(f, deps())).toEqual([
      { method: "POST", path: "/admin/delete", file: "app.js", line: 2, hasAuth: false, hasValidation: false, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });

  it("maps .all() to method ALL", () => {
    const f = file("app.js", "javascript", `router.all('/any', handler)`);
    expect(jsRouteExtractor.extract(f, deps())[0].method).toBe("ALL");
  });
});

describe("route-extractors: Python (regex fallback)", () => {
  it("extracts a decorator-verb route (defaults handled), no signals", () => {
    const f = file("api.py", "python", `@app.post("/x")\ndef x(): return {}`);
    expect(pythonRouteExtractor.extract(f, deps())).toEqual([
      { method: "POST", path: "/x", file: "api.py", line: 1, hasAuth: false, hasValidation: false, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });

  it("reads the mutating verb from a methods=[...] kwarg", () => {
    const f = file("api.py", "python", `@app.route("/y", methods=["PUT"])\ndef y(): return {}`);
    expect(pythonRouteExtractor.extract(f, deps())[0]).toMatchObject({ method: "PUT", path: "/y" });
  });

  it("detects auth + error handling from surrounding context", () => {
    const f = file("api.py", "python", `@app.post("/z")\n@login_required\ndef z():\n    try:\n        pass\n    except Exception:\n        raise`);
    expect(pythonRouteExtractor.extract(f, deps())).toEqual([
      { method: "POST", path: "/z", file: "api.py", line: 1, hasAuth: true, hasValidation: false, hasRateLimit: false, hasErrorHandler: true },
    ]);
  });

  it("skips a commented-out route (# comment)", () => {
    const f = file("api.py", "python", `# @app.post("/danger")\n@app.post("/danger")\ndef danger(): return {}`);
    expect(pythonRouteExtractor.extract(f, deps())).toEqual([
      { method: "POST", path: "/danger", file: "api.py", line: 2, hasAuth: false, hasValidation: false, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });

  it("skips a route-shaped line inside a docstring", () => {
    const f = file("api.py", "python", `"""\nExample:\n    @app.post("/doc")\n"""\n@app.post("/real")\ndef real(): return {}`);
    expect(pythonRouteExtractor.extract(f, deps())).toEqual([
      { method: "POST", path: "/real", file: "api.py", line: 5, hasAuth: false, hasValidation: false, hasRateLimit: false, hasErrorHandler: false },
    ]);
  });
});

describe("route-extractors: Rust (AST-only, no regex fallback)", () => {
  it("returns no routes for a tree-less file (no regex fallback exists)", () => {
    const f = file("main.rs", "rust", `async fn handler() {}\nRouter::new().route("/x", get(handler))`);
    expect(rustRouteExtractor.extract(f, deps())).toEqual([]);
  });
});
