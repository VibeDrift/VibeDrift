import { describe, it, expect } from "vitest";
import {
  extractGoRoutesAst, extractGoFileMiddlewareAst, SECURITY_AST_GO,
  bodyAuthSignatureGo, classifyGoMiddlewareAuth, collectGoFunctionDefs,
  resolveEffectiveBody,
} from "../../../src/drift/security-ast-go.js";
import { SECURITY_AST } from "../../../src/drift/security-ast.js";
import { buildXFileIndex, resolveGoMiddlewareBody } from "../../../src/drift/security-xfile-index.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { SyntaxNode } from "../../../src/core/types.js";
import type { DriftFile } from "../../../src/drift/types.js";

const go = (path: string, src: string) => fileWithTree(path, src, "go");

/** Build a virtual Go repo (array of DriftFiles with parsed trees) from
 *  [relativePath, source] pairs. Parsed SEQUENTIALLY (web-tree-sitter is not
 *  concurrency-safe). */
async function goRepo(files: [string, string][]): Promise<DriftFile[]> {
  const out: DriftFile[] = [];
  for (const [path, src] of files) out.push(await go(path, src));
  return out;
}

/** The route file's parsed tree + its relativePath (the importer). */
function routeFile(files: DriftFile[], rel = "handlers/routes.go") {
  const f = files.find((x) => x.relativePath === rel)!;
  expect(f.tree!.rootNode.hasError).toBe(false);
  return f;
}

const PKG = "package main\n\n";

/** Body node + file-wide defs for a named function/method (mirrors the Python
 *  addendum's hookBody util). resolveEffectiveBody is exercised THROUGH the
 *  classifier; direct bodyAuthSignatureGo fixtures put the reject in the DIRECT
 *  body. */
async function mwBody(src: string, fnName: string): Promise<{ body: SyntaxNode; defs: Map<string, SyntaxNode | null> }> {
  const f = await go("mw.go", src);
  const root = f.tree!.rootNode;
  expect(root.hasError).toBe(false);
  const defs = collectGoFunctionDefs(root);
  const def = root.descendantsOfType(["function_declaration", "method_declaration"])
    .find((d) => d?.childForFieldName("name")?.text === fnName)!;
  return { body: def.childForFieldName("body")!, defs };
}

/** bodyAuthSignatureGo of a single-function fixture's DIRECT body. */
async function sig(src: string, fnName = "f") {
  const { body, defs } = await mwBody(src, fnName);
  return bodyAuthSignatureGo(body, defs);
}

/** extractGoRoutesAst over a full go source. */
async function routesOf(src: string) {
  const f = await go("routes.go", PKG + src);
  expect(f.tree!.rootNode.hasError).toBe(false);
  return extractGoRoutesAst(f.tree!, f.relativePath);
}

describe("go tree harness prerequisites", () => {
  it("parses a trivial go file to a clean tree", async () => {
    const f = await go("main.go", `package main\n\nfunc main() {}\n`);
    expect(f.tree).toBeDefined();
    expect(f.tree!.rootNode.hasError).toBe(false);
    expect(f.language).toBe("go");
  });

  it("pins the load-bearing grammar facts this module is built on", async () => {
    // Probe-verified 2026-07-13 against the pinned tree-sitter-wasms go grammar.
    // A grammar bump that renames these fails HERE with a named fact, not as a
    // silent recall collapse.
    const f = await go("facts.go",
      `package main\n\nfunc routes() {\n\tapi := r.Group("/api")\n\tapi.POST("/x", h)\n}\n`);
    const decl = f.tree!.rootNode.descendantsOfType("short_var_declaration")[0]!;
    expect(decl.childForFieldName("left")?.type).toBe("expression_list"); // NOT a bare identifier
    expect(decl.childForFieldName("right")?.type).toBe("expression_list");
    const call = f.tree!.rootNode.descendantsOfType("call_expression")
      .find((c) => c?.text.startsWith("api.POST"))!;
    const fn = call.childForFieldName("function")!;
    expect(fn.type).toBe("selector_expression");
    expect(fn.childForFieldName("field")?.type).toBe("field_identifier");
    // Broken go source still returns a tree (never null), flagged via hasError.
    const broken = await go("broken.go", `func {{{{`);
    expect(broken.tree).toBeDefined();
    expect(broken.tree!.rootNode.hasError).toBe(true);
  });
});

