import { describe, it, expect } from "vitest";
import { extractGoRoutesAst, SECURITY_AST_GO } from "../../../src/drift/security-ast-go.js";
import { fileWithTree } from "../../helpers/drift-tree.js";

const go = (path: string, src: string) => fileWithTree(path, src, "go");

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
