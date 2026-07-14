import { describe, it, expect } from "vitest";
import {
  extractGoRoutesAst, SECURITY_AST_GO,
  bodyAuthSignatureGo, classifyGoMiddlewareAuth, collectGoFunctionDefs,
} from "../../../src/drift/security-ast-go.js";
import { SECURITY_AST } from "../../../src/drift/security-ast.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { SyntaxNode } from "../../../src/core/types.js";

const go = (path: string, src: string) => fileWithTree(path, src, "go");

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