describe("extractGoRoutesAst: Gin and Echo verb routes", () => {
  it("extracts a structurally-resolved Gin route with method, path, and line", async () => {
    const f = await go("routes.go",
      `package main\n\n` +
      `func main() {\n` +
      `\tr := gin.Default()\n` +
      `\tr.POST("/orders", createOrder)\n` +
      `}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /orders auth=false",
    ]);
    expect(routes[0].line).toBe(5);
    expect(routes[0].file).toBe("routes.go");
  });

  it("recognizes a convention-gated func-param receiver with no constructor in file", async () => {
    // The dominant real-world Go layout: router built in main.go, routes
    // registered on a parameter.
    const f = await go("users.go",
      `package routes\n\n` +
      `func RegisterUsers(router *gin.Engine) {\n` +
      `\trouter.POST("/users", create)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /users"]);
  });

  it("resolves a method-receiver chain to the nearest field name", async () => {
    const f = await go("server.go",
      `package main\n\n` +
      `func (s *Server) routes() {\n` +
      `\ts.router.POST("/orders", s.handleCreateOrder)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
  });

  it("ignores HTTP-client and non-router receivers", async () => {
    const f = await go("client.go",
      `package main\n\n` +
      `func fetch() {\n` +
      `\tclient.Post("/api", body)\n` +
      `\tdb.Delete("/records")\n` +
      `\ts.store.Put("/key", v)\n` +
      `\tcache.Get("user:1")\n` +
      `\tc.Get("user")\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("extractGoRoutesAst: additional Gin/Echo recognition forms", () => {
  it("resolves a package-level var_spec constructor assignment (var e = echo.New())", async () => {
    const f = await go("varspec.go",
      `package main\n\nvar e = echo.New()\n\nfunc routes() {\n\te.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("resolves a plain assignment_statement constructor assignment (engine = gin.New())", async () => {
    const f = await go("assign.go",
      `package main\n\nfunc routes() {\n\tvar engine *gin.Engine\n\tengine = gin.New()\n\tengine.PUT("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /x"]);
  });

  it("resolves a fiber.New() constructor — extracts routes with correct method, path, and line", async () => {
    const f = await go("fiber_app.go",
      `package main\n\n` +
      `func main() {\n` +
      `\tapp := fiber.New()\n` +
      `\tapp.Post("/users", createUser)\n` +
      `\tapp.Get("/users", listUsers)\n` +
      `\tapp.Delete("/users/:id", deleteUser)\n` +
      `}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /users",
      "GET /users",
      "DELETE /users/:id",
    ]);
    expect(routes[0].line).toBe(5);
    expect(routes[0].file).toBe("fiber_app.go");
  });

  it("resolves a fiber.New() assigned to a non-standard variable name", async () => {
    const f = await go("fiber_custom.go",
      `package main\n\n` +
      `func main() {\n` +
      `\twebServer := fiber.New()\n` +
      `\twebServer.Put("/items", updateItem)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /items"]);
  });

  it("resolves a mux.NewRouter() constructor — Gorilla HandleFunc with chained Methods", async () => {
    const f = await go("mux_app.go",
      `package main\n\n` +
      `func main() {\n` +
      `\tmyRouter := mux.NewRouter()\n` +
      `\tmyRouter.HandleFunc("/api/items", handleItems).Methods("POST")\n` +
      `}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/items"]);
    expect(routes[0].line).toBe(5);
  });

  it("resolves r.Any to the ALL sentinel verb", async () => {
    const f = await go("any.go", `package main\n\nfunc routes() {\n\tr.Any("/everything", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /everything"]);
  });

  it("emits two RouteInfos for two routes in one file with distinct correct lines", async () => {
    const f = await go("two.go",
      `package main\n\nfunc routes() {\n\tr.POST("/a", h)\n\tr.GET("/b", h)\n}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}:${r.line}`)).toEqual([
      "POST /a:4",
      "GET /b:5",
    ]);
  });

  it("does not dedup an identical registration repeated on two lines", async () => {
    const f = await go("dup.go",
      `package main\n\nfunc routes() {\n\tr.POST("/orders", h)\n\tr.POST("/orders", h)\n}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}:${r.line}`)).toEqual([
      "POST /orders:4",
      "POST /orders:5",
    ]);
  });

  it("finds routes inside init(), a method body, and a func literal assigned to a variable (recursive walk)", async () => {
    const f = await go("recursive.go",
      `package main\n\n` +
      `func init() {\n\tr.POST("/init", h)\n}\n\n` +
      `type Server struct{}\n\n` +
      `func (s *Server) setup() {\n\trouter.POST("/method", h)\n}\n\n` +
      `var handler = func() {\n\tapp.POST("/closure", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /init", "POST /method", "POST /closure"]);
  });

  it("extracts a route inside a bare block following a Group derivation (block is transparent)", async () => {
    const f = await go("blockgroup.go",
      `package main\n\nfunc routes() {\n\tv1 := r.Group("/v1")\n\t{\n\t\tv1.POST("/a", h)\n\t}\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /a"]);
  });

  it("extracts a route whose handler is an inline func literal", async () => {
    const f = await go("funclit.go",
      `package main\n\nfunc routes() {\n\tr.GET("/ping", func(c *gin.Context) {\n\t\tc.String(200, "pong")\n\t})\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /ping"]);
  });
});

describe("extractGoRoutesAst: fiber smoke (documentation pin, non-goal)", () => {
  it("extracts app.Post via convention alone even though fiber.New is not a recognized constructor", async () => {
    // Framework auto-detection is a non-goal; the gates are purely structural
    // (constructor set) and conventional (receiver name), never a framework
    // identity check. fiber.New() is deliberately absent from
    // GO_ROUTER_CONSTRUCTORS, yet this route still extracts because "app"
    // passes the naming convention and "Post" is a recognized Capitalized verb.
    const f = await go("fiber.go",
      `package main\n\nfunc routes() {\n\tapp := fiber.New()\n\tapp.Post("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });
});

describe("extractGoRoutesAst: chi verb routes", () => {
  it("recognizes chi's Capitalized-only verb methods on a constructor-resolved router", async () => {
    const f = await go("chi.go",
      `package main\n\nfunc routes() {\n` +
      `\tr := chi.NewRouter()\n` +
      `\tr.Post("/orders", h)\n` +
      `\tr.Get("/orders", h)\n` +
      `\tr.Delete("/orders/{id}", h)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /orders",
      "GET /orders",
      "DELETE /orders/{id}",
    ]);
  });

  it("recognizes a chi With(...) chain as one route, auth=false in this task, line at the chain start", async () => {
    const f = await go("with.go",
      `package main\n\nfunc routes() {\n\tr.With(RequireAuth).Post("/orders", h)\n}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /orders auth=false",
    ]);
    expect(routes[0].line).toBe(4);
  });

  it("extracts a route registered inside a chi Route(...) closure, path stays the literal with no prefix joining", async () => {
    const f = await go("route.go",
      `package main\n\nfunc routes() {\n\tr.Route("/admin", func(r chi.Router) {\n\t\tr.Post("/users", h)\n\t})\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /users"]);
  });
});

describe("extractGoRoutesAst: receiver-gate convention table", () => {
  const POSITIVES = [
    "r", "router", "e", "g", "grp", "group", "app", "application", "server",
    "srv", "engine", "api", "mux", "v1", "v2", "usersRouter", "adminGroup",
    "apiMux", "appEngine",
  ];
  it.each(POSITIVES)("recognizes conventional receiver name %s with no in-file constructor", async (name) => {
    const f = await go("recv-pos.go",
      `package main\n\nfunc routes() {\n\t${name}.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  const NEGATIVES = ["c", "m", "db", "client", "cache", "store", "q", "req", "w", "ctx"];
  it.each(NEGATIVES)("does not recognize non-conventional receiver name %s", async (name) => {
    const f = await go("recv-neg.go",
      `package main\n\nfunc routes() {\n\t${name}.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("extractGoRoutesAst: verb casing and pinned-out scope", () => {
  it("ignores fully lowercase verb fields (api.post, r.get)", async () => {
    const f = await go("lower.go",
      `package main\n\nfunc routes() {\n\tapi.post("/x", h)\n\tr.get("/y", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not recognize OPTIONS or HEAD: neither is ever mutating, so exclusion is bless-safe", async () => {
    const f = await go("optionshead.go",
      `package main\n\nfunc routes() {\n\tr.OPTIONS("/x", h)\n\tr.HEAD("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not recognize the composite-literal Match form", async () => {
    const f = await go("match.go",
      `package main\n\nfunc routes() {\n\te.Match([]string{"GET"}, "/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("extractGoRoutesAst: structural resolution", () => {
  it.each(Array.from(SECURITY_AST_GO.GO_ROUTER_CONSTRUCTORS))(
    "resolves a spelling-defiant receiver assigned from %s(...)",
    async (ctor) => {
      const f = await go("ctor.go",
        `package main\n\nfunc routes() {\n\tzzz := ${ctor}()\n\tzzz.POST("/x", h)\n}\n`);
      expect(extractGoRoutesAst(f.tree!, f.relativePath)
        .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
    },
  );

  it("recognizes a Group-derived receiver (api := r.Group(\"/api\"))", async () => {
    const f = await go("derived.go",
      `package main\n\nfunc routes() {\n\tapi := r.Group("/api")\n\tapi.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("recognizes a nested Group-derived receiver (sub := api.Group(\"/v2\"))", async () => {
    const f = await go("nested.go",
      `package main\n\nfunc routes() {\n\tapi := r.Group("/api")\n\tsub := api.Group("/v2")\n\tsub.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("recognizes a PathPrefix(...).Subrouter() derived receiver with chi-caps verbs", async () => {
    const f = await go("subrouter.go",
      `package main\n\nfunc routes() {\n\ts := r.PathPrefix("/api").Subrouter()\n\ts.Post("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("recognizes a derived receiver whose own name misses the convention regex (payments)", async () => {
    const f = await go("payments.go",
      `package main\n\nfunc routes() {\n\tpayments := r.Group("/payments")\n\tpayments.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("does not derive a receiver from an unresolved base (notrouter is neither convention-gated nor constructor-assigned)", async () => {
    const f = await go("unresolvedbase.go",
      `package main\n\nfunc routes() {\n\tsub := notrouter.Group("/x")\n\tsub.POST("/y", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("handles a multi-value short_var_declaration (r, err := buildRouter()) without resolving or throwing", async () => {
    const f = await go("multival.go",
      `package main\n\nfunc routes() {\n\tr, err := buildRouter()\n\t_ = err\n}\n`);
    expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("resolves a 4-deep derivation chain (r -> api -> v1 -> admin)", async () => {
    const f = await go("chain4.go",
      `package main\n\nfunc routes() {\n` +
      `\tr := gin.Default()\n` +
      `\tapi := r.Group("/api")\n` +
      `\tv1 := api.Group("/v1")\n` +
      `\tadmin := v1.Group("/admin")\n` +
      `\tadmin.POST("/x", h)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("terminates on a 50-level derivation chain without hanging", async () => {
    let src = `package main\n\nfunc routes() {\n\tr := gin.Default()\n`;
    let prev = "r";
    for (let i = 1; i <= 50; i++) {
      src += `\tlvl${i} := ${prev}.Group("/${i}")\n`;
      prev = `lvl${i}`;
    }
    src += `\t${prev}.POST("/x", h)\n}\n`;
    const f = await go("chain50.go", src);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("does not extract unknownRecv.POST alone: no constructor, no convention (documented recall gap, mirrors the flask-restx ns pin)", async () => {
    const f = await go("unknown.go",
      `package main\n\nfunc routes() {\n\tunknownRecv.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not structurally resolve a gorilla-style NewRouter() under a non-conventional import alias (documented recall gap)", async () => {
    // "rt" is neither a recognized constructor key (only gin.Default/gin.New/
    // echo.New/chi.NewRouter are in GO_ROUTER_CONSTRUCTORS this task) nor a
    // conventional receiver name, so the route is missed. Had the assigned
    // name itself passed the convention regex (e.g. "router" or "mux"), it
    // would extract independent of the package alias used to call NewRouter.
    const f = await go("aliasgap.go",
      `package main\n\nfunc routes() {\n\trt := gorillamux.NewRouter()\n\trt.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("extractGoRoutesAst: embedded-engine method receiver (pinned recall gap)", () => {
  it("does not recognize a method receiver whose struct embeds a known engine type", async () => {
    const f = await go("embedded.go",
      `package main\n\n` +
      `type Server struct {\n\t*gin.Engine\n}\n\n` +
      `func (s *Server) routes() {\n\ts.POST("/orders", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("extractGoRoutesAst: path-string forms", () => {
  it("accepts both interpreted and raw backtick string paths", async () => {
    const f = await go("delims.go",
      `package main\n\nfunc routes() {\n\tr.POST("/orders", h)\n\tr.GET(\`/raw\`, h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders", "GET /raw"]);
  });

  it("keeps an escaped quote in the path raw, never unescaped", async () => {
    const f = await go("escape.go",
      `package main\n\nfunc routes() {\n\tr.POST("/a\\"b", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(['/a\\"b']);
  });

  it("accepts the root path", async () => {
    const f = await go("root.go", `package main\n\nfunc routes() {\n\tr.GET("/", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(["/"]);
  });

  it("skips an empty path string", async () => {
    const f = await go("empty.go", `package main\n\nfunc routes() {\n\tr.GET("", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips a path with no leading slash", async () => {
    const f = await go("noslash.go", `package main\n\nfunc routes() {\n\tr.GET("orders", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("keeps framework parameter syntaxes verbatim", async () => {
    const f = await go("params.go",
      `package main\n\nfunc routes() {\n` +
      `\tr.GET("/users/:id", h)\n` +
      `\tr.GET("/users/{id}", h)\n` +
      `\tr.GET("/users/{id:[0-9]+}", h)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(["/users/:id", "/users/{id}", "/users/{id:[0-9]+}"]);
  });

  it("accepts a unicode path", async () => {
    const f = await go("unicode.go", `package main\n\nfunc routes() {\n\tr.GET("/café", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(["/café"]);
  });

  it("skips statically unresolvable paths: fmt.Sprintf, string concatenation, and a bare identifier", async () => {
    const f = await go("unresolvable.go",
      `package main\n\nfunc routes() {\n` +
      `\tr.POST(fmt.Sprintf("/api/%s", v), h)\n` +
      `\tr.POST("/a" + suffix, h)\n` +
      `\tr.POST(pathVar, h)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips a bare identifier path even when a same-file const of that name holds a literal (no const folding, pinned gap)", async () => {
    const f = await go("constvar.go",
      `package main\n\nconst pathVar = "/x"\n\nfunc routes() {\n\tr.POST(pathVar, h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips a group-relative empty path (leading-slash gate, not a group-prefix join)", async () => {
    const f = await go("grouppath.go",
      `package main\n\nfunc routes() {\n\tapi := r.Group("/api")\n\tapi.POST("", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("Gorilla mux and stdlib recognition", () => {
  it("recognizes router.HandleFunc(...).Methods(\"POST\") as exactly one POST route (HandleFunc is the anchor)", async () => {
    const f = await go("gorilla.go",
      `package main\n\nfunc routes() {\n` +
      `\trouter := mux.NewRouter()\n` +
      `\trouter.HandleFunc("/orders", createOrder).Methods("POST")\n` +
      `}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
  });

  it("resolves a multiline fluent chain with the line of the HandleFunc anchor, not the Methods call", async () => {
    const f = await go("multiline.go",
      `package main\n\nfunc routes() {\n` +
      `\trouter := mux.NewRouter()\n` +
      `\trouter.HandleFunc("/orders", h).\n` +
      `\t\tMethods("POST")\n` +
      `}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
    expect(routes[0].line).toBe(5);
  });

  it("walks chain ascent through an intermediate link: .Methods(\"POST\").Name(\"create\")", async () => {
    const f = await go("chain-a.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/orders", h).Methods("POST").Name("create")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
  });

  it("walks chain ascent through an intermediate link in the other order: .Name(\"create\").Methods(\"POST\")", async () => {
    const f = await go("chain-b.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/orders", h).Name("create").Methods("POST")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
  });

  it("recognizes router.Handle(...).Methods(\"PUT\") the same way as HandleFunc", async () => {
    const f = await go("handle-chain.go",
      `package main\n\nfunc routes() {\n\trouter.Handle("/x", handler).Methods("PUT")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /x"]);
  });

  it("disambiguates Gin's verb-first Handle(method, path, h)", async () => {
    const f = await go("handle-verbfirst.go",
      `package main\n\nfunc routes() {\n\tr.Handle("POST", "/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("disambiguates Gorilla's path-first Handle(path, h) with no chain as ALL", async () => {
    const f = await go("handle-pathfirst.go",
      `package main\n\nfunc routes() {\n\trouter.Handle("/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /x"]);
  });

  it("resolves a chain split across statements as ALL (variable-carried chains are not tracked), never double-counted", async () => {
    const f = await go("split-chain.go",
      `package main\n\nfunc routes() {\n\troute := r.HandleFunc("/orders", h)\n\troute.Methods("POST")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /orders"]);
  });

  it("resolves a Gorilla subrouter's HandleFunc(...).Methods(...) chain", async () => {
    const f = await go("subrouter-chain.go",
      `package main\n\nfunc routes() {\n\tapi := r.PathPrefix("/api").Subrouter()\n\tapi.HandleFunc("/orders", h).Methods("POST")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
  });

  it("recognizes stdlib http.HandleFunc as ALL (\"http\" special-cased for Handle/HandleFunc only)", async () => {
    const f = await go("stdlib-http.go",
      `package main\n\nfunc routes() {\n\thttp.HandleFunc("/orders", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /orders"]);
  });

  it("resolves a structurally-assigned http.NewServeMux() receiver's HandleFunc", async () => {
    const f = await go("servemux.go",
      `package main\n\nfunc routes() {\n\tmux := http.NewServeMux()\n\tmux.HandleFunc("/orders", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /orders"]);
  });

  it("resolves chi's any-method HandleFunc and Handle to ALL", async () => {
    const f = await go("chi-any.go",
      `package main\n\nfunc routes() {\n\tr.HandleFunc("/events", h)\n\tr.Handle("/events", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /events", "ALL /events"]);
  });

  it("does not recognize http.Post / http.Get as routes: \"http\" is not a receiver for verb fields", async () => {
    const f = await go("http-client.go",
      `package main\n\nfunc routes() {\n` +
      `\thttp.Post("https://api.example.com/orders", ct, body)\n` +
      `\thttp.Get(url)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("parses a Go 1.22 verb-in-path pattern (POST /orders)", async () => {
    const f = await go("go122-post.go",
      `package main\n\nfunc routes() {\n\tmux.HandleFunc("POST /orders", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
  });

  it("parses a Go 1.22 pattern with a path parameter (GET /items/{id})", async () => {
    const f = await go("go122-get.go",
      `package main\n\nfunc routes() {\n\tmux.HandleFunc("GET /items/{id}", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /items/{id}"]);
  });

  it("resolves a Go 1.22 pattern with double-space separation", async () => {
    const f = await go("go122-doublespace.go",
      `package main\n\nfunc routes() {\n\tmux.HandleFunc("POST  /orders", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
  });

  it("skips Go 1.22-shaped negatives: lowercase verb, host pattern, and a verb with no path", async () => {
    const f = await go("go122-negatives.go",
      `package main\n\nfunc routes() {\n` +
      `\tmux.HandleFunc("post /x", h)\n` +
      `\tmux.HandleFunc("example.com/route", h)\n` +
      `\tmux.HandleFunc("POST", h)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("method resolution", () => {
  it.each(Array.from(SECURITY_AST_GO.VERB_FIELDS.entries()))(
    "resolves verb-field casing %s to canonical %s",
    async (field, canonical) => {
      const f = await go("casing.go", `package main\n\nfunc routes() {\n\tr.${field}("/x", h)\n}\n`);
      expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual([canonical]);
    },
  );

  it("resolves a single-verb .Methods(\"POST\") to POST", async () => {
    const f = await go("methods-post.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/x", h).Methods("POST")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["POST"]);
  });

  it("resolves .Methods(\"GET\", \"POST\") to POST: first MUTATING verb in argument order", async () => {
    const f = await go("methods-getpost.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/x", h).Methods("GET", "POST")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["POST"]);
  });

  it("resolves .Methods(\"DELETE\", \"POST\") to DELETE: DELETE is first and already mutating", async () => {
    const f = await go("methods-deletepost.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/x", h).Methods("DELETE", "POST")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["DELETE"]);
  });

  it("resolves .Methods(\"GET\") to GET: emitted, simply outside the mutating vote", async () => {
    const f = await go("methods-get.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/x", h).Methods("GET")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["GET"]);
  });

  it("resolves .Methods(\"post\") lowercase to POST: gorilla uppercases at runtime", async () => {
    const f = await go("methods-lower.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/x", h).Methods("post")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["POST"]);
  });

  it("resolves .Methods(verbs...) with a non-literal arg to ALL: statically unresolvable stays in the mutating vote", async () => {
    const f = await go("methods-spread.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/x", h).Methods(verbs...)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["ALL"]);
  });

  it("resolves .Methods(\"MKCOL\") to GET: fully literal, zero recognized verbs is not ambiguity (mkcol parity)", async () => {
    const f = await go("methods-mkcol.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/x", h).Methods("MKCOL")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["GET"]);
  });

  it("pins ABSENT Methods as ALL, never ANY, across HandleFunc/Handle with no chain, chi, and stdlib bare paths", async () => {
    const f = await go("absent-methods.go",
      `package main\n\nfunc routes() {\n` +
      `\trouter.HandleFunc("/a", h)\n` +
      `\trouter.Handle("/b", h)\n` +
      `\tr.HandleFunc("/c", h)\n` +
      `\tr.Handle("/d", h)\n` +
      `\thttp.HandleFunc("/e", h)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method))
      .toEqual(["ALL", "ALL", "ALL", "ALL", "ALL"]);
  });

  it("ALL is in the shared mutating vocabulary and ANY is not", () => {
    const mutating = [...SECURITY_AST.MUTATING].map((m) => m.toUpperCase());
    expect(mutating).toContain("ALL");
    expect(mutating).not.toContain("ANY");
  });

  it("resolves chi's verb-first Method(method, path, h)", async () => {
    const f = await go("verbfirst-method.go",
      `package main\n\nfunc routes() {\n\tr.Method("PATCH", "/y", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["PATCH /y"]);
  });

  it("resolves chi's verb-first MethodFunc(method, path, h)", async () => {
    const f = await go("verbfirst-methodfunc.go",
      `package main\n\nfunc routes() {\n\tr.MethodFunc("DELETE", "/z", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /z"]);
  });

  it("resolves Echo's verb-first Add(method, path, h)", async () => {
    const f = await go("verbfirst-add.go",
      `package main\n\nfunc routes() {\n\te.Add("DELETE", "/z", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /z"]);
  });

  it("resolves a verb-first call with a variable verb to ALL", async () => {
    const f = await go("verbfirst-variable.go",
      `package main\n\nfunc routes() {\n\tr.Method(verb, "/x", h)\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /x"]);
  });

  it("skips HEAD/OPTIONS on the chained .Methods(...) path", async () => {
    const head = await go("chain-head.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/status", h).Methods("HEAD")\n}\n`);
    expect(extractGoRoutesAst(head.tree!, head.relativePath)).toEqual([]);
    const options = await go("chain-options.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/status", h).Methods("OPTIONS")\n}\n`);
    expect(extractGoRoutesAst(options.tree!, options.relativePath)).toEqual([]);
  });

  it("filters HEAD before the first-mutating pick in a mixed .Methods(\"HEAD\", \"POST\")", async () => {
    const f = await go("chain-headpost.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/status", h).Methods("HEAD", "POST")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["POST"]);
  });

  it("filters HEAD before the first-mutating pick in a mixed .Methods(\"HEAD\", \"GET\")", async () => {
    const f = await go("chain-headget.go",
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/status", h).Methods("HEAD", "GET")\n}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["GET"]);
  });

  it("skips HEAD/OPTIONS on the verb-first resolution path", async () => {
    const head = await go("verbfirst-head.go",
      `package main\n\nfunc routes() {\n\tr.Method("HEAD", "/x", h)\n}\n`);
    expect(extractGoRoutesAst(head.tree!, head.relativePath)).toEqual([]);
    const options = await go("verbfirst-options.go",
      `package main\n\nfunc routes() {\n\te.Add("OPTIONS", "/x", h)\n}\n`);
    expect(extractGoRoutesAst(options.tree!, options.relativePath)).toEqual([]);
    const ginHead = await go("verbfirst-gin-head.go",
      `package main\n\nfunc routes() {\n\tr.Handle("HEAD", "/x", h)\n}\n`);
    expect(extractGoRoutesAst(ginHead.tree!, ginHead.relativePath)).toEqual([]);
  });

  it("skips HEAD/OPTIONS on the Go 1.22 verb-in-path resolution path", async () => {
    const head = await go("go122-head.go",
      `package main\n\nfunc routes() {\n\tmux.HandleFunc("HEAD /status", h)\n}\n`);
    expect(extractGoRoutesAst(head.tree!, head.relativePath)).toEqual([]);
    const options = await go("go122-options.go",
      `package main\n\nfunc routes() {\n\tmux.HandleFunc("OPTIONS /cors", h)\n}\n`);
    expect(extractGoRoutesAst(options.tree!, options.relativePath)).toEqual([]);
  });

  describe("documented trade-offs (pinned recall gaps, never a false-bless)", () => {
    it("pins the Gorilla Route-builder chain form as unrecognized: HandlerFunc/Handler is the registering field, not an anchor", async () => {
      const a = await go("builder-a.go",
        `package main\n\nfunc routes() {\n\tr.Methods("POST").Path("/orders").HandlerFunc(h)\n}\n`);
      expect(extractGoRoutesAst(a.tree!, a.relativePath)).toEqual([]);
      const b = await go("builder-b.go",
        `package main\n\nfunc routes() {\n\tr.Path("/orders").Handler(h)\n}\n`);
      expect(extractGoRoutesAst(b.tree!, b.relativePath)).toEqual([]);
      const c = await go("builder-c.go",
        `package main\n\nfunc routes() {\n\tr.PathPrefix("/api").HandlerFunc(h)\n}\n`);
      expect(extractGoRoutesAst(c.tree!, c.relativePath)).toEqual([]);
    });
  });

  describe("vocabulary property", () => {
    // Non-vacuous: the HEAD/OPTIONS-only fixtures below are recognized route
    // registrations that must contribute ZERO methods on every one of the
    // three resolution paths (chain, verb-first, Go 1.22), proving the skip
    // is real rather than the property holding by omission.
    const MUTATING_VOTE_FIXTURES: string[] = [
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/orders", h).Methods("POST")\n}\n`,
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/status", h).Methods("HEAD", "GET")\n}\n`,
      `package main\n\nfunc routes() {\n\trouter.Handle("/x", h).Methods("PUT")\n}\n`,
      `package main\n\nfunc routes() {\n\tr.Method("PATCH", "/y", h)\n}\n`,
      `package main\n\nfunc routes() {\n\tr.MethodFunc("DELETE", "/z", h)\n}\n`,
      `package main\n\nfunc routes() {\n\trouter.Handle("/x", h)\n}\n`,
    ];
    const HEAD_OPTIONS_ONLY_FIXTURES: string[] = [
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/status", h).Methods("HEAD")\n}\n`,
      `package main\n\nfunc routes() {\n\trouter.HandleFunc("/status", h).Methods("OPTIONS")\n}\n`,
      `package main\n\nfunc routes() {\n\tr.Method("HEAD", "/x", h)\n}\n`,
      `package main\n\nfunc routes() {\n\te.Add("OPTIONS", "/x", h)\n}\n`,
      `package main\n\nfunc routes() {\n\tr.Handle("HEAD", "/x", h)\n}\n`,
      `package main\n\nfunc routes() {\n\tmux.HandleFunc("HEAD /status", h)\n}\n`,
      `package main\n\nfunc routes() {\n\tmux.HandleFunc("OPTIONS /cors", h)\n}\n`,
    ];

    it("keeps every emitted method inside {GET,POST,PUT,PATCH,DELETE,ALL}; HEAD/OPTIONS/ANY/lowercase never leak", async () => {
      const ALLOWED = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"]);
      const collected: string[] = [];
      for (let i = 0; i < MUTATING_VOTE_FIXTURES.length; i++) {
        const f = await go(`vocab-mutating-${i}.go`, MUTATING_VOTE_FIXTURES[i]);
        for (const r of extractGoRoutesAst(f.tree!, f.relativePath)) collected.push(r.method);
      }
      for (let i = 0; i < HEAD_OPTIONS_ONLY_FIXTURES.length; i++) {
        const f = await go(`vocab-skip-${i}.go`, HEAD_OPTIONS_ONLY_FIXTURES[i]);
        for (const r of extractGoRoutesAst(f.tree!, f.relativePath)) collected.push(r.method);
      }
      for (const m of collected) expect(ALLOWED.has(m)).toBe(true);
      expect(collected).toEqual(expect.arrayContaining(["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"]));
      // Exactly the 6 MUTATING_VOTE_FIXTURES routes: the 7 HEAD/OPTIONS-only
      // fixtures contributed nothing (non-vacuous skip).
      expect(collected.length).toBe(6);
    });
  });
});

// ─── Task 3: body-first auth classification ──────────────────────────────────

describe("Task 3 Step 1: grammar prerequisites for body-signature shapes", () => {
  it("pins the reject / credential / effective-body node shapes", async () => {
    // A tree-sitter-go bump that renames any of these fails HERE with a named
    // shape, not deep in a bless assertion.
    const abortSel = (await mwBody(
      PKG + `func f(c *gin.Context) { c.AbortWithStatus(http.StatusUnauthorized) }\n`, "f")).body
      .descendantsOfType("call_expression")[0]!;
    expect(abortSel.childForFieldName("function")?.type).toBe("selector_expression");
    const st = abortSel.childForFieldName("arguments")!.namedChildren[0]!;
    expect(st.type).toBe("selector_expression");
    expect(st.childForFieldName("field")?.text).toBe("StatusUnauthorized");

    const abortInt = (await mwBody(PKG + `func f(c *gin.Context) { c.AbortWithStatus(401) }\n`, "f")).body
      .descendantsOfType("int_literal")[0]!;
    expect(abortInt.type).toBe("int_literal"); // NOT "integer"
    expect(abortInt.text).toBe("401");

    const echoErr = (await mwBody(PKG + `func f(c echo.Context) error { return &echo.HTTPError{Code: 401} }\n`, "f")).body;
    const unary = echoErr.descendantsOfType("unary_expression")[0]!;
    const comp = unary.namedChildren[0]!;
    expect(comp.type).toBe("composite_literal");
    const lv = comp.descendantsOfType("literal_value")[0]!;
    const ke = lv.namedChildren.find((n) => n?.type === "keyed_element")!;
    expect(ke.namedChildren[0]!.text).toBe("Code");

    const httpErr = (await mwBody(PKG + `func f(w http.ResponseWriter) { http.Error(w, "no", http.StatusUnauthorized) }\n`, "f")).body
      .descendantsOfType("call_expression")[0]!;
    const hargs = httpErr.childForFieldName("arguments")!.namedChildren.filter((n): n is SyntaxNode => n !== null);
    expect(hargs[hargs.length - 1].childForFieldName("field")?.text).toBe("StatusUnauthorized"); // status LAST

    const factory = (await mwBody(PKG + `func F() gin.HandlerFunc { return func(c *gin.Context) { c.Next() } }\n`, "F")).body;
    const ret = factory.descendantsOfType("return_statement")[0]!;
    expect(ret.namedChild(0)!.type).toBe("expression_list");
    expect(ret.namedChild(0)!.namedChild(0)!.type).toBe("func_literal");

    const httpHandler = (await mwBody(
      PKG + `func F(next http.Handler) http.Handler { return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { next.ServeHTTP(w, r) }) }\n`, "F")).body;
    const retCall = httpHandler.descendantsOfType("return_statement")[0]!.namedChild(0)!.namedChild(0)!;
    expect(retCall.type).toBe("call_expression");
    expect(retCall.childForFieldName("arguments")!.namedChild(0)!.type).toBe("func_literal");

    // if-init idiom: read lives in the initializer field
    const ifInit = (await mwBody(
      PKG + `func f(c *gin.Context) { if _, err := v(c.GetHeader("Authorization")); err != nil { c.AbortWithStatus(401) } }\n`, "f")).body
      .descendantsOfType("if_statement")[0]!;
    expect(ifInit.childForFieldName("initializer")?.type).toBe("short_var_declaration");
    expect(ifInit.childForFieldName("condition")?.type).toBe("binary_expression");

    // function vs method name field kinds
    const fnDecl = (await go("g.go", PKG + `func plain() {}\n`)).tree!.rootNode
      .descendantsOfType("function_declaration")[0]!;
    expect(fnDecl.childForFieldName("name")?.type).toBe("identifier");
    const mDecl = (await go("g.go", PKG + `func (s *S) M() {}\n`)).tree!.rootNode
      .descendantsOfType("method_declaration")[0]!;
    expect(mDecl.childForFieldName("name")?.type).toBe("field_identifier");
  });
});

describe("Task 3: bodyAuthSignatureGo — reject", () => {
  it("gin self-aborting 401 blesses alone (constant and bare-integer parity)", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() }\n`)).toBe("reject");
    expect(await sig(PKG + `func f(c *gin.Context) { c.AbortWithStatus(401) }\n`)).toBe("reject");
    expect(await sig(PKG + `func f(c *gin.Context) { c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"e": "no"}) }\n`)).toBe("reject");
  });
  it("write-then-stop forms bless only WITH a following return / Abort", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { c.JSON(http.StatusUnauthorized, gin.H{"e": "no"}); c.Abort() }\n`)).toBe("reject");
    expect(await sig(PKG + `func f(c *gin.Context) { c.String(401, "no"); return }\n`)).toBe("reject");
  });
  it("echo returned-reject forms bless", async () => {
    expect(await sig(PKG + `func f(c echo.Context) error { return echo.NewHTTPError(http.StatusUnauthorized) }\n`)).toBe("reject");
    expect(await sig(PKG + `func f(c echo.Context) error { return &echo.HTTPError{Code: 401} }\n`)).toBe("reject");
    expect(await sig(PKG + `func f(c echo.Context) error { return c.NoContent(401) }\n`)).toBe("reject");
  });
  it("stdlib write+return and http.Error(401) bless", async () => {
    expect(await sig(PKG + `func f(w http.ResponseWriter, r *http.Request) { if r.Header.Get("Authorization") == "" { w.WriteHeader(http.StatusUnauthorized); return }; next.ServeHTTP(w, r) }\n`)).toBe("reject");
    expect(await sig(PKG + `func f(w http.ResponseWriter, r *http.Request) { if r.Header.Get("Authorization") == "" { http.Error(w, "unauthorized", http.StatusUnauthorized); return }; next.ServeHTTP(w, r) }\n`)).toBe("reject");
  });
  it("credential-guarded 403 blesses (bound local read from Authorization gates it)", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { tok := c.GetHeader("Authorization"); if tok == "" { c.AbortWithStatus(http.StatusForbidden); return } }\n`)).toBe("reject");
  });
  it("depth-agnostic: a reject in a for/switch/if branch counts", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { for _, x := range items { if !x { c.AbortWithStatus(401); return } } }\n`)).toBe("reject");
    expect(await sig(PKG + `func f(c *gin.Context) { switch x { case 1: c.AbortWithStatus(401) } }\n`)).toBe("reject");
  });
  it("one-hop: a same-file helper that holds the reject blesses the caller", async () => {
    const src = PKG +
      `func check(c *gin.Context) { if !ok(c) { c.AbortWithStatus(401) } }\n` +
      `func requireLogin(c *gin.Context) { check(c) }\n`;
    expect(await sig(src, "requireLogin")).toBe("reject");
  });
});

describe("Task 3: bodyAuthSignatureGo — none (never-false-bless)", () => {
  it("visible non-enforcing bodies are none", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { log.Printf("auth %s", c.Request.URL.Path); c.Next() }\n`)).toBe("none");
    expect(await sig(PKG + `func f(w http.ResponseWriter, r *http.Request) { log.Println(r.Method); next.ServeHTTP(w, r) }\n`)).toBe("none");
    expect(await sig(PKG + `func f(c *gin.Context) { metrics.Inc("req"); c.Next() }\n`)).toBe("none");
    expect(await sig(PKG + `func f(c *gin.Context) { c.Header("X-Frame-Options", "DENY"); c.Next() }\n`)).toBe("none");
    expect(await sig(PKG + `func f(c *gin.Context) { c.Next() }\n`)).toBe("none");
    expect(await sig(PKG + `func f(next echo.HandlerFunc) echo.HandlerFunc { return next }\n`)).toBe("none");
  });
  it("404 / 500 / lone-403 are NOT rejects", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { c.AbortWithStatus(http.StatusNotFound) }\n`)).toBe("none");
    expect(await sig(PKG + `func f(c *gin.Context) { c.AbortWithStatus(http.StatusInternalServerError) }\n`)).toBe("none");
    expect(await sig(PKG + `func f(c *gin.Context) { c.AbortWithStatus(http.StatusForbidden) }\n`)).toBe("none");
    expect(await sig(PKG + `func f(c echo.Context) error { return echo.NewHTTPError(http.StatusNotFound) }\n`)).toBe("none");
  });
  it("200 writes are not rejects", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { c.JSON(http.StatusOK, gin.H{}); c.Next() }\n`)).toBe("none");
    expect(await sig(PKG + `func f(c *gin.Context) { c.JSON(200, gin.H{}); c.Next() }\n`)).toBe("none");
  });
  it("CSRF 403 gate is none (X-CSRF-Token key vetoed -> guard not credential)", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { if c.GetHeader("X-CSRF-Token") != valid { c.AbortWithStatus(http.StatusForbidden) } }\n`)).toBe("none");
  });
  it("a reject inside a never-called nested closure (goroutine) does NOT count", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { go func() { c.AbortWithStatus(401) }(); c.Next() }\n`)).toBe("none");
  });
  it("NEVER-FALSE-BLESS: a 401 write that keeps calling next (no return/Abort) is none", async () => {
    // write-then-continue is a bug, not a reject: the request still reaches next.
    expect(await sig(PKG + `func f(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized); next.ServeHTTP(w, r) }\n`)).toBe("none");
    expect(await sig(PKG + `func f(c *gin.Context) { c.JSON(http.StatusUnauthorized, gin.H{}); c.Next() }\n`)).toBe("none");
  });
});

describe("Task 3: bodyAuthSignatureGo — opaque", () => {
  it("unresolvable auth-flavored callees are opaque", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { checkSession(c) }\n`)).toBe("opaque");
    expect(await sig(PKG + `func f(user User) { confirm(user) }\n`)).toBe("opaque");
    expect(await sig(PKG + `func f(c *gin.Context) { doAuth(c) }\n`)).toBe("opaque");
  });
  it("variable / credential-read-without-reject bodies are opaque", async () => {
    expect(await sig(PKG + `func f(c *gin.Context) { c.AbortWithStatus(code) }\n`)).toBe("opaque");
    expect(await sig(PKG + `func f(c *gin.Context) { token := c.GetHeader("Authorization"); validateOrDie(token) }\n`)).toBe("opaque");
  });
  it("a duplicate same-file def (follow neither) is opaque under a flavored callee", async () => {
    const src = PKG +
      `func checkAuth(c *gin.Context) { a(c) }\n` +
      `func checkAuth(c *gin.Context) { b(c) }\n` +
      `func f(c *gin.Context) { checkAuth(c) }\n`;
    expect(await sig(src, "f")).toBe("opaque");
  });
  it("a mutual-recursion cycle terminates and never false-blesses", async () => {
    const src = PKG + `func a(c *gin.Context) { b(c) }\nfunc b(c *gin.Context) { a(c) }\n`;
    expect(await sig(src, "a")).not.toBe("reject");
  });
});

describe("Task 3: classifyGoMiddlewareAuth precedence (LOCKED)", () => {
  it("rule 1 — veto beats a real body reject", async () => {
    const src = PKG + `func mw(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() }\n`;
    const { body, defs } = await mwBody(src, "mw");
    for (const name of ["OptionalAuth", "SkipAuth", "DisableAuth", "InsecureSkipAuth", "MockAuth"]) {
      expect(classifyGoMiddlewareAuth(name, body, defs)).toBe("not-auth");
    }
  });
  it("rule 2 — a visible reject body blesses even a boring name", async () => {
    const { body, defs } = await mwBody(
      PKG + `func buildGuard(c *gin.Context) { if session.Get("user") == nil { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() }\n`, "buildGuard");
    expect(classifyGoMiddlewareAuth("buildGuard", body, defs)).toBe("auth");
  });
  it("rule 3 — a visible non-enforcing body is not-auth whatever the name", async () => {
    const none = await mwBody(PKG + `func authCheck(c *gin.Context) { log.Printf("auth %s", c.Request.URL.Path); c.Next() }\n`, "authCheck");
    expect(classifyGoMiddlewareAuth("authCheck", none.body, none.defs)).toBe("not-auth");
    const notFound = await mwBody(PKG + `func authCheck(c *gin.Context) { c.AbortWithStatus(http.StatusNotFound) }\n`, "authCheck");
    expect(classifyGoMiddlewareAuth("authCheck", notFound.body, notFound.defs)).toBe("not-auth");
  });
  it("rule 4 — an opaque body NEVER blesses on name (flavored -> unsure, boring -> not-auth)", async () => {
    const flavored = await mwBody(PKG + `func authenticate(c *gin.Context) { doAuth(c) }\n`, "authenticate");
    expect(classifyGoMiddlewareAuth("authenticate", flavored.body, flavored.defs)).toBe("unsure");
    const boring = await mwBody(PKG + `func setup(c *gin.Context) { doStuff(c) }\n`, "setup");
    expect(bodyAuthSignatureGo(boring.body, boring.defs)).toBe("none"); // doStuff not flavored -> none, not opaque
    expect(classifyGoMiddlewareAuth("setup", boring.body, boring.defs)).toBe("not-auth");
    // an opaque body under a boring name is still not-auth (no name bless on opaque)
    const boringOpaque = await mwBody(PKG + `func setup(c *gin.Context) { c.AbortWithStatus(code) }\n`, "setup");
    expect(bodyAuthSignatureGo(boringOpaque.body, boringOpaque.defs)).toBe("opaque");
    expect(classifyGoMiddlewareAuth("setup", boringOpaque.body, boringOpaque.defs)).toBe("not-auth");
  });
  it("rule 5 — an unreadable (null) body NEVER blesses on name", async () => {
    const defs = new Map<string, SyntaxNode | null>();
    for (const name of ["AuthMiddleware", "middleware.AuthMiddleware", "JWTMiddleware", "EnsureLoggedIn", "middleware.VerifyToken", "OAuth2Middleware", "BasicAuth", "TokenRequired"]) {
      expect(classifyGoMiddlewareAuth(name, null, defs)).toBe("unsure");
    }
    for (const name of ["middleware.RequestID", "authLogger", "parseJWT", "newAuthHandler", "AuthMetrics"]) {
      expect(classifyGoMiddlewareAuth(name, null, defs)).toBe("not-auth");
    }
  });
});

describe("Task 3: body-first per-route middleware args (LOCKED)", () => {
  const auth1 = (name: string) =>
    `func ${name}(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() }\n`;

  it("IMPORTED/opaque auth-flavored middleware HEDGES (rule 5) — hasAuth false + key", async () => {
    const cases: Array<[string, string]> = [
      [`r.POST("/x", middleware.AuthMiddleware(), createX)`, "middleware.AuthMiddleware"],
      [`r.POST("/x", requireAuth, h)`, "requireAuth"],
      [`r.POST("/x", middleware.RequireAuth, h)`, "middleware.RequireAuth"],
      [`r.POST("/x", JWTMiddleware, h)`, "JWTMiddleware"],
      [`r.POST("/x", BasicAuth(), h)`, "BasicAuth"],
      [`r.POST("/x", OAuth2Middleware, h)`, "OAuth2Middleware"],
      [`r.POST("/x", JWTBearer, h)`, "JWTBearer"],
    ];
    for (const [reg, key] of cases) {
      const [rt] = await routesOf(`func routes() {\n\t${reg}\n}\n`);
      expect(rt.hasAuth).toBe(false);
      expect(rt.authUnsureHook).toBe(key);
    }
  });

  it("MIGRATION FLIP — pair-only imported names hedge (were name-only true)", async () => {
    for (const [reg, key] of [
      [`r.POST("/x", EnsureLoggedIn, h)`, "EnsureLoggedIn"],
      [`r.POST("/x", TokenRequired, h)`, "TokenRequired"],
      [`r.POST("/x", requireRole("admin"), h)`, "requireRole"],
      [`r.POST("/x", middleware.VerifyToken(), h)`, "middleware.VerifyToken"],
    ] as Array<[string, string]>) {
      const [rt] = await routesOf(`func routes() {\n\t${reg}\n}\n`);
      expect(rt.hasAuth).toBe(false);
      expect(rt.authUnsureHook).toBe(key);
    }
  });

  it("BODY-FIRST TWIN — an in-file rejecting body blesses (rule 2), key absent", async () => {
    const flavored = await routesOf(auth1("EnsureLoggedIn") + `func routes() {\n\tr.POST("/x", EnsureLoggedIn, h)\n}\n`);
    expect(flavored[0].hasAuth).toBe(true);
    expect(flavored[0].authUnsureHook).toBeUndefined();
    const boring = await routesOf(auth1("gate") + `func routes() {\n\tr.POST("/x", gate, h)\n}\n`);
    expect(boring[0].hasAuth).toBe(true); // body-only bless under a boring name
    expect(boring[0].authUnsureHook).toBeUndefined();
  });

  it("VISIBLE non-enforcing in-file body never blesses despite auth name (rule 3), key absent", async () => {
    const src = `func authCheck(c *gin.Context) { log.Printf("auth %s", c.Request.URL.Path); c.Next() }\n` +
      `func routes() {\n\tr.POST("/x", authCheck, h)\n}\n`;
    const [rt] = await routesOf(src);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("CREDENTIAL-READ-NO-REJECT in-file body is opaque -> rule 4 hedge (never bless)", async () => {
    const jwt = `func jwtMiddleware(c *gin.Context) { token := c.GetHeader("Authorization"); c.Set("user", token); c.Next() }\n`;
    const load = `func loadUser(c *gin.Context) { token := c.GetHeader("Authorization"); c.Set("user", token); c.Next() }\n`;
    const a = await routesOf(jwt + `func routes() {\n\tr.POST("/x", jwtMiddleware, h)\n}\n`);
    expect(a[0].hasAuth).toBe(false);
    expect(a[0].authUnsureHook).toBe("jwtMiddleware");
    const b = await routesOf(load + `func routes() {\n\tr.POST("/y", loadUser, h)\n}\n`);
    expect(b[0].hasAuth).toBe(false);
    expect(b[0].authUnsureHook).toBe("loadUser");
  });

  it("nameSegments parity — 'author' is not 'auth'", async () => {
    const [rt] = await routesOf(`func routes() {\n\tr.POST("/x", AuthorTracking(), h)\n}\n`);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("impure-chain callees never smuggle argument text (false, key absent)", async () => {
    const a = await routesOf(`func routes() {\n\tr.POST("/x", factory.Make(authCfg).Logger(), h)\n}\n`);
    expect(a[0].hasAuth).toBe(false);
    expect(a[0].authUnsureHook).toBeUndefined();
    const b = await routesOf(`func routes() {\n\tr.POST("/y", registry.get("authCfg").Logger, h)\n}\n`);
    expect(b[0].hasAuth).toBe(false);
    expect(b[0].authUnsureHook).toBeUndefined();
  });

  it("rule 1 veto wins even over a REAL in-file reject body (false, key absent)", async () => {
    for (const name of ["MockAuth", "SkipAuth", "DisableAuth"]) {
      const src = auth1(name) + `func routes() {\n\tr.POST("/x", ${name}, h)\n}\n`;
      const [rt] = await routesOf(src);
      expect(rt.hasAuth).toBe(false);
      expect(rt.authUnsureHook).toBeUndefined();
    }
  });

  it("veto negatives — imported, one route each, all false + key absent", async () => {
    for (const reg of [
      `r.POST("/x", OptionalAuth(), h)`, `r.POST("/x", SkipAuth, h)`, `r.POST("/x", BypassAuth(), h)`,
      `r.POST("/x", MockAuth(), h)`, `r.POST("/x", FakeAuthMiddleware, h)`, `r.POST("/x", AuthMetrics(), h)`,
      `r.POST("/x", authStats, h)`, `r.POST("/x", NoopAuth, h)`, `r.POST("/x", testAuth, h)`,
      `r.POST("/x", devAuth, h)`, `r.POST("/x", DummyAuth(), h)`, `r.POST("/x", InsecureSkipAuth(), h)`,
      `r.POST("/x", authLogger, h)`, `r.POST("/x", parseJWT(secret), h)`, `r.POST("/x", newAuthHandler(deps), h)`,
      `r.POST("/x", authLogin, mainHandler)`,
    ]) {
      const [rt] = await routesOf(`func routes() {\n\t${reg}\n}\n`);
      expect(rt.hasAuth).toBe(false);
      expect(rt.authUnsureHook).toBeUndefined();
    }
  });

  it("veto boundary — EnsureLoggedIn is NOT vetoed ('logged' != 'log') so it reaches unsure", async () => {
    const [rt] = await routesOf(`func routes() {\n\tr.POST("/x", EnsureLoggedIn, h)\n}\n`);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBe("EnsureLoggedIn");
  });

  it("verb-first middleware window starts AFTER the path arg (arg1)", async () => {
    const factory = `func RequireAuth() gin.HandlerFunc { return func(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(401); return }; c.Next() } }\n`;
    const [rt] = await routesOf(factory + `func routes() {\n\tr.Handle("POST", "/x", RequireAuth(), h)\n}\n`);
    expect(rt.method).toBe("POST");
    expect(rt.hasAuth).toBe(true); // in-file factory rejects; window includes arg2
  });

  it("chi With harvests every link (multi-link)", async () => {
    const withAuth = await routesOf(`func routes() {\n\tr.With(RequireAuth).With(paginate).Post("/orders", h)\n}\n`);
    expect(withAuth[0].hasAuth).toBe(false);
    expect(withAuth[0].authUnsureHook).toBe("RequireAuth"); // inner link harvested
    const noAuth = await routesOf(`func routes() {\n\tr.With(paginate).With(audit).Post("/x", h)\n}\n`);
    expect(noAuth[0].hasAuth).toBe(false);
    expect(noAuth[0].authUnsureHook).toBeUndefined();
    const single = await routesOf(`func routes() {\n\tr.With(paginate, RequireAuth).Get("/orders", h)\n}\n`);
    expect(single[0].authUnsureHook).toBe("RequireAuth"); // any With arg
  });

  it("handler-position identifier/selector is NEVER read, blessed, or hedged", async () => {
    const login = await routesOf(`func routes() {\n\tr.POST("/login", authLogin)\n}\n`);
    expect(login[0].hasAuth).toBe(false);
    expect(login[0].authUnsureHook).toBeUndefined();
    // handler body that reads Authorization + writes 401 is NOT read (body-first is middleware-only)
    const src = `func h(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(401); return }; c.JSON(200, nil) }\n` +
      `func routes() {\n\tr.POST("/x", h)\n}\n`;
    const [rt] = await routesOf(src);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });
});

describe("Task 3: body-first wrapped handlers (LOCKED)", () => {
  it("BODY-FIRST wrap disambiguation via the RETURNED closure", async () => {
    const rej = `func requireAuth(next http.Handler) http.Handler { return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { if r.Header.Get("Authorization") == "" { w.WriteHeader(http.StatusUnauthorized); return }; next.ServeHTTP(w, r) }) }\n`;
    const yes = await routesOf(rej + `func routes() {\n\thttp.HandleFunc("/orders", requireAuth(createOrder))\n}\n`);
    expect(yes[0].hasAuth).toBe(true);
    const pass = `func logWrap(next http.Handler) http.Handler { return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { log.Println(r.URL.Path); next.ServeHTTP(w, r) }) }\n`;
    const no = await routesOf(pass + `func routes() {\n\thttp.HandleFunc("/orders", logWrap(createOrder))\n}\n`);
    expect(no[0].hasAuth).toBe(false);
  });

  it("nested transparent wrap recurses to the inner in-file auth wrap (blesses)", async () => {
    const rej = `func requireAuth(next http.Handler) http.Handler { return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { if r.Header.Get("Authorization") == "" { w.WriteHeader(http.StatusUnauthorized); return }; next.ServeHTTP(w, r) }) }\n`;
    for (const outer of ["logRequests", "metricsWrap"]) {
      const src = rej + `func routes() {\n\tmux.Handle("/x", ${outer}(requireAuth(h)))\n}\n`;
      const [rt] = await routesOf(src);
      expect(rt.hasAuth).toBe(true);
    }
  });

  it("SUBSUMING-veto wrap HALTS recursion even over a REAL inner reject (false, key absent)", async () => {
    const rej = `func realGate(next http.Handler) http.Handler { return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { if r.Header.Get("Authorization") == "" { w.WriteHeader(http.StatusUnauthorized); return }; next.ServeHTTP(w, r) }) }\n`;
    for (const reg of [
      `mux.Handle("/x", optionalAuth(realGate))`,
      `mux.Handle("/x", SkipAuth(realGate))`,
      `mux.Handle("/x", DisableAuthInDev(realGate))`,
      `mux.Handle("/x", parseJWT(realGate))`,
    ]) {
      const [rt] = await routesOf(rej + `func routes() {\n\t${reg}\n}\n`);
      expect(rt.hasAuth).toBe(false);
      expect(rt.authUnsureHook).toBeUndefined();
    }
  });

  it("constructor-injection (DI) never classifies the injected arg (false, key absent)", async () => {
    for (const reg of [
      `mux.Handle("/webhook", NewWebhookHandler(cfg, auth.NewService(key)))`,
      `mux.Handle("/orders", NewOrdersHandler(db, jwtVerifier()))`,
      `mux.Handle("/di", NewHandler(auth.NewService(key)))`,
    ]) {
      const [rt] = await routesOf(`func routes() {\n\t${reg}\n}\n`);
      expect(rt.hasAuth).toBe(false);
      expect(rt.authUnsureHook).toBeUndefined();
    }
  });

  it("boring / composed / builder wrap negatives (false, key absent)", async () => {
    for (const reg of [
      `mux.Handle("/x", wrap(h))`,
      `mux.Handle("/x", timing(h))`,
      `mux.Handle("/x", makeHandler(authService))`,
      `mux.Handle("/x", chain(logger, auth)(h))`,
      `mux.Handle("/x", handlers.For(authConfig).Build(h))`,
    ]) {
      const [rt] = await routesOf(`func routes() {\n\t${reg}\n}\n`);
      expect(rt.hasAuth).toBe(false);
      expect(rt.authUnsureHook).toBeUndefined();
    }
  });

  it("UNSURE wrap — imported pair-name wrap hedges", async () => {
    const [rt] = await routesOf(`func routes() {\n\tmux.Handle("/x", TokenRequired(handler))\n}\n`);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBe("TokenRequired");
  });

  it("NEVER-FALSE-BLESS: a transparent wrap around an IMPORTED auth inner never blesses", async () => {
    // requireAuth has no in-file body -> rule 5 unsure; recursion propagates the
    // hedge, it does NOT fabricate a bless on the name alone.
    const [rt] = await routesOf(`func routes() {\n\tmux.Handle("/x", logRequests(requireAuth(h)))\n}\n`);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBe("requireAuth");
  });

  it("20-deep nested wrap: no throw, no bless", async () => {
    let expr = "h";
    for (let i = 0; i < 20; i++) expr = `logWrap(${expr})`;
    const [rt] = await routesOf(`func routes() {\n\tmux.Handle("/x", ${expr})\n}\n`);
    expect(rt.hasAuth).toBe(false);
  });
});

describe("Task 3: per-route validation and rate-limit lanes", () => {
  it("rate-limit lane (segment + pair)", async () => {
    const a = await routesOf(`func routes() {\n\tr.POST("/x", middleware.RateLimit(), h)\n}\n`);
    expect(a[0].hasRateLimit).toBe(true);
    expect(a[0].hasAuth).toBe(false);
    const b = await routesOf(`func routes() {\n\tr.POST("/y", RateLimiter(rate), h)\n}\n`);
    expect(b[0].hasRateLimit).toBe(true);
  });
  it("validation lane", async () => {
    const [rt] = await routesOf(`func routes() {\n\tr.POST("/x", validateBody(schema), h)\n}\n`);
    expect(rt.hasValidation).toBe(true);
  });
  it("segment discipline — substrings never match the lane", async () => {
    const v1 = await routesOf(`func routes() {\n\tr.POST("/x", cacheInvalidator, h)\n}\n`);
    expect(v1[0].hasValidation).toBe(false);
    const v2 = await routesOf(`func routes() {\n\tr.POST("/y", InvalidateCache(), h)\n}\n`);
    expect(v2[0].hasValidation).toBe(false);
    const r1 = await routesOf(`func routes() {\n\tr.POST("/z", csvDelimiter, h)\n}\n`);
    expect(r1[0].hasRateLimit).toBe(false);
  });
  it("a route path never blesses its lane (names come from args only)", async () => {
    const v = await routesOf(`func routes() {\n\tr.POST("/validate", h)\n}\n`);
    expect(v[0].hasValidation).toBe(false);
    const r = await routesOf(`func routes() {\n\tr.POST("/ratelimit", h)\n}\n`);
    expect(r[0].hasRateLimit).toBe(false);
  });
  it("a bare route keeps all three lanes false and independent", async () => {
    const [rt] = await routesOf(`func routes() {\n\tr.POST("/x", h)\n}\n`);
    expect(rt.hasAuth).toBe(false);
    expect(rt.hasValidation).toBe(false);
    expect(rt.hasRateLimit).toBe(false);
    // DELIBERATE DIVERGENCE (pinned): a handler body calling c.ShouldBindJSON does
    // NOT set hasValidation on the AST path — lanes come from structural middleware
    // names only, and hasErrorHandler is hard-coded false.
    expect(rt.hasErrorHandler).toBe(false);
  });
});

// ── Task 4: Use()/group-scoped middleware collector (body-first + unsure) ─────
//
// OPTION A (LOCKED owner decision governs; the brief's residual wide-core Step 2
// pins were STALE): an imported / opaque / no-in-file-def Use hook NEVER blesses.
// The AUTH lane (hasAuth true) is proven ONLY by in-file middleware whose body
// verifiably rejects (rule 2); imported CORE names (authMiddleware, RequireAuth,
// middleware.VerifyToken, ...) propagate the UNSURE lane (hasAuth false +
// authUnsureHook) by the SAME receiver / structural-scope / row rules. The scope
// model itself (row order, closure shadow, cross-function isolation, (name,scope)
// poisoning, conditional-Use skip, copy-at-creation) is invariant to which lane
// carries the signal.

// An in-file middleware whose body verifiably rejects (rule 2 bless).
const authDef = (name = "authMiddleware") =>
  `func ${name}(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() }\n`;
// Factory form (return-of-closure) with a rejecting inner body (rule 2 bless).
const authFactory = (name = "RequireAuth") =>
  `func ${name}() gin.HandlerFunc { return func(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() } }\n`;

describe("Use scoping and group inheritance (AUTH lane via in-file bodies)", () => {
  it("r.Use(<in-file rejecting body>) blesses a later same-scope route (key absent)", async () => {
    const [rt] = await routesOf(authDef() + `func routes() {\n\tr.Use(authMiddleware)\n\tr.POST("/x", h)\n}\n`);
    expect(rt.hasAuth).toBe(true);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("Use arg forms that bless: bare-call factory and multi-arg (in-file body)", async () => {
    // bare-call factory: r.Use(RequireAuth()) resolved to an in-file rejecting body
    const a = await routesOf(authFactory() + `func routes() {\n\tr.Use(RequireAuth())\n\tr.POST("/x", h)\n}\n`);
    expect(a[0].hasAuth).toBe(true);
    // multi-arg: only the in-file rejecting body confirms; gin.Logger() is ignored
    const b = await routesOf(authDef() + `func routes() {\n\tr.Use(gin.Logger(), authMiddleware)\n\tr.POST("/x", h)\n}\n`);
    expect(b[0].hasAuth).toBe(true);
  });

  it("BODY-FIRST bless under a BORING name (proves the collector reads bodies)", async () => {
    const src =
      `func guard(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() }\n` +
      `func routes() {\n\tr.Use(guard)\n\tr.POST("/x", h)\n}\n`;
    const [rt] = await routesOf(src);
    expect(rt.hasAuth).toBe(true);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("BODY-FIRST NON-bless under an AUTH name (rule 3: visible non-enforcing, key absent)", async () => {
    const src =
      `func authCheck(c *gin.Context) { log.Printf("auth %s", c.Request.URL.Path); c.Next() }\n` +
      `func routes() {\n\tr.Use(authCheck)\n\tr.POST("/x", h)\n}\n`;
    const [rt] = await routesOf(src);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("ROW ORDER (Gin runtime-truth, both directions in one fixture)", async () => {
    // /a is registered BEFORE the Use -> unblessed at runtime; /b AFTER -> blessed.
    const src = authDef() +
      `func routes() {\n\tr.POST("/a", h)\n\tr.Use(authMiddleware)\n\tr.POST("/b", h2)\n}\n`;
    const rts = await routesOf(src);
    const a = rts.find((r) => r.path === "/a")!;
    const b = rts.find((r) => r.path === "/b")!;
    expect(a.hasAuth).toBe(false);
    expect(b.hasAuth).toBe(true);
  });

  it("receiver isolation: r.Use(<body>) never blesses a sibling api.POST in the same func", async () => {
    const src = authDef() +
      `func routes() {\n\tr.Use(authMiddleware)\n\tr.POST("/blessed", h)\n\tapi.POST("/isolated", h)\n}\n`;
    const rts = await routesOf(src);
    expect(rts.find((r) => r.path === "/blessed")!.hasAuth).toBe(true);
    expect(rts.find((r) => r.path === "/isolated")!.hasAuth).toBe(false);
  });

  it("group scoping: a group Use blesses the group's routes but never the parent sibling", async () => {
    const src = authFactory() +
      `func routes() {\n\tapi := r.Group("/api")\n\tapi.Use(RequireAuth())\n\tapi.POST("/items", h)\n\tr.POST("/public", h)\n}\n`;
    const rts = await routesOf(src);
    expect(rts.find((r) => r.path === "/items")!.hasAuth).toBe(true);
    expect(rts.find((r) => r.path === "/public")!.hasAuth).toBe(false);
  });

  it("parent-to-group propagation is copy-at-creation (both directions)", async () => {
    // Use BEFORE the Group creation blesses the group's routes.
    const before = authDef() +
      `func routes() {\n\tr.Use(authMiddleware)\n\tapi := r.Group("/api")\n\tapi.POST("/items", h)\n}\n`;
    expect((await routesOf(before)).find((r) => r.path === "/items")!.hasAuth).toBe(true);
    // Use AFTER the Group creation does NOT (accepted Gin copy-at-creation semantics).
    const after = authDef() +
      `func routes() {\n\tapi := r.Group("/api")\n\tr.Use(authMiddleware)\n\tapi.POST("/items", h)\n}\n`;
    expect((await routesOf(after)).find((r) => r.path === "/items")!.hasAuth).toBe(false);
  });

  it("nested transitivity: v1 := api.Group inherits an r.Use registered before api", async () => {
    const src = authDef() +
      `func routes() {\n\tr.Use(authMiddleware)\n\tapi := r.Group("/api")\n\tv1 := api.Group("/v1")\n\tv1.POST("/x", h)\n}\n`;
    expect((await routesOf(src)).find((r) => r.path === "/x")!.hasAuth).toBe(true);
  });

  it("Echo group-with-inline-middleware: the LAST arg after the path is a middleware candidate", async () => {
    // e.Group("/admin", authMiddleware) -> the trailing arg (no handler position on
    // a Group call) is the middleware; the in-file rejecting body blesses.
    const src = authDef() +
      `func routes() {\n\tadmin := e.Group("/admin", authMiddleware)\n\tadmin.POST("/users", h)\n}\n`;
    expect((await routesOf(src)).find((r) => r.path === "/users")!.hasAuth).toBe(true);
  });

  it("chi closure SHADOW guard: an inner r.Use never blesses the outer receiver's route", async () => {
    const src = authDef() +
      `func routes() {\n` +
      `\tr.Route("/admin", func(r chi.Router) {\n\t\tr.Use(authMiddleware)\n\t\tr.Post("/users", h)\n\t})\n` +
      `\tr.Post("/public", pub)\n}\n`;
    const rts = await routesOf(src);
    expect(rts.find((r) => r.path === "/users")!.hasAuth).toBe(true);
    expect(rts.find((r) => r.path === "/public")!.hasAuth).toBe(false);
  });

  it("chi closure derivation (positive): an outer Use BEFORE the Route blesses the closure; AFTER does not", async () => {
    const before = authDef() +
      `func routes() {\n\tr.Use(authMiddleware)\n\tr.Route("/admin", func(sub chi.Router) {\n\t\tsub.Post("/x", h)\n\t})\n}\n`;
    expect((await routesOf(before)).find((r) => r.path === "/x")!.hasAuth).toBe(true);
    const after = authDef() +
      `func routes() {\n\tr.Route("/admin", func(sub chi.Router) {\n\t\tsub.Post("/x", h)\n\t})\n\tr.Use(authMiddleware)\n}\n`;
    expect((await routesOf(after)).find((r) => r.path === "/x")!.hasAuth).toBe(false);
  });

  it("cross-function Use never blesses (same-scope pin)", async () => {
    const src = authDef() +
      `func setup(r *gin.Engine) {\n\tr.Use(authMiddleware)\n}\n` +
      `func routes(r *gin.Engine) {\n\tr.POST("/x", h)\n}\n`;
    expect((await routesOf(src)).find((r) => r.path === "/x")!.hasAuth).toBe(false);
  });

  it("same-name groups across functions inherit INDEPENDENTLY (both directions)", async () => {
    const src = authDef() +
      `func first(r *gin.Engine) {\n\tapi := r.Group("/api")\n\tapi.Use(authMiddleware)\n\tapi.POST("/x", h)\n}\n` +
      `func second(r *gin.Engine) {\n\tapi := r.Group("/api")\n\tapi.POST("/y", h)\n}\n`;
    const rts = await routesOf(src);
    // The own-scope mark survives (per-name file-wide poisoning would kill this).
    expect(rts.find((r) => r.path === "/x")!.hasAuth).toBe(true);
    // Scope keying alone isolates the second func (its api has no Use).
    expect(rts.find((r) => r.path === "/y")!.hasAuth).toBe(false);
  });

  it("same-scope rebind poisoning: 2+ bindings of one name in ONE scope never blesses", async () => {
    const src = authDef() +
      `func routes() {\n\tapi := r.Group("/a")\n\tapi.Use(authMiddleware)\n\tapi = r.Group("/b")\n\tapi.POST("/x", h)\n}\n`;
    expect((await routesOf(src)).find((r) => r.path === "/x")!.hasAuth).toBe(false);
  });

  it("conditional Use never marks (never-false-bless); an unconditional Use blesses a conditional route", async () => {
    // Table-driven: each conditional/loop wrapper around the Use suppresses the mark.
    for (const open of ["if cfg.AuthEnabled {", "for i := 0; i < 1; i++ {", "switch x {\n\tcase 1:", "select {\n\tcase <-ch:"]) {
      const close = open.includes("case") ? "\t}" : "}";
      const src = authDef() +
        `func routes() {\n\t${open}\n\t\tr.Use(authMiddleware)\n\t${close}\n\tr.POST("/x", h)\n}\n`;
      const rts = await routesOf(src);
      expect(rts.find((r) => r.path === "/x")!.hasAuth).toBe(false);
    }
    // Positive control: the mark is unconditional; only the ROUTE is conditional.
    const ctrl = authDef() +
      `func routes() {\n\tr.Use(authMiddleware)\n\tif debug {\n\t\tr.POST("/x", h)\n\t}\n}\n`;
    expect((await routesOf(ctrl)).find((r) => r.path === "/x")!.hasAuth).toBe(true);
  });

  it("impure Use arg never marks (null resolution never poisons a later route)", async () => {
    const a = await routesOf(`func routes() {\n\tr.Use(factory.Make(authCfg).Logger())\n\tr.POST("/x", h)\n}\n`);
    expect(a.find((r) => r.path === "/x")!.hasAuth).toBe(false);
    const b = await routesOf(`func routes() {\n\tr.Use(registry.get("authCfg").Logger)\n\tr.POST("/x", h)\n}\n`);
    expect(b.find((r) => r.path === "/x")!.hasAuth).toBe(false);
  });

  it("Gorilla: router.Use(<body>) before a HandleFunc(...).Methods(POST) route blesses it", async () => {
    const src = authDef() +
      `func routes() {\n\trouter.Use(authMiddleware)\n\trouter.HandleFunc("/x", h).Methods("POST")\n}\n`;
    expect((await routesOf(src)).find((r) => r.path === "/x")!.hasAuth).toBe(true);
  });

  it("non-router receiver gate on Use: a Use on a non-router receiver blesses nothing", async () => {
    const src = authDef() +
      `func routes() {\n\tq.Use(authMiddleware)\n\tr.POST("/x", h)\n}\n`;
    const rt = (await routesOf(src)).find((r) => r.path === "/x")!;
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("lanes via Use: rate-limit and validation propagate independently, no auth cross-set", async () => {
    const rate = await routesOf(`func routes() {\n\tr.Use(middleware.RateLimiter(rate))\n\tr.POST("/x", h)\n}\n`);
    const rr = rate.find((r) => r.path === "/x")!;
    expect(rr.hasRateLimit).toBe(true);
    expect(rr.hasValidation).toBe(false);
    expect(rr.hasAuth).toBe(false);
    const val = await routesOf(`func routes() {\n\tr.Use(RequestValidator())\n\tr.POST("/x", h)\n}\n`);
    const vr = val.find((r) => r.path === "/x")!;
    expect(vr.hasValidation).toBe(true);
    expect(vr.hasRateLimit).toBe(false);
    expect(vr.hasAuth).toBe(false);
  });
});

describe("Use scoping unsure state (imported / opaque hooks hedge, never bless)", () => {
  it("imported non-core Use hook hedges the scope's routes", async () => {
    const [rt] = await routesOf(`func routes() {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", h)\n}\n`);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBe("middleware.VerifyToken");
  });

  it("group-scope unsure inherits to the group's routes but not the parent sibling", async () => {
    const src =
      `func routes() {\n\tapi := r.Group("/api")\n\tapi.Use(middleware.VerifyToken)\n\tapi.POST("/items", h)\n\tr.POST("/public", h)\n}\n`;
    const rts = await routesOf(src);
    const items = rts.find((r) => r.path === "/items")!;
    expect(items.hasAuth).toBe(false);
    expect(items.authUnsureHook).toBe("middleware.VerifyToken");
    const pub = rts.find((r) => r.path === "/public")!;
    expect(pub.hasAuth).toBe(false);
    expect(pub.authUnsureHook).toBeUndefined();
  });

  it("in-file OPAQUE-body Use hook hedges (auth-flavored unresolved callee, non-core name)", async () => {
    // tokenGuard: auth-flavored ("token"), NOT vetoed, body opaque (checkSession
    // undefined -> auth-flavored unresolved callee -> opaque, rule 4 unsure).
    const src =
      `func tokenGuard(c *gin.Context) { if !checkSession(c) { c.Next(); return }; c.Next() }\n` +
      `func routes() {\n\tr.Use(tokenGuard)\n\tr.POST("/x", h)\n}\n`;
    const [rt] = await routesOf(src);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBe("tokenGuard");
  });

  it("auth beats unsure in scope (a confirmed auth mark wins, key absent)", async () => {
    const src = authFactory() +
      `func routes() {\n\tr.Use(RequireAuth())\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", h)\n}\n`;
    const [rt] = await routesOf(src);
    expect(rt.hasAuth).toBe(true);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("per-route auth clears scope unsure", async () => {
    const src = authFactory() +
      `func routes() {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", RequireAuth(), h)\n}\n`;
    const [rt] = await routesOf(src);
    expect(rt.hasAuth).toBe(true);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("deterministic attribution: two unsure Use hooks -> FIRST in document order", async () => {
    const src =
      `func routes() {\n\tr.Use(middleware.VerifyToken)\n\tr.Use(middleware.CheckToken)\n\tr.POST("/x", h)\n}\n`;
    const [rt] = await routesOf(src);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBe("middleware.VerifyToken");
  });

  it("imported NON-flavored Use hook: not-auth flat, key ABSENT (zero evidence never hedges)", async () => {
    const [rt] = await routesOf(`func routes() {\n\tr.Use(middleware.RequestID)\n\tr.POST("/x", h)\n}\n`);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });
});

describe("extractGoFileMiddlewareAst (file-level OR of confirmed lanes)", () => {
  const NONE = { hasAuth: false, hasValidation: false, hasRateLimit: false };
  const mwIndex = async (src: string) => {
    const f = await go("mw.go", PKG + src);
    expect(f.tree!.rootNode.hasError).toBe(false);
    return extractGoFileMiddlewareAst(f.tree!);
  };

  it("r.Use(<in-file body>) -> hasAuth true", async () => {
    expect(await mwIndex(authDef() + `func routes() {\n\tr.Use(authMiddleware)\n}\n`))
      .toEqual({ hasAuth: true, hasValidation: false, hasRateLimit: false });
  });

  it("a derived group's Use ORs into the file-level index", async () => {
    expect(await mwIndex(authFactory() + `func routes() {\n\tapi := r.Group("/api")\n\tapi.Use(RequireAuth())\n}\n`))
      .toEqual({ hasAuth: true, hasValidation: false, hasRateLimit: false });
  });

  it("inline group middleware ORs into the file-level index", async () => {
    expect(await mwIndex(authDef() + `func routes() {\n\tadmin := e.Group("/admin", authMiddleware)\n}\n`))
      .toEqual({ hasAuth: true, hasValidation: false, hasRateLimit: false });
  });

  it("python-parity: a per-route middleware arg is NOT a file-level bless", async () => {
    expect(await mwIndex(authFactory() + `func routes() {\n\tr.POST("/x", RequireAuth(), h)\n}\n`)).toEqual(NONE);
  });

  it("UNSURE never launders into the OR (never-false-bless)", async () => {
    expect(await mwIndex(`func routes() {\n\tr.Use(middleware.VerifyToken)\n}\n`)).toEqual(NONE);
  });

  it("unknown Use name / empty / comments-only -> NONE", async () => {
    expect(await mwIndex(`func routes() {\n\tr.Use(track())\n}\n`)).toEqual(NONE);
    expect(await mwIndex(`func routes() {}\n`)).toEqual(NONE);
    expect(await mwIndex(`// just a comment\nfunc routes() {}\n`)).toEqual(NONE);
  });
});

// ─── Task 6: adversarial hardening ──────────────────────────────────────────
//
// Every fixture here is fed straight to extractGoRoutesAst / extractGoFileMiddlewareAst
// on whatever tree tree-sitter produces (error-recovered or clean). The bar is
// twofold: the extractor must never THROW on hostile input, and it must never emit
// a route with hasAuth:true that the source does not actually protect. The
// security-critical member of this group is the fused Use call: an unterminated
// r.Use(...) that error recovery FUSES with the following route registrations into
// one errored region. Blessing, or even extracting, out of that fused region would
// let a broken middleware call silently protect routes it never actually wired.
describe("malformed and adversarial input", () => {
  it("CROSS-BLESS GUARD: an unterminated r.Use(...) fuses with the following routes; the region emits NOTHING and blesses nothing", async () => {
    // PINNED EXACT SOURCE (probe-verified against the shipped tree-sitter-go
    // grammar): the missing close-paren on r.Use fuses the Use call with BOTH
    // POST registrations into one errored subtree. An unterminated Use can never
    // become auth for anything — the cross-bless guard this test pins.
    const f = await go("fuseduse.go",
      PKG + `func routes() {\n\tr.Use(authMiddleware\n\tr.POST("/a", createA)\n\tr.POST("/b", createB)\n}\n`);
    expect(f.tree!.rootNode.hasError).toBe(true);
    expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
    expect(extractGoFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: false, hasValidation: false, hasRateLimit: false });
  });

  it("unclosed paren in a route call swallows the next valid registration; no throw, nothing emitted from the errored region", async () => {
    // Probe-verified: error recovery nests `r.GET("/later", h)` INSIDE the broken
    // POST call's own argument_list as a clean-looking nested call_expression.
    // Both calls sit under a hasError ancestor, so the ancestor-error walk skips
    // both. Detect-level recall (the regex fallback recovering /later) is pinned
    // separately in security-consistency.test.ts.
    const f = await go("unclosedcall.go",
      PKG + `func routes() {\n\tr.POST("/broken", mw, h\n\tr.GET("/later", h)\n}\n`);
    expect(f.tree!.rootNode.hasError).toBe(true);
    expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("surgical per-node skip: an error confined to one function body never suppresses a clean sibling function's route", async () => {
    // `x := := 1` breaks `bad`'s body only; `good`'s r.POST("/good", h) parses
    // clean. The ancestor-error walk stops below source_file, so the sibling
    // function is unaffected — a per-construct skip, not a whole-file one.
    const f = await go("surgical.go",
      PKG + `func bad() {\n\tx := := 1\n\t_ = x\n}\n\nfunc good() {\n\tr.POST("/good", h)\n}\n`);
    expect(f.tree!.rootNode.hasError).toBe(true); // cumulative at the file level
    expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractGoRoutesAst(f.tree!, f.relativePath).map((r) => `${r.method} ${r.path}`))
      .toEqual(["POST /good"]);
  });

  it("unterminated string in a route path: no throw, no route from the fused region", async () => {
    const f = await go("unclosedstring.go",
      PKG + `func routes() {\n\tr.POST("/oops, handler)\n\tr.GET("/later", h)\n}\n`);
    expect(f.tree!.rootNode.hasError).toBe(true);
    expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("garbled binary-ish content, empty file, and comments-only file: [] routes, all-false middleware, no throw", async () => {
    for (const src of [` \x00\x01 garbage {{{ func ( `, ``, `// just a comment\n/* block */\n`]) {
      const f = await go("garbled.go", src);
      expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
      expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
      expect(() => extractGoFileMiddlewareAst(f.tree!)).not.toThrow();
      expect(extractGoFileMiddlewareAst(f.tree!)).toEqual({ hasAuth: false, hasValidation: false, hasRateLimit: false });
    }
  });

  it("routes written inside comments or string literals do not extract", async () => {
    const f = await go("stringroutes.go",
      PKG +
      `func routes() {\n` +
      `\t// r.POST("/fake", h)\n` +
      `\t/* r.POST("/fake2", h) */\n` +
      `\ts := \`r.POST("/fake3", h)\`\n` +
      `\tdoc := "r.POST(\\"/fake4\\", h)"\n` +
      `\t_ = s\n\t_ = doc\n}\n`);
    expect(f.tree!.rootNode.hasError).toBe(false);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  describe("unicode", () => {
    it("a unicode path with real in-file auth blesses normally (positive control)", async () => {
      const src = PKG + authDef() + `func routes() {\n\tr.Use(authMiddleware)\n\tr.POST("/café", h)\n}\n`;
      const f = await go("unicodepath.go", src);
      const routes = extractGoRoutesAst(f.tree!, f.relativePath);
      expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual(["POST /café auth=true"]);
    });

    it("a unicode Use argument never blesses (ASCII lexicon: recognition miss, never a bless)", async () => {
      const f = await go("unicodeuse.go", PKG + `func routes() {\n\tr.Use(認証)\n\tr.POST("/x", h)\n}\n`);
      const [rt] = extractGoRoutesAst(f.tree!, f.relativePath);
      expect(rt.hasAuth).toBe(false);
      expect(rt.authUnsureHook).toBeUndefined();
    });

    it("a unicode receiver does not extract", async () => {
      const f = await go("unicoderecv.go", PKG + `func routes() {\n\tルーター.POST("/x", h)\n}\n`);
      expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
    });
  });

  it("20-deep nested wrap: no throw, no bless (re-asserted from Task 3 inside the adversarial totality)", async () => {
    let expr = "h";
    for (let i = 0; i < 20; i++) expr = `logWrap(${expr})`;
    const f = await go("deepwrap.go", PKG + `func routes() {\n\tmux.Handle("/x", ${expr})\n}\n`);
    expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractGoRoutesAst(f.tree!, f.relativePath)[0].hasAuth).toBe(false);
  });

  it("no-throw totality: extractGoRoutesAst and extractGoFileMiddlewareAst never throw across every adversarial fixture", async () => {
    const sources = [
      PKG + `func routes() {\n\tr.Use(authMiddleware\n\tr.POST("/a", createA)\n\tr.POST("/b", createB)\n}\n`,
      PKG + `func routes() {\n\tr.POST("/broken", mw, h\n\tr.GET("/later", h)\n}\n`,
      PKG + `func bad() {\n\tx := := 1\n\t_ = x\n}\n\nfunc good() {\n\tr.POST("/good", h)\n}\n`,
      PKG + `func routes() {\n\tr.POST("/oops, handler)\n\tr.GET("/later", h)\n}\n`,
      ` \x00\x01 garbage {{{ func ( `,
      ``,
      `// just a comment\n/* block */\n`,
      PKG + `func routes() {\n\tr.Use(認証)\n\tr.POST("/x", h)\n}\n`,
      PKG + `func routes() {\n\tルーター.POST("/x", h)\n}\n`,
    ];
    for (const src of sources) {
      const f = await go("totality.go", src);
      expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
      expect(() => extractGoFileMiddlewareAst(f.tree!)).not.toThrow();
    }
  });
});

// ─── Task 6: documented trade-offs (collected pins, never change behavior) ───
//
// Consolidates the deliberate divergences this module carries, whether pinned
// earlier (referenced by comment, not re-derived) or new to this task. Nothing
// here is a false-bless: every item resolves to a documented UNDER-report, a
// documented receiver-granularity OVER-bless (mirroring the Python module's own
// accepted exposure), or a plain recognition miss.
describe("Task 6: documented trade-offs", () => {
  it("re-pins already-locked recognition trade-offs in one place (Tasks 1-2, unchanged)", async () => {
    // .Methods("MKCOL") -> GET (fully literal, zero recognized verbs is not
    // ambiguity; see the full pin at "method resolution" > mkcol parity).
    const mkcol = await go("mkcol.go", PKG + `func routes() {\n\trouter.HandleFunc("/x", h).Methods("MKCOL")\n}\n`);
    expect(extractGoRoutesAst(mkcol.tree!, mkcol.relativePath).map((r) => r.method)).toEqual(["GET"]);
    // A chain split across statements resolves ALL (variable-carried chains are
    // not tracked); see "Gorilla mux and stdlib recognition" for the full pin.
    const split = await go("split.go", PKG + `func routes() {\n\troute := r.HandleFunc("/orders", h)\n\troute.Methods("POST")\n}\n`);
    expect(extractGoRoutesAst(split.tree!, split.relativePath).map((r) => r.method)).toEqual(["ALL"]);
    // e.Match(...) (composite-literal method list) is not a recognized anchor.
    const match = await go("match.go", PKG + `func routes() {\n\te.Match([]string{"GET"}, "/x", h)\n}\n`);
    expect(extractGoRoutesAst(match.tree!, match.relativePath)).toEqual([]);
    // Gorilla route-builder chains (HandlerFunc/Handler as the OUTER, registering
    // field) are never unwound; see "documented trade-offs (pinned recall gaps..."
    const builder = await go("builder.go", PKG + `func routes() {\n\tr.Methods("POST").Path("/orders").HandlerFunc(h)\n}\n`);
    expect(extractGoRoutesAst(builder.tree!, builder.relativePath)).toEqual([]);
    // Embedded-engine method receivers are not recognized (no struct field walk).
    const embedded = await go("embedded.go",
      PKG + `type Server struct {\n\t*gin.Engine\n}\n\nfunc (s *Server) routes() {\n\ts.POST("/orders", h)\n}\n`);
    expect(extractGoRoutesAst(embedded.tree!, embedded.relativePath)).toEqual([]);
  });

  it("re-pins already-locked scope/lane trade-offs in one place (Task 4, unchanged)", async () => {
    // Echo trailing single middleware -> false: the module always treats the
    // LAST arg as the handler, so a REAL rejecting middleware placed after the
    // handler (Echo's own m ...MiddlewareFunc order) is invisible to the
    // classifier — never even hedged, a structural recall gap, never a bless.
    const echoTrail = await go("echotrail.go",
      PKG +
      `func RequireAuth(c echo.Context) error {\n\tif c.Request().Header.Get("Authorization") == "" {\n\t\treturn c.NoContent(401)\n\t}\n\treturn nil\n}\n` +
      `func routes() {\n\te.POST("/x", h, RequireAuth)\n}\n`);
    const [et] = extractGoRoutesAst(echoTrail.tree!, echoTrail.relativePath);
    expect(et.hasAuth).toBe(false);
    expect(et.authUnsureHook).toBeUndefined();
    // Composed wrap chain(logger, auth)(h): the outer call's function is itself
    // a call, so it never resolves to a NAME; the wrap-recursion gate requires
    // name===null OR a transparent wrap, and the inner (logger, auth) pair is
    // arity>=2 (DI), so recursion never reaches "auth".
    const composed = await go("composed.go", PKG + `func routes() {\n\tmux.Handle("/x", chain(logger, auth)(h))\n}\n`);
    expect(extractGoRoutesAst(composed.tree!, composed.relativePath)[0].hasAuth).toBe(false);
    // Cross-function Use never blesses (same-scope pin: Use is keyed to its own
    // enclosing function body, never file-wide).
    const cross = await go("cross.go",
      PKG + authDef() + `func setup(r *gin.Engine) {\n\tr.Use(authMiddleware)\n}\nfunc routes(r *gin.Engine) {\n\tr.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(cross.tree!, cross.relativePath)[0].hasAuth).toBe(false);
    // Conditional Use (`if cfg.AuthEnabled { r.Use(auth) }`) never marks:
    // statically-ambiguous registration resolves false, never a bless.
    const conditional = await go("conditional.go",
      PKG + authDef() + `func routes() {\n\tif cfg.AuthEnabled {\n\t\tr.Use(authMiddleware)\n\t}\n\tr.POST("/x", h)\n}\n`);
    expect(extractGoRoutesAst(conditional.tree!, conditional.relativePath)[0].hasAuth).toBe(false);
    // Gin copy-at-creation: a parent Use registered AFTER a Group's creation call
    // does not retroactively bless the group (accepted Gin runtime semantics).
    const afterGroup = await go("aftergroup.go",
      PKG + authDef() + `func routes() {\n\tapi := r.Group("/api")\n\tr.Use(authMiddleware)\n\tapi.POST("/items", h)\n}\n`);
    expect(extractGoRoutesAst(afterGroup.tree!, afterGroup.relativePath)
      .find((r) => r.path === "/items")!.hasAuth).toBe(false);
  });

  it("HEAD/OPTIONS are never extracted on ANY resolution path (verb field, .Methods chain, verb-first, Go 1.22 pattern)", async () => {
    const f = await go("headoptions.go",
      PKG +
      `func routes() {\n` +
      `\tr.HEAD("/a", h)\n` +
      `\tr.OPTIONS("/b", h)\n` +
      `\trouter.HandleFunc("/c", h).Methods("HEAD")\n` +
      `\trouter.HandleFunc("/d", h).Methods("OPTIONS")\n` +
      `\tr.Method("HEAD", "/e", h)\n` +
      `\te.Add("OPTIONS", "/f", h)\n` +
      `\tmux.HandleFunc("HEAD /g", h)\n` +
      `\tmux.HandleFunc("OPTIONS /h", h)\n` +
      `}\n`);
    expect(extractGoRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("a handler body calling c.ShouldBindJSON does NOT set hasValidation (validation lane is name-based only)", async () => {
    const f = await go("bindjson.go",
      PKG + `func h(c *gin.Context) {\n\tvar body Order\n\tc.ShouldBindJSON(&body)\n}\nfunc routes() {\n\tr.POST("/x", h)\n}\n`);
    const [rt] = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(rt.hasValidation).toBe(false);
  });

  it("single-arg DI residual NewHandler(auth.NewService(key)): the 'handler' veto segment closes this before recursion, never blesses", async () => {
    // Pre-LOCKED plan carried this as an open false-bless exposure. The shipped
    // veto set includes the "handler" segment specifically to close it: the
    // outer name resolves not-auth at rule 1 and, being a NAMED (non-transparent)
    // outer, wrap recursion into auth.NewService(key) never runs.
    const f = await go("dihandler.go", PKG + `func routes() {\n\tmux.Handle("/x", NewHandler(auth.NewService(key)))\n}\n`);
    const [rt] = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("a selector/method Use callee (authSvc.Middleware) stays opaque/name-tier: v1 resolves only bare-identifier callees to an in-file body", async () => {
    // authSvc.Middleware is an in-file METHOD with a real rejecting body, but
    // classifyGoMiddlewareArg only resolves a bare-identifier callee to a def;
    // a selector target is never looked up, so it stays name-tier. "authSvc"
    // segments to auth+svc, which is flavored, so the recall gap surfaces as an
    // UNSURE hedge, never a silent drop and never a bless.
    const f = await go("selectormw.go",
      PKG +
      `type AuthSvc struct{}\nfunc (a *AuthSvc) Middleware(c *gin.Context) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(401)\n\t\treturn\n\t}\n\tc.Next()\n}\n` +
      `func routes() {\n\tr.Use(authSvc.Middleware)\n\tr.POST("/x", h)\n}\n`);
    const [rt] = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBe("authSvc.Middleware");
  });

  it("KNOWN receiver-granularity OVER-BLESS: a partial-guard middleware blesses its WHOLE receiver, including the path it exempts", async () => {
    // mw exempts /exempt via `if isPublic(...) { c.Next(); return }` and then
    // credential-guards the rest with a real 401. bodyAuthSignatureGo sees a
    // verified reject SOMEWHERE in the body (rule 2) and blesses the receiver at
    // Use-scope granularity — it does not model per-branch exemptions. This
    // mirrors the Python module's own accepted receiver-level over-bless.
    // ACCEPTED VERDICT: NOT asserted authed:false — this is a recorded trade-off,
    // not a regression to fix here (see open question 3 in the module header).
    const f = await go("partialguard.go",
      PKG +
      `func mw(c *gin.Context) {\n\tif isPublic(c.Request.URL.Path) {\n\t\tc.Next()\n\t\treturn\n\t}\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\treturn\n\t}\n\tc.Next()\n}\n` +
      `func routes() {\n\tr.Use(mw)\n\tr.GET("/exempt", h)\n\tr.POST("/protected", h)\n}\n`);
    const routes = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(routes.find((r) => r.path === "/protected")!.hasAuth).toBe(true);
    // The exempted route is blessed too — the documented over-bless.
    expect(routes.find((r) => r.path === "/exempt")!.hasAuth).toBe(true);
  });

  it("a variable-status abort under a boring name resolves opaque -> not-auth (no flavored delegation, key absent)", async () => {
    const f = await go("varstatus.go",
      PKG + `func mw(c *gin.Context) {\n\tc.AbortWithStatus(code)\n}\nfunc routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`);
    const [rt] = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });

  it("AUDIT NOTE: the pre-LOCKED chi jwtauth.Verifier and single-arg-DI 'known false-bless exposures' described by the original task plan do NOT reproduce against the shipped LOCKED classifier", async () => {
    // r.Use(jwtauth.Verifier(tokenAuth)): "jwtauth.Verifier" is a resolved,
    // non-null, non-transparent NAME (a pure selector chain), so the wrap
    // recursion gate (name===null || transparent) never fires and the inner
    // "tokenAuth" (which WOULD be CORE-flavored) is never inspected. This
    // fixture is pinned here as a plain never-false-bless entry (also present
    // in NEVER_FALSE_BLESS_SWEEP_GO) rather than as a "known exposure": the
    // module's own header already documents this restriction as CLOSING the
    // chi jwtauth.Verifier / config-object / arity-1-DI exposures the
    // pre-LOCKED name-only plan carried.
    const f = await go("jwtauthverifier.go",
      PKG + `func routes() {\n\tr.Use(jwtauth.Verifier(tokenAuth))\n\tr.POST("/x", h)\n}\n`);
    const [rt] = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(rt.hasAuth).toBe(false);
    expect(rt.authUnsureHook).toBeUndefined();
  });
});

// ─── Task 6: never-false-bless sweep ─────────────────────────────────────────
//
// Registry of every ambiguous / opaque / unresolvable Go fixture class from
// Tasks 1-5. Every NEW go fixture added in a later task MUST be registered
// here (verbatim Phase A mechanism, mirroring the shipped JS/Python modules).
// `groundTruth` entries with `authed: true` are DOCUMENTATION ONLY (the sweep
// loop below only checks `authed: false` entries) — they exist so a reader can
// see the authed positive control sitting next to its unauthed sibling.
const NEVER_FALSE_BLESS_SWEEP_GO: Array<{
  name: string; source: string; groundTruth: Array<{ path: string; method: string; authed: boolean }>;
}> = [
  {
    name: "unknown-middleware-middle-arg",
    source: PKG + `func routes() {\n\tr.POST("/x", track(), h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "wrapped-unknown-callee",
    source: PKG + `func routes() {\n\tmux.Handle("/x", wrap(h)).Methods("POST")\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "use-package-qualified-unknown-nonflavored",
    source: PKG + `func routes() {\n\tr.Use(middleware.RequestID)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "use-after-route",
    source: PKG + authDef() + `func routes() {\n\tr.POST("/a", h)\n\tr.Use(authMiddleware)\n\tr.POST("/b", h2)\n}\n`,
    groundTruth: [
      { path: "/a", method: "POST", authed: false },
      { path: "/b", method: "POST", authed: true }, // doc: registered after Use, genuinely blessed
    ],
  },
  {
    name: "use-cross-function",
    source: PKG + authDef() + `func setup(r *gin.Engine) {\n\tr.Use(authMiddleware)\n}\nfunc routes(r *gin.Engine) {\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "chi-closure-shadow",
    source: PKG + authDef() +
      `func routes() {\n\tr.Route("/admin", func(r chi.Router) {\n\t\tr.Use(authMiddleware)\n\t\tr.Post("/users", h)\n\t})\n\tr.Post("/public", pub)\n}\n`,
    groundTruth: [
      { path: "/public", method: "POST", authed: false },
      { path: "/users", method: "POST", authed: true }, // doc: inner closure scope, genuinely blessed
    ],
  },
  {
    name: "group-use-never-blesses-parent",
    source: PKG + authFactory() +
      `func routes() {\n\tapi := r.Group("/api")\n\tapi.Use(RequireAuth())\n\tapi.POST("/items", h)\n\tr.POST("/public", h)\n}\n`,
    groundTruth: [
      { path: "/public", method: "POST", authed: false },
      { path: "/items", method: "POST", authed: true }, // doc
    ],
  },
  {
    name: "parent-use-after-group-creation",
    source: PKG + authDef() + `func routes() {\n\tapi := r.Group("/api")\n\tr.Use(authMiddleware)\n\tapi.POST("/items", h)\n}\n`,
    groundTruth: [{ path: "/items", method: "POST", authed: false }],
  },
  {
    name: "same-scope-rebind-poisoning",
    source: PKG + authDef() + `func routes() {\n\tapi := r.Group("/a")\n\tapi.Use(authMiddleware)\n\tapi = r.Group("/b")\n\tapi.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "same-name-groups-independent",
    source: PKG + authDef() +
      `func first(r *gin.Engine) {\n\tapi := r.Group("/api")\n\tapi.Use(authMiddleware)\n\tapi.POST("/x", h)\n}\n` +
      `func second(r *gin.Engine) {\n\tapi := r.Group("/api")\n\tapi.POST("/y", h)\n}\n`,
    groundTruth: [
      { path: "/x", method: "POST", authed: true }, // doc: paired own-scope positive control
      { path: "/y", method: "POST", authed: false },
    ],
  },
  {
    name: "conditional-use",
    source: PKG + authDef() + `func routes() {\n\tif cfg.AuthEnabled {\n\t\tr.Use(authMiddleware)\n\t}\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "di-constructor-injection-webhook",
    source: PKG + `func routes() {\n\tmux.Handle("/webhook", NewWebhookHandler(cfg, auth.NewService(key)))\n}\n`,
    groundTruth: [{ path: "/webhook", method: "ALL", authed: false }],
  },
  {
    name: "di-constructor-injection-orders",
    source: PKG + `func routes() {\n\tmux.Handle("/orders", NewOrdersHandler(db, jwtVerifier()))\n}\n`,
    groundTruth: [{ path: "/orders", method: "ALL", authed: false }],
  },
  {
    name: "impure-selector-use",
    source: PKG + `func routes() {\n\tr.Use(factory.Make(authCfg).Logger())\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "impure-selector-bare-arg",
    source: PKG + `func routes() {\n\tr.Use(registry.get("authCfg").Logger)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "builder-chain-wrap",
    source: PKG + `func routes() {\n\tmux.Handle("/x", handlers.For(authConfig).Build(h))\n}\n`,
    groundTruth: [{ path: "/x", method: "ALL", authed: false }],
  },
  {
    name: "with-chain-no-auth",
    source: PKG + `func routes() {\n\tr.With(paginate).With(audit).Post("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "author-segmentation-use",
    source: PKG + `func routes() {\n\tr.Use(AuthorMiddleware)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "author-segmentation-middle-arg",
    source: PKG + `func routes() {\n\tr.POST("/y", AuthorTracking(), h)\n}\n`,
    groundTruth: [{ path: "/y", method: "POST", authed: false }],
  },
  {
    name: "echo-trailing-middleware",
    source: PKG +
      `func RequireAuth(c echo.Context) error {\n\tif c.Request().Header.Get("Authorization") == "" {\n\t\treturn c.NoContent(401)\n\t}\n\treturn nil\n}\n` +
      `func routes() {\n\te.POST("/x", h, RequireAuth)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "handler-position-identifier",
    source: PKG + `func routes() {\n\tr.POST("/login", authLogin)\n}\n`,
    groundTruth: [{ path: "/login", method: "POST", authed: false }],
  },
  {
    name: "handler-position-401-body",
    source: PKG +
      `func h(c *gin.Context) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(401)\n\t\treturn\n\t}\n\tc.JSON(200, nil)\n}\n` +
      `func routes() {\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "unicode-auth-middleware",
    source: PKG + `func routes() {\n\tr.Use(認証)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "stdlib-bare",
    source: PKG + `func routes() {\n\thttp.HandleFunc("/orders", h)\n}\n`,
    groundTruth: [{ path: "/orders", method: "ALL", authed: false }],
  },
  {
    name: "verb-first-unknown-middleware",
    source: PKG + `func routes() {\n\tr.Handle("POST", "/x", metrics(), h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "composed-wrap",
    source: PKG + `func routes() {\n\tmux.Handle("/x", chain(logger, auth)(h))\n}\n`,
    groundTruth: [{ path: "/x", method: "ALL", authed: false }],
  },
  {
    name: "subsuming-veto-wrap-set",
    source: PKG +
      `func realGate(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tif r.Header.Get("Authorization") == "" {\n\t\t\tw.WriteHeader(http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n` +
      `func requireAuth(next http.Handler) http.Handler {\n\treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n\t\tif r.Header.Get("Authorization") == "" {\n\t\t\tw.WriteHeader(http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tnext.ServeHTTP(w, r)\n\t})\n}\n` +
      `func routes() {\n\tmux.Handle("/a", optionalAuth(realGate))\n\tmux.Handle("/b", SkipAuth(realGate))\n\tmux.Handle("/c", DisableAuthInDev(realGate))\n\tmux.Handle("/d", parseJWT(realGate))\n\tmux.Handle("/e", logRequests(requireAuth(h)))\n}\n`,
    groundTruth: [
      { path: "/a", method: "ALL", authed: false },
      { path: "/b", method: "ALL", authed: false },
      { path: "/c", method: "ALL", authed: false },
      { path: "/d", method: "ALL", authed: false },
      { path: "/e", method: "ALL", authed: true }, // doc: transparent-vs-subsuming positive control
    ],
  },
  {
    name: "broken-parse-fused-use",
    source: PKG + `func routes() {\n\tr.Use(authMiddleware\n\tr.POST("/a", createA)\n\tr.POST("/b", createB)\n}\n`,
    groundTruth: [
      { path: "/a", method: "POST", authed: false }, // non-emission: a dropped route cannot false-bless
      { path: "/b", method: "POST", authed: false },
    ],
  },
  {
    name: "broken-parse-swallowed-route",
    source: PKG + `func routes() {\n\tr.POST("/broken", mw, h\n\tr.GET("/later", h)\n}\n`,
    groundTruth: [{ path: "/later", method: "GET", authed: false }], // non-emission
  },

  // ── BODY-FIRST required entries (all authed:false) ──
  {
    name: "visible-non-enforcing-body-use",
    source: PKG +
      `func authCheck(c *gin.Context) {\n\tlog.Printf("auth %s", c.Request.URL.Path)\n\tc.Next()\n}\n` +
      `func routes() {\n\tr.Use(authCheck)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "visible-non-enforcing-body-middle-arg",
    source: PKG +
      `func authCheck(c *gin.Context) {\n\tlog.Printf("auth %s", c.Request.URL.Path)\n\tc.Next()\n}\n` +
      `func routes() {\n\tr.POST("/y", authCheck, h)\n}\n`,
    groundTruth: [{ path: "/y", method: "POST", authed: false }],
  },
  {
    name: "logging-mw",
    source: PKG + `func logMiddleware(c *gin.Context) {\n\tlog.Printf("request")\n\tc.Next()\n}\nfunc routes() {\n\tr.Use(logMiddleware)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "metrics-mw",
    source: PKG + `func metricsMiddleware(c *gin.Context) {\n\tmetrics.Inc("req")\n\tc.Next()\n}\nfunc routes() {\n\tr.Use(metricsMiddleware)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "header-set-only-mw",
    source: PKG + `func securityHeaders(c *gin.Context) {\n\tc.Header("X-Frame-Options", "DENY")\n\tc.Next()\n}\nfunc routes() {\n\tr.Use(securityHeaders)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "passthru-mw",
    source: PKG + `func passthru(c *gin.Context) {\n\tc.Next()\n}\nfunc routes() {\n\tr.Use(passthru)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "abort-404-mw",
    source: PKG + `func mw(c *gin.Context) {\n\tc.AbortWithStatus(http.StatusNotFound)\n}\nfunc routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "abort-500-mw",
    source: PKG + `func mw(c *gin.Context) {\n\tc.AbortWithStatus(http.StatusInternalServerError)\n}\nfunc routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "bare-403-mw",
    source: PKG + `func mw(c *gin.Context) {\n\tc.AbortWithStatus(http.StatusForbidden)\n}\nfunc routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "path-filter-403-mw",
    source: PKG +
      `func pathFilter(c *gin.Context) {\n\tif strings.HasPrefix(c.Request.URL.Path, "/admin") {\n\t\tc.AbortWithStatus(403)\n\t}\n}\n` +
      `func routes() {\n\tr.Use(pathFilter)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "bot-gate-403-mw",
    // Finding 4: MUST actually read User-Agent so the "agent" key veto is
    // proven non-vacuously (a fixture that dodges User-Agent passes trivially).
    source: PKG +
      `func botGate(c *gin.Context) {\n\tif c.GetHeader("User-Agent") == "" {\n\t\tc.AbortWithStatus(403)\n\t\treturn\n\t}\n}\n` +
      `func routes() {\n\tr.Use(botGate)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "csrf-403-mw",
    source: PKG +
      `func csrfCheck(c *gin.Context) {\n\tif c.GetHeader("X-CSRF-Token") != valid {\n\t\tc.AbortWithStatus(403)\n\t}\n}\n` +
      `func routes() {\n\tr.Use(csrfCheck)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "query-param-get-403-mw",
    // Finding 2: Query().Get's operand is a CALL, not a GO_CRED_GET_RECEIVERS
    // identifier, so it is not a credential read and must not bless.
    source: PKG +
      `func mw(c *gin.Context) {\n\tif c.Request.URL.Query().Get("token") == "" {\n\t\tc.AbortWithStatus(403)\n\t\treturn\n\t}\n}\n` +
      `func routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "cache-get-403-mw",
    source: PKG +
      `func mw(c *gin.Context) {\n\tif cache.Get("user") == nil {\n\t\tc.AbortWithStatus(403)\n\t\treturn\n\t}\n}\n` +
      `func routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "store-get-403-mw",
    source: PKG +
      `func mw(c *gin.Context) {\n\tif store.Get("session") == nil {\n\t\tc.AbortWithStatus(403)\n\t\treturn\n\t}\n}\n` +
      `func routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "credential-read-but-unrelated-403-guard-mw",
    source: PKG +
      `func mw(c *gin.Context) {\n\ttoken := c.GetHeader("Authorization")\n\tlog.Printf("token seen: %v", token != "")\n\tif !featureEnabled {\n\t\tc.AbortWithStatus(403)\n\t\treturn\n\t}\n\tc.Next()\n}\n` +
      `func routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "status-variable-mw",
    source: PKG + `func mw(c *gin.Context) {\n\tc.AbortWithStatus(code)\n}\nfunc routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "returned-non-executed-closure-reject",
    source: PKG + `func mw(c *gin.Context) {\n\tgo func() {\n\t\tc.AbortWithStatus(401)\n\t}()\n\tc.Next()\n}\nfunc routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "veto-over-reject-set",
    source: PKG +
      ["OptionalAuth", "SkipAuth", "DisableAuth", "InsecureSkipAuth", "MockAuth", "testAuth"]
        .map((n) => `func ${n}(c *gin.Context) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\treturn\n\t}\n\tc.Next()\n}\n`)
        .join("") +
      `func routes() {\n` +
      ["OptionalAuth", "SkipAuth", "DisableAuth", "InsecureSkipAuth", "MockAuth", "testAuth"]
        .map((n, i) => `\tr.Use(${n})\n\tr.POST("/v${i}", h${i})\n`).join("") +
      `}\n`,
    groundTruth: [0, 1, 2, 3, 4, 5].map((i) => ({ path: `/v${i}`, method: "POST", authed: false })),
  },
  {
    name: "authlogger-veto",
    source: PKG + `func routes() {\n\tr.POST("/x", authLogger, h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "parsejwt-veto",
    source: PKG + `func routes() {\n\tr.POST("/x", parseJWT(secret), h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "newauthhandler-wrap-veto",
    source: PKG + `func routes() {\n\tmux.Handle("/x", newAuthHandler(deps))\n}\n`,
    groundTruth: [{ path: "/x", method: "ALL", authed: false }],
  },
  {
    name: "authlogin-middle-arg-veto",
    source: PKG + `func routes() {\n\tr.POST("/x", authLogin, mainHandler)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },

  // ── Pre-LOCKED-plan exposures that do NOT reproduce (verified: see the
  // "AUDIT NOTE" documented-trade-offs pin above) — pinned as plain
  // never-false-bless entries, not as accepted over-blesses. ──
  {
    name: "jwtauth-verifier-wrap",
    source: PKG + `func routes() {\n\tr.Use(jwtauth.Verifier(tokenAuth))\n\tr.POST("/x", h)\n}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "single-arg-di-residual",
    source: PKG + `func routes() {\n\tmux.Handle("/x", NewHandler(auth.NewService(key)))\n}\n`,
    groundTruth: [{ path: "/x", method: "ALL", authed: false }],
  },
];

describe("never-false-bless sweep", () => {
  it("no route with ground truth authed:false is ever emitted hasAuth:true", async () => {
    for (const entry of NEVER_FALSE_BLESS_SWEEP_GO) {
      const f = await go(`sweep/${entry.name}.go`, entry.source);
      const routes = extractGoRoutesAst(f.tree!, f.relativePath);
      for (const gt of entry.groundTruth.filter((g) => !g.authed)) {
        const emitted = routes.find((r) => r.path === gt.path && r.method === gt.method);
        // Non-emission counts as not-blessed (a dropped route cannot false-bless).
        expect(emitted?.hasAuth ?? false, `${entry.name}: ${gt.method} ${gt.path}`).toBe(false);
      }
    }
  });

  it("non-vacuity: every authed:false sweep entry (excluding the two broken-parse fixtures) actually emits its route(s)", async () => {
    const nonEmitting = new Set(["broken-parse-fused-use", "broken-parse-swallowed-route"]);
    for (const entry of NEVER_FALSE_BLESS_SWEEP_GO) {
      if (nonEmitting.has(entry.name)) continue;
      const f = await go(`sweep-nv/${entry.name}.go`, entry.source);
      const routes = extractGoRoutesAst(f.tree!, f.relativePath);
      for (const gt of entry.groundTruth.filter((g) => !g.authed)) {
        const emitted = routes.find((r) => r.path === gt.path && r.method === gt.method);
        expect(emitted, `${entry.name}: ${gt.method} ${gt.path} must be EMITTED (non-vacuous)`).toBeDefined();
      }
    }
  });
});

// ─── Task 6: UNSURE sweep + the three-way machine-statement invariant ────────

const UNSURE_SWEEP_GO: Array<{
  name: string; source: string; route: { path: string; method: string }; hook: string;
}> = [
  {
    name: "imported-non-core-use",
    source: PKG + `func routes() {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", h)\n}\n`,
    route: { path: "/x", method: "POST" },
    hook: "middleware.VerifyToken",
  },
  {
    name: "imported-per-route-arg",
    source: PKG + `func routes() {\n\tr.POST("/x", middleware.VerifyToken(), h)\n}\n`,
    route: { path: "/x", method: "POST" },
    hook: "middleware.VerifyToken",
  },
  {
    name: "opaque-wrapper",
    source: PKG + `func routes() {\n\tmux.Handle("/x", TokenRequired(handler)).Methods("POST")\n}\n`,
    route: { path: "/x", method: "POST" },
    hook: "TokenRequired",
  },
  {
    name: "opaque-in-file-helper",
    // checkAuth is an in-file, RESOLVABLE function whose body calls the
    // unresolved checkSession(c) — opaque body (rule 4), flavored name -> unsure.
    // ("requireLogin" is deliberately NOT used here: "login" is a VETO segment
    // and would resolve flat not-auth, not unsure — see the veto-over-reject set.)
    source: PKG +
      `func checkAuth(c *gin.Context) {\n\tif !checkSession(c) {\n\t\tc.Next()\n\t\treturn\n\t}\n\tc.Next()\n}\n` +
      `func routes() {\n\tr.Use(checkAuth)\n\tr.POST("/x", h)\n}\n`,
    route: { path: "/x", method: "POST" },
    hook: "checkAuth",
  },
  {
    name: "echo-group-inline",
    // jwt is CORE too, but middleware.VerifyToken is used here so the pin never
    // depends on which specific CORE segment fired.
    source: PKG + `func routes() {\n\tadmin := e.Group("/admin", middleware.VerifyToken)\n\tadmin.POST("/users", h)\n}\n`,
    route: { path: "/users", method: "POST" },
    hook: "middleware.VerifyToken",
  },
  {
    name: "chi-With-unsure",
    source: PKG + `func routes() {\n\tr.With(middleware.VerifyToken).Post("/x", h)\n}\n`,
    route: { path: "/x", method: "POST" },
    hook: "middleware.VerifyToken",
  },
  {
    name: "first-of-two-unsure",
    source: PKG + `func routes() {\n\tr.Use(middleware.VerifyToken)\n\tr.Use(middleware.CheckToken)\n\tr.POST("/x", h)\n}\n`,
    route: { path: "/x", method: "POST" },
    hook: "middleware.VerifyToken", // deterministic first-in-document-order wins
  },
];

describe("unsure sweep", () => {
  it("each UNSURE_SWEEP_GO route emits hasAuth:false and the exact expected authUnsureHook", async () => {
    for (const entry of UNSURE_SWEEP_GO) {
      const f = await go(`unsure/${entry.name}.go`, entry.source);
      const routes = extractGoRoutesAst(f.tree!, f.relativePath);
      const rt = routes.find((r) => r.path === entry.route.path && r.method === entry.route.method);
      expect(rt, `${entry.name}: route must be emitted (non-vacuous)`).toBeDefined();
      expect(rt!.hasAuth, entry.name).toBe(false);
      expect(rt!.authUnsureHook, entry.name).toBe(entry.hook);
    }
  });

  it("MACHINE STATEMENT: authUnsureHook !== undefined implies hasAuth === false, and hasAuth === true implies no authUnsureHook key, over every route in both sweeps", async () => {
    const allRoutes: Array<{ hasAuth: boolean; authUnsureHook?: string }> = [];
    for (const entry of NEVER_FALSE_BLESS_SWEEP_GO) {
      const f = await go(`machine-nfb/${entry.name}.go`, entry.source);
      allRoutes.push(...extractGoRoutesAst(f.tree!, f.relativePath));
    }
    for (const entry of UNSURE_SWEEP_GO) {
      const f = await go(`machine-unsure/${entry.name}.go`, entry.source);
      allRoutes.push(...extractGoRoutesAst(f.tree!, f.relativePath));
    }
    expect(allRoutes.length).toBeGreaterThan(0);
    for (const r of allRoutes) {
      if (r.authUnsureHook !== undefined) expect(r.hasAuth).toBe(false);
      if (r.hasAuth === true) expect("authUnsureHook" in r).toBe(false);
    }
  });

  it("FileMiddleware honesty: every UNSURE_SWEEP_GO fixture's file-level hasAuth is false (unsure never enters the OR)", async () => {
    for (const entry of UNSURE_SWEEP_GO) {
      const f = await go(`unsure-fm/${entry.name}.go`, entry.source);
      expect(extractGoFileMiddlewareAst(f.tree!).hasAuth, entry.name).toBe(false);
    }
  });

  it("ambiguous-body generator sweep: every candidate ambiguous body placed in a Use hook over one POST route never yields hasAuth:true", async () => {
    const bodies: Array<[string, string]> = [
      ["AbortWithStatus(codeVar)", `func mw(c *gin.Context) {\n\tc.AbortWithStatus(code)\n}\n`],
      ["AbortWithStatus(404)", `func mw(c *gin.Context) {\n\tc.AbortWithStatus(404)\n}\n`],
      ["AbortWithStatus(500)", `func mw(c *gin.Context) {\n\tc.AbortWithStatus(500)\n}\n`],
      ["bare AbortWithStatus(403)", `func mw(c *gin.Context) {\n\tc.AbortWithStatus(403)\n}\n`],
      ["http.Error(w,...,404)", `func mw(w http.ResponseWriter, r *http.Request) {\n\thttp.Error(w, "not found", 404)\n}\n`],
      ["WriteHeader(500)", `func mw(w http.ResponseWriter, r *http.Request) {\n\tw.WriteHeader(500)\n}\n`],
      ["path-filter-403", `func mw(c *gin.Context) {\n\tif strings.HasPrefix(c.Request.URL.Path, "/admin") {\n\t\tc.AbortWithStatus(403)\n\t}\n}\n`],
      ["csrf-403", `func mw(c *gin.Context) {\n\tif c.GetHeader("X-CSRF-Token") != valid {\n\t\tc.AbortWithStatus(403)\n\t}\n}\n`],
      ["opaque-boring-call", `func mw(c *gin.Context) {\n\tdoStuff(c)\n}\n`],
      ["only c.Next()", `func mw(c *gin.Context) {\n\tc.Next()\n}\n`],
    ];
    for (const [label, body] of bodies) {
      const src = PKG + body + `func routes() {\n\tr.Use(mw)\n\tr.POST("/x", h)\n}\n`;
      const f = await go(`ambiguous/${label.replace(/[^a-z0-9]+/gi, "-")}.go`, src);
      const [rt] = extractGoRoutesAst(f.tree!, f.relativePath);
      expect(rt.hasAuth, label).toBe(false);
    }
  });

  it("depth-cap / cycle safety: a mutual in-file helper cycle terminates, throws nothing, and blesses nothing", async () => {
    const src = PKG +
      `func a(c *gin.Context) {\n\tb(c)\n}\nfunc b(c *gin.Context) {\n\ta(c)\n}\n` +
      `func routes() {\n\tr.Use(a)\n\tr.POST("/x", h)\n}\n`;
    const f = await go("mutualcycle.go", src);
    expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    const [rt] = extractGoRoutesAst(f.tree!, f.relativePath);
    expect(rt.hasAuth).toBe(false);
  });

  it("depth-cap / cycle safety: a 20-deep returned-closure wrap terminates, throws nothing, and blesses nothing", async () => {
    let expr = "h";
    for (let i = 0; i < 20; i++) expr = `logWrap(${expr})`;
    const f = await go("deepwrap2.go", PKG + `func routes() {\n\tmux.Handle("/x", ${expr})\n}\n`);
    expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractGoRoutesAst(f.tree!, f.relativePath)[0].hasAuth).toBe(false);
  });

  it("no-throw totality: every adversarial-plus-unsure fixture never throws in either extractor", async () => {
    const sources = [
      ...NEVER_FALSE_BLESS_SWEEP_GO.map((e) => e.source),
      ...UNSURE_SWEEP_GO.map((e) => e.source),
    ];
    for (const src of sources) {
      const f = await go("totality2.go", src);
      expect(() => extractGoRoutesAst(f.tree!, f.relativePath)).not.toThrow();
      expect(() => extractGoFileMiddlewareAst(f.tree!)).not.toThrow();
    }
  });
});

// ── Task 4: Go cross-file wiring (imported package middleware selectors) ──────
//
// Cross-file resolution ONLY supplies a body to the EXISTING classifier
// (classifyGoMiddlewareArg -> classifyGoMiddlewareAuth via resolveGoMiddlewareBody).
// Blessing still requires the resolved in-repo body to VERIFIABLY reject; every
// value-shadow / exported-only / package-name / external guard lives in
// resolveGoMiddlewareBody and is CALLED, never bypassed. Both Go middleware
// paths are covered: the per-route inline form (goRouteMiddleware) and the
// Use/group form (collectGoMiddleware -> lanesFromArgs). With the index absent
// (the 2-arg call), every route is byte-identical to today.

// An imported package middleware factory whose returned closure verifiably 401s.
const XFILE_REJECT_FACTORY = `package middleware

import "net/http"

func AuthMiddleware() Handler {
	return func(c *Ctx) {
		if c.GetHeader("Authorization") == "" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	}
}
`;

describe("Task 4: Go cross-file wiring — HEADLINE both forms resolve + bless", () => {
  it("per-route INLINE form: r.POST(\"/x\", middleware.AuthMiddleware(), createX) blesses cross-file", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(true);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("USE/group form: r.Use(middleware.AuthMiddleware()) blesses the later same-scope route", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.Use(middleware.AuthMiddleware())\n\tr.POST("/x", createX)\n}\n`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(true);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("aliased qualifier: import mw \"myapp/auth\" + r.Use(mw.Require) blesses a later same-scope route", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport mw "myapp/auth"\n\nfunc Register(r Router) {\n\tr.Use(mw.Require)\n\tr.POST("/x", createX)\n}\n`],
      ["auth/auth.go", `package auth\n\nimport "net/http"\n\nfunc Require() Handler {\n\treturn func(c *Ctx) {\n\t\tif c.GetHeader("Authorization") == "" {\n\t\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tc.Next()\n\t}\n}\n`],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    const route = routes.find((r) => r.path === "/x")!;
    expect(route.hasAuth).toBe(true);
    expect(route.authUnsureHook).toBeUndefined();
  });
});

describe("Task 4: Go cross-file wiring — wrap form + DI arity guard", () => {
  // RequireAuth is a single-arg wrap (resolves + blesses); NewGuardedHandler is
  // an arity-2 DI callee with an IDENTICAL rejecting body — it must STILL never
  // bless (do not resolve an arity->=2 callee, mirroring the never-classify-DI
  // rule). If the arity guard regressed, NewGuardedHandler would false-bless.
  const WRAP_PKG = `package middleware

import "net/http"

func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func NewGuardedHandler(next http.Handler, cfg Config) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
`;

  it("single-arg wrap mux.Handle(\"/x\", middleware.RequireAuth(handler)) resolves + blesses", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(mux Router) {\n\tmux.Handle("/x", middleware.RequireAuth(handler))\n}\n`],
      ["internal/middleware/auth.go", WRAP_PKG],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(true);
  });

  it("arity-2 DI callee middleware.NewGuardedHandler(handler, cfg) stays UNCLASSIFIED even cross-file", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(mux Router) {\n\tmux.Handle("/x", middleware.NewGuardedHandler(handler, cfg))\n}\n`],
      ["internal/middleware/auth.go", WRAP_PKG],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(false);
  });

  it("method target: middleware.RequireAuth pointing at a method_declaration never blesses (stays unsure)", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.Use(middleware.RequireAuth)\n\tr.POST("/x", createX)\n}\n`],
      ["internal/middleware/auth.go", `package middleware\n\nimport "net/http"\n\ntype Mw struct{}\n\nfunc (m *Mw) RequireAuth(c *Ctx) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\treturn\n\t}\n\tc.Next()\n}\n`],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    const route = routes.find((r) => r.path === "/x")!;
    expect(route.hasAuth).toBe(false);
    expect(route.authUnsureHook).toBe("middleware.RequireAuth");
  });
});

describe("Task 4: Go cross-file wiring — byte-identity pins (external + in-file)", () => {
  it("EXTERNAL package stays unsure, byte-identical with and without the index", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "github.com/foo/mw"\n\nfunc Register(r Router) {\n\tr.Use(mw.Auth)\n\tr.POST("/x", createX)\n}\n`],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const withIndex = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    const withoutIndex = extractGoRoutesAst(rf.tree!, rf.relativePath);
    // Byte-identical: an external package refuses cross-file, leaving the exact
    // unsure hedge the in-file-only path already emits.
    expect(withIndex).toEqual(withoutIndex);
    const route = withIndex.find((r) => r.path === "/x")!;
    expect(route.hasAuth).toBe(false);
    expect(route.authUnsureHook).toBe("mw.Auth");
  });

  it("IN-FILE precedence: a bare in-file AuthMiddleware blesses identically with and without the index", async () => {
    const src = `package handlers\n\nimport "net/http"\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tif c.GetHeader("Authorization") == "" {\n\t\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\t\treturn\n\t\t}\n\t\tc.Next()\n\t}\n}\n\nfunc Register(r Router) {\n\tr.Use(AuthMiddleware())\n\tr.POST("/x", createX)\n}\n`;
    const files = await goRepo([["handlers/routes.go", src]]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const withIndex = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    const withoutIndex = extractGoRoutesAst(rf.tree!, rf.relativePath);
    expect(withIndex).toEqual(withoutIndex);
    expect(withIndex.find((r) => r.path === "/x")!.hasAuth).toBe(true);
  });

  it("an imported rejecting factory is NOT resolved when goModulePath is absent (Go cross-file off)", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
    ]);
    // No module path => the Go half is empty => the selector never resolves; the
    // route stays unsure (auth-flavored opaque), byte-identical to the 2-arg call.
    const index = buildXFileIndex(files, null);
    const rf = routeFile(files);
    const withIndex = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    const withoutIndex = extractGoRoutesAst(rf.tree!, rf.relativePath);
    expect(withIndex).toEqual(withoutIndex);
    expect(withIndex[0].hasAuth).toBe(false);
  });
});

// ─── Task 5: adversarial never-false-bless sweep (cross-file, Go) ───────────
//
// GOVERNING INVARIANT — a WRONG cross-file attribution is a false-bless.
// Every entry below registers a REAL rejecting body somewhere in the repo, so
// a broken refuse guard would visibly bless the route; the sweep asserts it
// never does. classifyGoMiddlewareAuth never blesses on name alone (unlike
// the Python module), so no CORE-name trap exists here — every refusal is
// driven by cross-file resolution / the arity gate, not a name shortcut.

interface GoXFileSweepEntry {
  name: string;
  files: [string, string][];
  routeFile: string;
  goMod: string | null;
  groundTruth: Array<{ path: string; method: string; authed: boolean }>;
}

// The seven Go value-shadow binding forms (Task 5 required catalog), each
// combined with a REAL r.POST(...) route selecting `middleware.AuthMiddleware`
// — the shadow lives in an UNRELATED function/decl in the SAME file (valueBound
// is file-wide, not scope-aware, so this still poisons the qualifier).
const GO_VALUE_SHADOW_FORMS: Array<[string, string]> = [
  [":=", `func helper() {\n\tmiddleware := 0\n\t_ = middleware\n}\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
  ["var", `var middleware int\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
  ["const", `const middleware = 0\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
  ["param", `func helper(middleware int) {}\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
  ["RECEIVER", `type Server struct{}\n\nfunc (middleware *Server) Helper() {}\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
  ["named-return", `func helper() (middleware int) {\n\treturn\n}\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
  ["type-switch guard", `func helper(x interface{}) {\n\tswitch middleware := x.(type) {\n\tdefault:\n\t\t_ = middleware\n\t}\n}\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
];

const NEVER_FALSE_BLESS_XFILE_GO: GoXFileSweepEntry[] = [
  {
    name: "external package (not under module path)",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "github.com/foo/mw"\n\nfunc Register(r Router) {\n\tr.POST("/x", mw.Auth(), createX)\n}\n`],
    ],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "no go.mod (Go cross-file disabled wholesale)",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
    ],
    routeFile: "handlers/routes.go",
    goMod: null,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    // The plumbing collapses goModulePath to null on a `replace` directive; at
    // this layer that is simply a null module path, mechanically identical to
    // "no go.mod" — pinned separately per the catalog for documentation.
    name: "replace directive present (goModulePath forced null upstream)",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
    ],
    routeFile: "handlers/routes.go",
    goMod: null,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "dot-import blanket refuse",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport (\n\t"myapp/internal/middleware"\n\t. "myapp/helpers"\n)\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
    ],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  ...GO_VALUE_SHADOW_FORMS.map(([label, body]) => ({
    name: `value-shadow — ${label}`,
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\n${body}`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
    ] as [string, string][],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  })),
  {
    name: "package-name mismatch (plain import, declared package != qualifier)",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", `package authpkg\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(401)\n\t}\n}\n`],
    ],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "method-target (selector points at a method_declaration, not a function)",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.Use(middleware.RequireAuth)\n\tr.POST("/x", createX)\n}\n`],
      ["internal/middleware/auth.go", `package middleware\n\nimport "net/http"\n\ntype Mw struct{}\n\nfunc (m *Mw) RequireAuth(c *Ctx) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\treturn\n\t}\n\tc.Next()\n}\n`],
    ],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "duplicate-across-package-files (sticky-null)",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
      ["internal/middleware/legacy.go", `package middleware\n\nfunc AuthMiddleware() Handler {\n\treturn nil\n}\n`],
    ],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "two-dir same-package-name (ambiguous qualifier)",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport (\n\t"myapp/pkgA"\n\t"myapp/pkgB"\n)\n\nfunc Register(r Router) {\n\tr.POST("/x", foo.AuthMiddleware(), createX)\n}\n`],
      ["pkgA/a.go", `package foo\n\nimport "net/http"\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t}\n}\n`],
      ["pkgB/b.go", `package foo\n\nfunc Other() {}\n`],
    ],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "wrong-dir same-symbol: imported dir lacks it, a DIFFERENT dir defines a rejecting one (WRONG-FILE)",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/other.go", `package middleware\n\nfunc Other() {}\n`],
      ["internal/authz/guard.go", `package middleware\n\nimport "net/http"\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t}\n}\n`],
    ],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "multi-file package: one-hop resolves against the def's OWN file, never a sibling's rejecting helper",
    files: [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      // AuthMiddleware's OWN file's authImpl does NOT reject.
      ["internal/middleware/auth.go", `package middleware\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tauthImpl(c)\n\t}\n}\n\nfunc authImpl(c *Ctx) {\n\tc.Next()\n}\n`],
      // A DIFFERENT sibling file's SAME-NAMED authImpl DOES reject — must never
      // drive the verdict.
      ["internal/middleware/helpers.go", `package middleware\n\nimport "net/http"\n\nfunc authImpl(c *Ctx) {\n\tc.AbortWithStatus(http.StatusUnauthorized)\n}\n`],
    ],
    routeFile: "handlers/routes.go",
    goMod: "myapp",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
];

describe("NEVER-FALSE-BLESS adversarial sweep (cross-file, Go)", () => {
  it("no ground-truth-unauthed route is ever emitted hasAuth:true (cross-file)", async () => {
    for (const e of NEVER_FALSE_BLESS_XFILE_GO) {
      const files = await goRepo(e.files);
      const index = buildXFileIndex(files, e.goMod);
      const rf = files.find((f) => f.relativePath === e.routeFile)!;
      const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
      for (const gt of e.groundTruth.filter((g) => !g.authed)) {
        const emitted = routes.find((r) => r.path === gt.path && r.method === gt.method);
        // Non-vacuous: the route must actually have been extracted (the
        // classifier genuinely ran).
        expect(emitted, `${e.name}: route was never extracted`).toBeDefined();
        expect(emitted?.hasAuth ?? false, `${e.name}: ${gt.method} ${gt.path}`).toBe(false);
      }
    }
  });
});

describe("EXTERNAL-PARITY (cross-file adds zero blesses for out-of-repo Go symbols)", () => {
  const EXTERNAL_FIXTURES_GO: Array<[string, [string, string][]]> = [
    ["external package (github.com/...)", [
      ["handlers/routes.go", `package handlers\n\nimport "github.com/foo/mw"\n\nfunc Register(r Router) {\n\tr.Use(mw.Auth)\n\tr.POST("/x", createX)\n}\n`],
    ]],
    ["method-target (never a function_declaration)", [
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.Use(middleware.RequireAuth)\n\tr.POST("/x", createX)\n}\n`],
      ["internal/middleware/auth.go", `package middleware\n\nimport "net/http"\n\ntype Mw struct{}\n\nfunc (m *Mw) RequireAuth(c *Ctx) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\treturn\n\t}\n\tc.Next()\n}\n`],
    ]],
    ["dot-import blanket refuse", [
      ["handlers/routes.go", `package handlers\n\nimport (\n\t"myapp/internal/middleware"\n\t. "myapp/helpers"\n)\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/auth.go", XFILE_REJECT_FACTORY],
    ]],
  ];

  it("index-present and index-absent RouteInfo arrays are byte-identical for every external Go fixture", async () => {
    for (const [name, spec] of EXTERNAL_FIXTURES_GO) {
      const files = await goRepo(spec);
      const index = buildXFileIndex(files, "myapp");
      const rf = files.find((f) => f.relativePath === "handlers/routes.go")!;
      const withIndex = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
      const withoutIndex = extractGoRoutesAst(rf.tree!, rf.relativePath);
      expect(withIndex, name).toEqual(withoutIndex);
    }
  });
});

describe("WRONG-FILE guard (Go, the single most important cross-file pin)", () => {
  it("imported dir lacking the symbol never falls back to a different dir's rejecting same-name def", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      ["internal/middleware/other.go", `package middleware\n\nfunc Other() {}\n`],
      ["internal/authz/guard.go", `package middleware\n\nimport "net/http"\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t}\n}\n`],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(false);

    // Direct proof: resolution is PATH-ANCHORED to the imported dir only —
    // there is no repo-wide name-search fallback.
    expect(resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index)).toBeNull();
  });
});

describe("ONE-HOP-CEILING (Go): a second cross-package hop is never followed", () => {
  it("a resolved factory whose reject lives behind a cross-PACKAGE call stays not-auth", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(r Router) {\n\tr.POST("/x", middleware.AuthMiddleware(), createX)\n}\n`],
      // AuthMiddleware's body calls a DIFFERENT imported package's function — a
      // SECOND cross-file (cross-package) hop the body scanner never walks.
      ["internal/middleware/auth.go", `package middleware\n\nimport "myapp/internal/other"\n\nfunc AuthMiddleware() Handler {\n\treturn func(c *Ctx) {\n\t\tother.Helper(c)\n\t}\n}\n`],
      ["internal/other/helper.go", `package other\n\nimport "net/http"\n\nfunc Helper(c *Ctx) {\n\tc.AbortWithStatus(http.StatusUnauthorized)\n}\n`],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(false);

    // Non-vacuous: the FIRST hop resolves fine (AuthMiddleware's body IS
    // found); the reject lives behind a SECOND, cross-package call the body
    // scanner never walks (bodyAuthSignatureGo's hop is a same-file bare
    // identifier only — a selector call to another package is invisible).
    const resolved = resolveGoMiddlewareBody("handlers/routes.go", "middleware.AuthMiddleware", index);
    expect(resolved).not.toBeNull();
    const effective = resolveEffectiveBody(resolved!.def, resolved!.defs);
    expect(effective).not.toBeNull();
    expect(bodyAuthSignatureGo(effective!, resolved!.defs)).not.toBe("reject");
  });
});

// ─── Task 4 review — required arity-gate pin (mandatory addition) ───────────
//
// The shipped Task 4 DI test (NewGuardedHandler, above) passes via a NAME
// VETO ("handler" is a GO_AUTH_VETO_SEGMENTS member baked into the callee
// name "NewGuardedHandler"), which fires at classifyGoMiddlewareAuth's rule 1
// BEFORE the arity gate is ever relevant — so that test alone does not prove
// isPureSelectorTarget's `arity <= 1` gate is doing anything. This pin uses a
// callee name ("Protect") carrying NO veto segment and NO GO_AUTH_SEGMENTS
// flavor, wired to a body that genuinely 401s unconditionally, so ONLY the
// arity gate can be preventing the bless. Verified to fail RED with the gate
// removed (see task-5-report.md for the evidence).

describe("Task 4 review — required arity-gate pin (protects isPureSelectorTarget's arity<=1 gate)", () => {
  it("a non-veto, non-flavored arity-2 imported factory never blesses cross-file", async () => {
    const files = await goRepo([
      ["handlers/routes.go", `package handlers\n\nimport "myapp/internal/middleware"\n\nfunc Register(mux Router) {\n\tmux.Handle("/x", middleware.Protect(handler, cfg))\n}\n`],
      ["internal/middleware/auth.go", `package middleware\n\nfunc Protect(next Handler, cfg Config) Handler {\n\treturn func(c *Ctx) {\n\t\tc.AbortWithStatus(401)\n\t}\n}\n`],
    ]);
    const index = buildXFileIndex(files, "myapp");
    const rf = routeFile(files);
    const routes = extractGoRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    // "Protect" carries no veto segment and no auth-flavor segment, and the
    // resolved body genuinely rejects unconditionally — the ONLY thing
    // stopping a false-bless here is the arity<=1 gate refusing to even
    // ATTEMPT cross-file resolution of a 2-argument call.
    expect(routes[0].hasAuth).toBe(false);
  });
});
