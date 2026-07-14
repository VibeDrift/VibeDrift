import { describe, it, expect } from "vitest";
import { extractGoRoutesAst, SECURITY_AST_GO } from "../../../src/drift/security-ast-go.js";
import { SECURITY_AST } from "../../../src/drift/security-ast.js";
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
