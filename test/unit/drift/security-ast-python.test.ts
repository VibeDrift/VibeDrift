import { describe, it, expect } from "vitest";
import {
  extractPythonRoutesAst,
  extractPythonFileMiddlewareAst,
  bodyAuthSignature,
  classifyHookAuth,
  collectFunctionDefs,
  SECURITY_AST_PY,
} from "../../../src/drift/security-ast-python.js";
import type { SyntaxNode } from "../../../src/core/types.js";
import { fileWithTree } from "../../helpers/drift-tree.js";

const py = (path: string, src: string) => fileWithTree(path, src, "python");

describe("py() test helper (harness prerequisites)", () => {
  it("parses a Python source file into a usable, error-free tree", async () => {
    const f = await py("hello.py", `def hello():\n    return "hi"\n`);
    expect(f.tree).toBeDefined();
    expect(f.tree!.rootNode.hasError).toBe(false);
    expect(f.language).toBe("python");
  });
});

describe("extractPythonRoutesAst: Flask route recognition", () => {
  it("extracts a FastAPI-style verb decorator with method, path, and decorator line", async () => {
    const f = await py("routes.py",
      `@app.post("/orders")\n` +
      `def create_order():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /orders auth=false",
    ]);
    expect(routes[0].line).toBe(1);
    expect(routes[0].file).toBe("routes.py");
  });

  it("defaults a bare @app.route to GET (Flask semantics, not ANY)", async () => {
    const f = await py("r.py", `@bp.route("/orders")\ndef list_orders():\n    return []\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /orders"]);
  });

  it("recognizes blueprint receivers: users_bp, blueprint, api, admin_blueprint", async () => {
    const f = await py("bps.py",
      `@users_bp.route("/users")\ndef a():\n    return []\n\n` +
      `@blueprint.route("/x")\ndef b():\n    return []\n\n` +
      `@api.route("/y")\ndef c():\n    return []\n\n` +
      `@admin_blueprint.route("/z")\ndef d():\n    return []\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toHaveLength(4);
  });

  it("extracts a multiline decorator (the regex path's blind spot)", async () => {
    const f = await py("m.py",
      `@app.route(\n` +
      `    "/orders",\n` +
      `)\n` +
      `def create():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /orders"]);
    expect(routes[0].line).toBe(1);
  });

  it("emits two RouteInfos for two stacked route decorators on one handler", async () => {
    const f = await py("s.py",
      `@app.post("/a")\n` +
      `@app.post("/b")\n` +
      `def h():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path}:${r.line}`)).toEqual(["/a:1", "/b:2"]);
  });

  it("extracts a route registered inside an app factory (nested decorated_definition)", async () => {
    const f = await py("factory.py",
      `def create_app():\n` +
      `    app = Flask(__name__)\n` +
      `    @app.post("/inner")\n` +
      `    def inner():\n` +
      `        return {}\n` +
      `    return app\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(["/inner"]);
  });

  it("ignores app.route calls that are not in decorator position", async () => {
    const f = await py("n.py", `r = app.route("/x")\nclient.post("/x")\nrequests.get("/y")\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("recognizes the Flask verb-shorthand decorator @app.delete", async () => {
    const f = await py("d.py",
      `@app.delete("/orders/<int:id>")\ndef delete_order(id):\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /orders/<int:id>"]);
  });
});

describe("extractPythonRoutesAst: FastAPI route recognition", () => {
  it("recognizes @router.post on an async def handler", async () => {
    const f = await py("i.py",
      `@router.post("/items")\nasync def create_item():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /items"]);
  });

  it("recognizes @app.get", async () => {
    const f = await py("i2.py", `@app.get("/items")\ndef list_items():\n    return []\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /items"]);
  });

  it("recognizes @api_router and @v1 (versioned registrar) receivers", async () => {
    const f = await py("v.py",
      `@api_router.put("/items/{id}")\n` +
      `def update_item(id):\n` +
      `    return {}\n\n` +
      `@v1.post("/x")\n` +
      `def create_x():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /items/{id}", "POST /x"]);
  });

  it("does not recognize @router.websocket (not a route-registration attribute)", async () => {
    const f = await py("ws.py",
      `@router.websocket("/ws")\nasync def ws_handler():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("accepts a keyword-only path= argument", async () => {
    const f = await py("kw.py",
      `@router.post(path="/items")\ndef create_item():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /items"]);
  });

  it("ignores trailing kwarg noise after the path (response_model, status_code)", async () => {
    const f = await py("noise.py",
      `@router.post("/items", response_model=Item, status_code=201)\n` +
      `def create_item():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /items"]);
  });
});

describe("extractPythonRoutesAst: receiver-gate negatives", () => {
  it("ignores @property/@staticmethod/@classmethod method decorators", async () => {
    const f = await py("cls.py",
      `class Foo:\n` +
      `    @property\n` +
      `    def bar(self):\n` +
      `        return 1\n\n` +
      `    @staticmethod\n` +
      `    def baz():\n` +
      `        return 2\n\n` +
      `    @classmethod\n` +
      `    def qux(cls):\n` +
      `        return 3\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("ignores @lru_cache and @functools.lru_cache(...) decorators", async () => {
    const f = await py("cache.py",
      `@lru_cache\n` +
      `def get_config():\n` +
      `    return {}\n\n` +
      `@functools.lru_cache(maxsize=128)\n` +
      `def get_settings():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not capture non-router receivers (cache.get, celery.task over-capture)", async () => {
    const f = await py("svc.py",
      `@cache.get("user:1")\n` +
      `def get_user():\n` +
      `    return {}\n\n` +
      `@celery.task\n` +
      `def process():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("ignores non-route decorators with attribute names outside ROUTE_METHODS", async () => {
    const f = await py("misc.py",
      `@pytest.mark.parametrize("p", ["/x"])\n` +
      `def test_thing(p):\n` +
      `    return p\n\n` +
      `@app.errorhandler(404)\n` +
      `def not_found(e):\n` +
      `    return {}, 404\n\n` +
      `@app.teardown_appcontext\n` +
      `def teardown(exception=None):\n` +
      `    pass\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not extract @ns.route when ns is never assigned from a ROUTER_CONSTRUCTORS name (flask-restx)", async () => {
    // Documented under-recognition: flask-restx Namespace objects are not one
    // of ROUTER_CONSTRUCTORS, and "ns" does not match ROUTER_RECEIVER by
    // convention either, so this route is a measured, not silent, recall gap.
    const f = await py("restx.py", `@ns.route("/x")\ndef get_order():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("ignores in-body route-shaped calls (TestClient(app).post, session.get)", async () => {
    const f = await py("body.py",
      `def test_create_order():\n` +
      `    TestClient(app).post("/x")\n\n` +
      `def test_get_session():\n` +
      `    session.get("/z")\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("extractPythonRoutesAst: structural receiver resolution", () => {
  // These fixtures deliberately use verb-decorator forms (@main.post) rather
  // than the plan's illustrative `methods=["POST"]` kwarg form: Task 1's
  // resolveMethod always returns "GET" for route/api_route (methods= parsing
  // is Task 2's job per the edge-case-groups scope note), so a methods=
  // fixture here would assert an output this task's code cannot produce.
  // What's under test is receiver resolution, not method resolution, so the
  // verb-decorator form isolates that cleanly and needs no rewrite in Task 2.

  it("recognizes a bare-name blueprint receiver resolved structurally via Blueprint() (main)", async () => {
    const f = await py("main.py",
      `main = Blueprint("main", __name__)\n\n` +
      `@main.post("/orders")\n` +
      `def create_order():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders"]);
  });

  it("recognizes a bare-name blueprint receiver resolved structurally via Blueprint() (auth)", async () => {
    const f = await py("auth.py",
      `auth = Blueprint("auth", __name__)\n\n` +
      `@auth.post("/login")\n` +
      `def login():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /login"]);
  });

  it("recognizes a bare-name blueprint receiver resolved structurally via Blueprint() (admin)", async () => {
    const f = await py("admin.py",
      `admin = Blueprint("admin", __name__)\n\n` +
      `@admin.delete("/purge")\n` +
      `def purge():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["DELETE /purge"]);
  });

  it("recognizes a custom-named receiver resolved structurally via APIRouter() (views)", async () => {
    const f = await py("views.py",
      `views = APIRouter()\n\n` +
      `@views.post("/x")\n` +
      `def create_x():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("emits nothing for a bare receiver with no in-file constructor assignment, outside ROUTER_RECEIVER", async () => {
    const f = await py("orphan.py",
      `@main.route("/x", methods=["POST"])\ndef do_thing():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("resolves a nested self.app receiver to the nearest attribute name", async () => {
    const f = await py("server.py",
      `class Server:\n` +
      `    def setup(self):\n` +
      `        @self.app.route("/x")\n` +
      `        def handler():\n` +
      `            return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(["/x"]);
  });
});

describe("extractPythonRoutesAst: path-string forms", () => {
  it("accepts single and double quoted path strings", async () => {
    const f = await py("q.py",
      `@app.get('/single')\ndef a():\n    return []\n\n` +
      `@app.get("/double")\ndef b():\n    return []\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /single", "GET /double"]);
  });

  it("keeps Flask/FastAPI path-parameter syntax verbatim", async () => {
    const f = await py("params.py",
      `@app.get("/users/<int:user_id>")\ndef get_user(user_id):\n    return {}\n\n` +
      `@router.get("/items/{item_id}")\ndef get_item(item_id: int):\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(["/users/<int:user_id>", "/items/{item_id}"]);
  });

  it("accepts the root path", async () => {
    const f = await py("root.py", `@app.get("/")\ndef index():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(["/"]);
  });

  it("skips a path with no leading slash and an empty path string", async () => {
    const f = await py("noleading.py",
      `@app.get("orders")\ndef a():\n    return []\n\n` +
      `@app.get("")\ndef b():\n    return []\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("accepts an f-string path with a static leading piece, preserving interpolation braces verbatim", async () => {
    const f = await py("fstr.py",
      `@app.get(f"/api/{version}/x")\ndef a():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => r.path)).toEqual(["/api/{version}/x"]);
  });

  it("skips an f-string path whose leading piece is dynamic", async () => {
    const f = await py("fstr2.py", `@app.get(f"{base}/x")\ndef a():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("strips the r prefix from a raw string path", async () => {
    const f = await py("raw.py", `@app.get(r"/raw")\ndef a():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /raw"]);
  });

  it("strips triple quotes from a path", async () => {
    const f = await py("triple.py", `@app.get("""/x""")\ndef a():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /x"]);
  });

  it("joins an implicitly concatenated path string", async () => {
    const f = await py("concat.py", `@app.get("/api" "/x")\ndef a():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/x"]);
  });

  it("skips a path built with + concatenation (statically unresolvable)", async () => {
    const f = await py("plus.py", `@app.get("/a" + suffix)\ndef a():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips a route whose path is a bare identifier variable", async () => {
    const f = await py("var.py", `PATH = "/x"\n\n@app.route(PATH)\ndef a():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("accepts a unicode path", async () => {
    const f = await py("unicode.py", `@app.get("/café")\ndef a():\n    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /café"]);
  });
});

describe("extractPythonRoutesAst: method resolution", () => {
  it("defaults to GET when no methods kwarg is present", async () => {
    const f = await py("nokw.py", `@app.route("/x")\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
  });

  it("resolves methods=[\"POST\"] to POST", async () => {
    const f = await py("post.py", `@app.route("/x", methods=["POST"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves methods=[\"DELETE\"] to DELETE", async () => {
    const f = await py("delete.py", `@app.route("/x", methods=["DELETE"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("DELETE");
  });

  it("resolves methods=[\"GET\", \"POST\"] to POST (mutating verb wins, regex parity)", async () => {
    const f = await py("getpost.py",
      `@app.route("/x", methods=["GET", "POST"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves methods=[\"DELETE\", \"POST\"] to DELETE (first mutating verb in list order)", async () => {
    const f = await py("deletepost.py",
      `@app.route("/x", methods=["DELETE", "POST"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("DELETE");
  });

  it("uppercases a lowercase methods=[\"post\"] entry (Werkzeug uppercases at runtime)", async () => {
    const f = await py("lower.py", `@app.route("/x", methods=["post"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves a tuple methods=(\"POST\",) to POST", async () => {
    const f = await py("tuple.py", `@app.route("/x", methods=("POST",))\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves a set methods={\"POST\"} to POST", async () => {
    const f = await py("set.py", `@app.route("/x", methods={"POST"})\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves methods=ALLOWED (a variable) to ALL: statically unresolvable stays in the mutating vote", async () => {
    const f = await py("var.py", `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("resolves methods=[*BASE, \"POST\"] to POST: the visible literal resolves it", async () => {
    const f = await py("splatpost.py",
      `@app.route("/x", methods=[*BASE, "POST"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves methods=[*BASE] to ALL: no visible literal, statically unresolvable", async () => {
    const f = await py("splatonly.py", `@app.route("/x", methods=[*BASE])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("resolves @app.route(\"/x\", **opts) to ALL: methods may hide in opts", async () => {
    const f = await py("kwsplat.py", `@app.route("/x", **opts)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("resolves a literal empty methods=[] to GET: fully visible and empty is the Flask default, not ambiguity", async () => {
    const f = await py("empty.py", `@app.route("/x", methods=[])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
  });

  it("resolves methods=[\"GET\"] to GET: emitted, simply outside the mutating vote", async () => {
    const f = await py("getonly.py", `@app.route("/x", methods=["GET"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
  });

  it("resolves @router.api_route(\"/x\", methods=[\"POST\"]) to POST", async () => {
    const f = await py("apiroute.py",
      `@router.api_route("/x", methods=["POST"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves a multiline decorator with a trailing-comma methods=[\"POST\",\"GET\"] to POST", async () => {
    const f = await py("multiline.py",
      `@app.route(\n` +
      `    "/x",\n` +
      `    methods=["POST", "GET"],\n` +
      `)\n` +
      `def h():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });
});

describe("auth recognition: decorators", () => {
  it("blesses @login_required BELOW the route decorator (applied first, wraps the registered handler)", async () => {
    const f = await py("below.py",
      `@app.post("/orders")\n` +
      `@login_required\n` +
      `def create_order():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /orders auth=true",
    ]);
  });

  it("does NOT bless @login_required ABOVE the route decorator (registers the unwrapped handler)", async () => {
    const f = await py("above.py",
      `@login_required\n` +
      `@app.post("/orders")\n` +
      `def create_order():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /orders auth=false",
    ]);
  });

  it("mixed stacked-route order: /a wraps the auth decorator (true), /b registers unwrapped (false)", async () => {
    const f = await py("mixed.py",
      `@app.post("/a")\n` +
      `@login_required\n` +
      `@app.post("/b")\n` +
      `def h():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /a auth=true",
      "POST /b auth=false",
    ]);
  });

  it("blesses @jwt_required() and @jwt_required(refresh=True)", async () => {
    const f = await py("jwt.py",
      `@app.post("/a")\n` +
      `@jwt_required()\n` +
      `def a():\n` +
      `    return {}\n\n` +
      `@app.post("/b")\n` +
      `@jwt_required(refresh=True)\n` +
      `def b():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/a auth=true",
      "/b auth=true",
    ]);
  });

  it("does not bless @jwt_required(optional=True): optional auth admits anonymous requests", async () => {
    const f = await py("optionaltrue.py",
      `@app.post("/x")\n` +
      `@jwt_required(optional=True)\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });

  it("does not bless @jwt_required(optional=OPTIONAL_AUTH): statically unknowable value resolves false", async () => {
    const f = await py("optionalflag.py",
      `@app.post("/x")\n` +
      `@jwt_required(optional=OPTIONAL_AUTH)\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });

  it("blesses @auth.login_required (flask-httpauth) and @flask_login.login_required", async () => {
    const f = await py("attrdec.py",
      `@app.post("/a")\n` +
      `@auth.login_required\n` +
      `def a():\n` +
      `    return {}\n\n` +
      `@app.post("/b")\n` +
      `@flask_login.login_required\n` +
      `def b():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/a auth=true",
      "/b auth=true",
    ]);
  });

  it("blesses lexicon names: requires_auth, admin_required, permission_required(...), token_required, bare requires(...)", async () => {
    const f = await py("lexicon.py",
      `@app.post("/a")\n` +
      `@requires_auth\n` +
      `def a():\n` +
      `    return {}\n\n` +
      `@app.post("/b")\n` +
      `@admin_required\n` +
      `def b():\n` +
      `    return {}\n\n` +
      `@app.post("/c")\n` +
      `@permission_required("orders.write")\n` +
      `def c():\n` +
      `    return {}\n\n` +
      `@app.post("/d")\n` +
      `@token_required\n` +
      `def d():\n` +
      `    return {}\n\n` +
      `@app.post("/e")\n` +
      `@requires("admin")\n` +
      `def e():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/a auth=true",
      "/b auth=true",
      "/c auth=true",
      "/d auth=true",
      "/e auth=true",
    ]);
  });

  it("does not bless @feature.requires(...) or @pytest.mark.requires: bare requires only matches the bare-identifier call form", async () => {
    const f = await py("bogusrequires.py",
      `@app.post("/a")\n` +
      `@feature.requires("new_ui")\n` +
      `def a():\n` +
      `    return {}\n\n` +
      `@app.post("/b")\n` +
      `@pytest.mark.requires\n` +
      `def b():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/a auth=false",
      "/b auth=false",
    ]);
  });

  it("does not bless @author_stats: substring near-miss, exact-segment matching only", async () => {
    const f = await py("authorstats.py",
      `@app.post("/x")\n` +
      `@author_stats\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });

  it("does not bless @track_metrics or an aliased @guard: name-based recognition is conservative", async () => {
    const f = await py("aliases.py",
      `@app.post("/a")\n` +
      `@track_metrics\n` +
      `def a():\n` +
      `    return {}\n\n` +
      `@app.post("/b")\n` +
      `@guard\n` +
      `def b():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/a auth=false",
      "/b auth=false",
    ]);
  });

  it("adjacent-function no-leak: a's auth decorator does not bless sibling b", async () => {
    const f = await py("noleak.py",
      `@app.post("/a")\n` +
      `@login_required\n` +
      `def a():\n` +
      `    return {}\n\n` +
      `@app.post("/b")\n` +
      `def b():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/a auth=true",
      "/b auth=false",
    ]);
  });
});

describe("auth recognition: FastAPI dependencies", () => {
  it("blesses a typed default parameter: user: User = Depends(get_current_user)", async () => {
    const f = await py("typeddefault.py",
      `@router.post("/x")\n` +
      `def h(user: User = Depends(get_current_user)):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => r.hasAuth)).toEqual([true]);
  });

  it("blesses an untyped default parameter: user=Depends(get_current_user)", async () => {
    const f = await py("untypeddefault.py",
      `@router.post("/x")\n` +
      `def h(user=Depends(get_current_user)):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => r.hasAuth)).toEqual([true]);
  });

  it("blesses Annotated[User, Depends(get_current_user)] (typed_parameter, generic_type nesting)", async () => {
    const f = await py("annotateddepends.py",
      `@router.post("/x")\n` +
      `def h(user: Annotated[User, Depends(get_current_user)]):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => r.hasAuth)).toEqual([true]);
  });

  it("blesses Annotated[str, Security(get_api_key)]", async () => {
    const f = await py("annotatedsecurity.py",
      `@router.post("/x")\n` +
      `def h(key: Annotated[str, Security(get_api_key)]):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => r.hasAuth)).toEqual([true]);
  });

  it("does not bless db=Depends(get_db), Depends(get_settings), Depends(pagination_params), or bare Depends()", async () => {
    const f = await py("nonauthdeps.py",
      `@router.post("/db")\n` +
      `def h1(db=Depends(get_db)):\n` +
      `    return {}\n\n` +
      `@router.post("/settings")\n` +
      `def h2(x=Depends(get_settings)):\n` +
      `    return {}\n\n` +
      `@router.post("/pagination")\n` +
      `def h3(x=Depends(pagination_params)):\n` +
      `    return {}\n\n` +
      `@router.post("/bare")\n` +
      `def h4(x=Depends()):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/db auth=false",
      "/settings auth=false",
      "/pagination auth=false",
      "/bare auth=false",
    ]);
  });

  it("blesses Depends(oauth2_scheme) and Depends(verify_token)", async () => {
    const f = await py("oauthverify.py",
      `@router.post("/oauth")\n` +
      `def h1(x=Depends(oauth2_scheme)):\n` +
      `    return {}\n\n` +
      `@router.post("/verify")\n` +
      `def h2(x=Depends(verify_token)):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/oauth auth=true",
      "/verify auth=true",
    ]);
  });

  it("segment near-misses all resolve false: get_author_stats, get_authors, get_jwt_settings, get_api_key_usage_stats, get_current_user_optional, get_current_user_or_none", async () => {
    const f = await py("nearmisses.py",
      `@router.post("/x1")\n` +
      `def h1(a=Depends(get_author_stats)):\n` +
      `    return {}\n\n` +
      `@router.post("/x2")\n` +
      `def h2(a=Depends(get_authors)):\n` +
      `    return {}\n\n` +
      `@router.post("/x3")\n` +
      `def h3(a=Depends(get_jwt_settings)):\n` +
      `    return {}\n\n` +
      `@router.post("/x4")\n` +
      `def h4(a=Depends(get_api_key_usage_stats)):\n` +
      `    return {}\n\n` +
      `@router.post("/x5")\n` +
      `def h5(a=Depends(get_current_user_optional)):\n` +
      `    return {}\n\n` +
      `@router.post("/x6")\n` +
      `def h6(a=Depends(get_current_user_or_none)):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/x1 auth=false",
      "/x2 auth=false",
      "/x3 auth=false",
      "/x4 auth=false",
      "/x5 auth=false",
      "/x6 auth=false",
    ]);
  });

  it("argument text never blesses: Depends(make_client(\"oauth2_url\")) and Depends(Client(url=jwt_issuer_url))", async () => {
    const f = await py("argtextnoblesses.py",
      `@router.post("/x1")\n` +
      `def h1(a=Depends(make_client("oauth2_url"))):\n` +
      `    return {}\n\n` +
      `@router.post("/x2")\n` +
      `def h2(a=Depends(Client(url=jwt_issuer_url))):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/x1 auth=false",
      "/x2 auth=false",
    ]);
  });

  it("blesses class dependencies via CamelCase segments: Depends(JWTBearer()) and Depends(OAuth2PasswordBearer(tokenUrl=\"token\"))", async () => {
    const f = await py("classdeps.py",
      `@router.post("/x1")\n` +
      `def h1(a=Depends(JWTBearer())):\n` +
      `    return {}\n\n` +
      `@router.post("/x2")\n` +
      `def h2(token: str = Depends(OAuth2PasswordBearer(tokenUrl="token"))):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/x1 auth=true",
      "/x2 auth=true",
    ]);
  });

  it("blesses an auth dependency as the third of several params", async () => {
    const f = await py("thirdparam.py",
      `@router.post("/x")\n` +
      `def h(a: int, b: str, user=Depends(get_current_user)):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => r.hasAuth)).toEqual([true]);
  });

  it("resolves the dependencies= kwarg on the route decorator: verify_token true, get_db/get_author_stats/unrelated Security false", async () => {
    const f = await py("depkwarg.py",
      `@router.post("/dep-verify", dependencies=[Depends(verify_token)])\n` +
      `def h1():\n` +
      `    return {}\n\n` +
      `@router.post("/dep-db", dependencies=[Depends(get_db)])\n` +
      `def h2():\n` +
      `    return {}\n\n` +
      `@router.post("/dep-author", dependencies=[Depends(get_author_stats)])\n` +
      `def h3():\n` +
      `    return {}\n\n` +
      `@router.post("/dep-unrelated", dependencies=[Security(some_unrelated_name)])\n` +
      `def h4():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/dep-verify auth=true",
      "/dep-db auth=false",
      "/dep-author auth=false",
      "/dep-unrelated auth=false",
    ]);
  });

  it("does not bless a module-level Annotated alias: the Depends signal is invisible at the param (documented recall gap)", async () => {
    const f = await py("annotatedalias.py",
      `CurrentUser = Annotated[User, Depends(get_current_user)]\n\n` +
      `@router.post("/alias")\n` +
      `def h(user: CurrentUser):\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/alias auth=false"]);
  });
});

describe("per-route validation and rate-limit lanes", () => {
  it("@limiter.limit(...) sets hasRateLimit true, leaves hasAuth false", async () => {
    const f = await py("ratelimit.py",
      `@app.post("/x")\n` +
      `@limiter.limit("5/minute")\n` +
      `def h():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasRateLimit).toBe(true);
    expect(routes[0].hasAuth).toBe(false);
  });

  it("@validate_schema(OrderSchema) sets hasValidation true", async () => {
    const f = await py("validate.py",
      `@app.post("/y")\n` +
      `@validate_schema(OrderSchema)\n` +
      `def h():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasValidation).toBe(true);
  });

  it("a route PATH is not middleware: /validate and /ratelimit paths never bless their own lanes", async () => {
    const f = await py("pathnoise.py",
      `@app.post("/validate")\n` +
      `def h1():\n` +
      `    return {}\n\n` +
      `@app.post("/ratelimit")\n` +
      `def h2():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => r.hasValidation)).toEqual([false, false]);
    expect(routes.map((r) => r.hasRateLimit)).toEqual([false, false]);
  });

  it("a bare route has all three lanes false", async () => {
    const f = await py("bare.py", `@app.get("/bare")\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].hasValidation).toBe(false);
    expect(routes[0].hasRateLimit).toBe(false);
  });
});

describe("extractPythonFileMiddlewareAst", () => {
  const NONE = { hasAuth: false, hasValidation: false, hasRateLimit: false };

  // MIGRATION (body-first): a visible pass-stub body never blesses, whatever the
  // name. require_login/check_auth/verify_token used to bless on NAME alone; now
  // the fully-visible `pass` body resolves not-auth (the name never rescues a
  // visible non-enforcing body). Each keeps its named pass-body negative and gains
  // a body-positive twin proving a real reject body under the same name blesses.
  it("does NOT bless @app.before_request def require_login() with a pass stub (visible body, body-first)", async () => {
    const f = await py("mw.py", `@app.before_request\ndef require_login():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!)).toEqual({
      hasAuth: false, hasValidation: false, hasRateLimit: false,
    });
  });

  it("blesses @app.before_request def require_login() with an abort(401) body (body-positive twin)", async () => {
    const f = await py("mw.py", `@app.before_request\ndef require_login():\n    abort(401)\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(true);
  });

  it("does NOT bless @bp.before_request def check_auth() with a pass stub (CORE name, still not rescued)", async () => {
    const f = await py("mw.py", `@bp.before_request\ndef check_auth():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });

  it("blesses @bp.before_request def check_auth() with an abort(401) body (body-positive twin)", async () => {
    const f = await py("mw.py", `@bp.before_request\ndef check_auth():\n    abort(401)\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(true);
  });

  it("does NOT bless @app.before_request def log_request() (a real hook, not authn)", async () => {
    const f = await py("mw.py", `@app.before_request\ndef log_request():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!)).toEqual(NONE);
  });

  it("does NOT bless ambiguous hooks that lack a CORE segment or an ENFORCE+SUBJECT pair", async () => {
    // metrics hook (SUBJECT login, no ENFORCE), content negotiation (ENFORCE
    // verify, no SUBJECT), cookie setter (SUBJECT token, no ENFORCE; CSRF is not
    // authN).
    const metrics = await py("m1.py", `@app.before_request\ndef track_login_metrics():\n    pass\n`);
    const content = await py("m2.py", `@app.before_request\ndef verify_content_type():\n    pass\n`);
    const csrf = await py("m3.py", `@app.before_request\ndef set_csrf_token():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(metrics.tree!).hasAuth).toBe(false);
    expect(extractPythonFileMiddlewareAst(content.tree!).hasAuth).toBe(false);
    expect(extractPythonFileMiddlewareAst(csrf.tree!).hasAuth).toBe(false);
  });

  it("does NOT bless @app.before_request def verify_token() with a pass stub (visible body, body-first)", async () => {
    const f = await py("mw.py", `@app.before_request\ndef verify_token():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });

  it("blesses @app.before_request def verify_token() with an abort(401) body (body-positive twin)", async () => {
    const f = await py("mw.py", `@app.before_request\ndef verify_token():\n    abort(401)\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(true);
  });

  it("still blesses @verify_token as a ROUTE decorator below @app.post (AUTH_DECORATORS untouched)", async () => {
    const f = await py("routedec.py",
      `@app.post("/x")\n` +
      `@verify_token\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=true"]);
  });

  it("does NOT bless @job.before_request def check_auth() (receiver gate: job is not a router)", async () => {
    const f = await py("mw.py", `@job.before_request\ndef check_auth():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!)).toEqual(NONE);
  });

  it("blesses add_middleware with an auth-segment class name (AuthMiddleware, AuthenticationMiddleware)", async () => {
    const a = await py("mw.py", `app.add_middleware(AuthMiddleware)\n`);
    const b = await py("mw.py", `app.add_middleware(AuthenticationMiddleware, backend=JWTBackend())\n`);
    expect(extractPythonFileMiddlewareAst(a.tree!).hasAuth).toBe(true);
    expect(extractPythonFileMiddlewareAst(b.tree!).hasAuth).toBe(true);
  });

  it("does NOT bless add_middleware with a non-auth class (CORSMiddleware, GZipMiddleware)", async () => {
    const cors = await py("mw.py", `app.add_middleware(CORSMiddleware, allow_origins=["*"])\n`);
    const gzip = await py("mw.py", `app.add_middleware(GZipMiddleware)\n`);
    expect(extractPythonFileMiddlewareAst(cors.tree!).hasAuth).toBe(false);
    expect(extractPythonFileMiddlewareAst(gzip.tree!).hasAuth).toBe(false);
  });

  it("does NOT bless add_middleware(AuthorTrackingMiddleware) / (AuthorNotesMiddleware): 'Author' is a segment, not 'Auth'", async () => {
    const track = await py("mw.py", `app.add_middleware(AuthorTrackingMiddleware)\n`);
    const notes = await py("mw.py", `app.add_middleware(AuthorNotesMiddleware)\n`);
    expect(extractPythonFileMiddlewareAst(track.tree!).hasAuth).toBe(false);
    expect(extractPythonFileMiddlewareAst(notes.tree!).hasAuth).toBe(false);
  });

  it("blesses a router/app constructor dependencies=[Depends(auth)] kwarg", async () => {
    const router = await py("mw.py", `router = APIRouter(dependencies=[Depends(get_current_user)])\n`);
    const app = await py("mw.py", `app = FastAPI(dependencies=[Depends(verify_token)])\n`);
    expect(extractPythonFileMiddlewareAst(router.tree!).hasAuth).toBe(true);
    expect(extractPythonFileMiddlewareAst(app.tree!).hasAuth).toBe(true);
  });

  it("does NOT bless a constructor with no auth dependency (prefix-only, get_db)", async () => {
    const prefix = await py("mw.py", `router = APIRouter(prefix="/admin")\n`);
    const db = await py("mw.py", `router = APIRouter(dependencies=[Depends(get_db)])\n`);
    expect(extractPythonFileMiddlewareAst(prefix.tree!)).toEqual(NONE);
    expect(extractPythonFileMiddlewareAst(db.tree!)).toEqual(NONE);
  });

  it("does NOT bless a bare unassigned APIRouter(dependencies=[Depends(auth)]) (no resolvable scope, never-false-bless)", async () => {
    const f = await py("mw.py", `APIRouter(dependencies=[Depends(verify_token)])\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!)).toEqual(NONE);
  });

  it("lanes: SlowAPIMiddleware -> rateLimit, ValidationMiddleware -> validation, none -> all false", async () => {
    const rate = await py("mw.py", `app.add_middleware(SlowAPIMiddleware)\n`);
    const val = await py("mw.py", `app.add_middleware(ValidationMiddleware)\n`);
    const none = await py("mw.py", `app.add_middleware(GZipMiddleware)\n`);
    expect(extractPythonFileMiddlewareAst(rate.tree!)).toEqual({
      hasAuth: false, hasValidation: false, hasRateLimit: true,
    });
    expect(extractPythonFileMiddlewareAst(val.tree!)).toEqual({
      hasAuth: false, hasValidation: true, hasRateLimit: false,
    });
    expect(extractPythonFileMiddlewareAst(none.tree!)).toEqual(NONE);
  });

  it("a validation-only before_request hook sets validation, never auth (lanes independent)", async () => {
    const f = await py("mw.py", `@app.before_request\ndef validate_payload():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!)).toEqual({
      hasAuth: false, hasValidation: true, hasRateLimit: false,
    });
  });

  it("empty and comments-only files are all false", async () => {
    const empty = await py("mw.py", ``);
    const comments = await py("mw.py", `# just a comment\n# another\n`);
    expect(extractPythonFileMiddlewareAst(empty.tree!)).toEqual(NONE);
    expect(extractPythonFileMiddlewareAst(comments.tree!)).toEqual(NONE);
  });

  it("CRITICAL: a per-route @login_required is NOT a file-level auth bless (the regex over-bless the AST kills)", async () => {
    const f = await py("mw.py",
      `@app.post("/x")\n` +
      `@login_required\n` +
      `def x():\n` +
      `    return {}\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!)).toEqual(NONE);
  });
});

describe("receiver-scoped middleware inheritance (via extractPythonRoutesAst)", () => {
  it("a before_request on admin_bp blesses the admin route but NOT a co-located public_bp route", async () => {
    const f = await py("mixed.py",
      `@admin_bp.before_request\n` +
      `def require_login():\n` +
      `    abort(401)\n\n` +
      `@admin_bp.route("/users", methods=["POST"])\n` +
      `def create_user():\n` +
      `    return {}\n\n` +
      `@public_bp.route("/webhook", methods=["POST"])\n` +
      `def webhook():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/users auth=true",
      "/webhook auth=false",
    ]);
    // File-level OR is unchanged public shape: the file DOES have auth middleware.
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(true);
  });

  it("a FastAPI constructor dependency on admin_router blesses only its routes, not public_router's", async () => {
    const f = await py("routers.py",
      `admin_router = APIRouter(dependencies=[Depends(get_current_user)])\n` +
      `public_router = APIRouter()\n\n` +
      `@admin_router.post("/admin")\n` +
      `def admin_op():\n` +
      `    return {}\n\n` +
      `@public_router.post("/public")\n` +
      `def public_op():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/admin auth=true",
      "/public auth=false",
    ]);
  });

  it("an @app.before_request hook is file-wide: a blueprint route inherits it", async () => {
    const f = await py("appwide.py",
      `@app.before_request\n` +
      `def require_login():\n` +
      `    abort(401)\n\n` +
      `@orders_bp.route("/x", methods=["POST"])\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=true"]);
  });

  it("a @bp.before_app_request hook is app-wide: an app route inherits it", async () => {
    const f = await py("beforeapp.py",
      `@bp.before_app_request\n` +
      `def require_login():\n` +
      `    abort(401)\n\n` +
      `@app.post("/x")\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=true"]);
  });
});

describe("extractPythonRoutesAst: Django REST function views", () => {
  it("extracts @api_view([\"POST\"]) as one route, line = the @api_view decorator line", async () => {
    const f = await py("views.py",
      `@api_view(["POST"])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /create_thing auth=false",
    ]);
    expect(routes[0].line).toBe(1);
  });

  it("prefers the mutating verb: @api_view([\"GET\", \"POST\"]) -> POST", async () => {
    const f = await py("views.py",
      `@api_view(["GET", "POST"])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /create_thing"]);
  });

  it("defaults @api_view() with no arguments to GET (DRF documented default)", async () => {
    const f = await py("views.py",
      `@api_view()\n` +
      `def list_things(request):\n` +
      `    return Response([])\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /list_things"]);
  });

  it("blesses @permission_classes([IsAuthenticated]) BELOW @api_view (applied first, enforced)", async () => {
    const f = await py("views.py",
      `@api_view(["POST"])\n` +
      `@permission_classes([IsAuthenticated])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/create_thing auth=true"]);
  });

  it("does NOT bless @permission_classes([IsAuthenticated]) ABOVE @api_view: decorators apply bottom-up, so api_view builds the wrapped view before the permission attribute is set", async () => {
    const f = await py("views.py",
      `@permission_classes([IsAuthenticated])\n` +
      `@api_view(["POST"])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/create_thing auth=false"]);
  });

  it("does not bless @permission_classes([AllowAny])", async () => {
    const f = await py("views.py",
      `@api_view(["POST"])\n` +
      `@permission_classes([AllowAny])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/create_thing auth=false"]);
  });

  it("does not bless @permission_classes([IsAuthenticatedOrReadOnly]): conditional per-method permission is ambiguous, resolves false", async () => {
    const f = await py("views.py",
      `@api_view(["POST"])\n` +
      `@permission_classes([IsAuthenticatedOrReadOnly])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/create_thing auth=false"]);
  });

  it("does not bless @api_view([\"POST\"]) with no permission_classes at all", async () => {
    const f = await py("views.py",
      `@api_view(["POST"])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/create_thing auth=false"]);
  });

  it("class-based views (APIView/ViewSet) are pinned OUT: zero routes even with permission_classes set", async () => {
    const f = await py("views.py",
      `class MyView(APIView):\n` +
      `    permission_classes = [IsAuthenticated]\n\n` +
      `    def post(self, request):\n` +
      `        return Response({})\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("urls.py path(...) registrations emit zero routes: cross-file resolution is a non-goal", async () => {
    const f = await py("urls.py",
      `urlpatterns = [path("things/", views.create_thing)]\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

// ─── Task 6: adversarial hardening ──────────────────────────────────────────
//
// Every fixture here is fed straight to extractPythonRoutesAst on whatever tree
// tree-sitter produces (error-recovered or clean). The bar is twofold: the
// extractor must never THROW on hostile input, and it must never emit a route
// with hasAuth:true that the source does not actually protect. The
// security-critical member of this group is the merged decorated_definition
// (a syntax error fusing two handlers' decorators into one node): blessing, or
// even extracting, across that boundary would let one handler inherit another's
// auth decorators.
describe("malformed and adversarial input", () => {
  const dds = (f: { tree?: unknown }) =>
    (f as { tree: { rootNode: { descendantsOfType(t: string): unknown[] } } }).tree.rootNode
      .descendantsOfType("decorated_definition")
      .filter((n): n is { hasError: boolean } => n !== null) as Array<{ hasError: boolean }>;

  it("does not throw and finds zero routes when an unclosed decorator paren erases the file's decorator structure", async () => {
    // Unclosed paren early, a fully valid @app.route("/still-good") later. Error
    // recovery does not produce a decorated_definition for either route (the
    // whole decorator structure is erased), so the AST path finds nothing. Recall
    // on this file is preserved at the DETECT level, where rootNode.hasError routes
    // the file to the regex extractor (see security-consistency.test.ts, Task 6).
    const f = await py("unclosed.py",
      `@app.route("/broken"\n` +
      `@app.route("/still-good")\n` +
      `def good():\n` +
      `    return {}\n`);
    expect(f.tree!.rootNode.hasError).toBe(true);
    expect(() => extractPythonRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("CROSS-BLESS GUARD: a missing def colon fuses both handlers into one errored dd, which emits ZERO routes", async () => {
    // PINNED EXACT SOURCE (the merged-dd shape is variant-sensitive): the missing
    // colon after `def bad()` makes tree-sitter fuse everything from /bad through
    // /good into a SINGLE decorated_definition holding
    // [decorator, decorator, ERROR, decorator, function_definition] with
    // dd.hasError === true. The dd.hasError skip means /good can never inherit
    // /bad's @login_required and /bad can never be silently dropped as authed —
    // the extractor emits nothing at all from the fused node. This is the
    // security-critical guard of Task 6.
    const f = await py("mergedcolon.py",
      `@app.post("/bad")\n` +
      `@login_required\n` +
      `def bad()\n` +
      `    return 1\n` +
      `@app.post("/good")\n` +
      `def good():\n` +
      `    return 2\n`);
    expect(f.tree!.rootNode.hasError).toBe(true);
    const errored = dds(f);
    expect(errored).toHaveLength(1);
    expect(errored[0].hasError).toBe(true);
    expect(() => extractPythonRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("extracts a clean sibling dd's route while skipping a dd whose handler body has a parse error", async () => {
    // The error is confined to /bad's body (`x = = 1`), so /bad's dd carries
    // hasError and is skipped, but /good parses into its own clean dd and IS
    // extracted. rootNode.hasError is cumulative (true for the whole file), which
    // is why DETECT routes this file to the regex path; the extractor is exercised
    // directly here to prove the per-dd skip is surgical, not file-wide.
    const f = await py("bodyerror.py",
      `@app.post("/bad")\n` +
      `def bad():\n` +
      `    x = = 1\n\n` +
      `@app.post("/good")\n` +
      `def good():\n` +
      `    return 2\n`);
    expect(() => extractPythonRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual(["POST /good auth=false"]);
  });

  it("returns [] with no throw for garbled binary-ish content; middleware is all-false", async () => {
    const f = await py("garbled.py", ` ÿþ garbage   def ( ) : :`);
    expect(() => extractPythonRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
    expect(extractPythonFileMiddlewareAst(f.tree!)).toEqual({
      hasAuth: false, hasValidation: false, hasRateLimit: false,
    });
  });

  it("returns [] for an empty file and a comments-only file", async () => {
    const empty = await py("empty.py", ``);
    const comments = await py("comments.py", `# just a comment\n# @app.route("/x")\n`);
    expect(extractPythonRoutesAst(empty.tree!, empty.relativePath)).toEqual([]);
    expect(extractPythonRoutesAst(comments.tree!, comments.relativePath)).toEqual([]);
  });

  it("does not extract a route from a module docstring or an assigned multiline string that contains route text", async () => {
    const f = await py("strings.py",
      `"""\n` +
      `@app.route("/fake", methods=["POST"])\n` +
      `"""\n` +
      `x = """\n` +
      `@app.route("/fake2", methods=["POST"])\n` +
      `"""\n`);
    expect(f.tree!.rootNode.hasError).toBe(false);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not extract @app.route(...) decorating a CLASS (definition.type gate)", async () => {
    const f = await py("routeclass.py", `@app.route("/x")\nclass Foo:\n    pass\n`);
    expect(f.tree!.rootNode.hasError).toBe(false);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("extracts a route-decorated method inside a class body (recursive descendant walk)", async () => {
    const f = await py("methodroute.py",
      `class Foo:\n` +
      `    @app.route("/x")\n` +
      `    def handler(self):\n` +
      `        return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /x"]);
  });

  it("extracts a route-decorated nested function (no false leak, no drop)", async () => {
    const f = await py("nested.py",
      `def outer():\n` +
      `    @app.post("/inner")\n` +
      `    def inner():\n` +
      `        return {}\n` +
      `    return inner\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /inner"]);
  });

  it("emits two RouteInfos for an identical route decorator duplicated on two functions (no dedup, pinned deliberate)", async () => {
    const f = await py("dup.py",
      `@app.post("/x")\n` +
      `def a():\n` +
      `    return {}\n\n` +
      `@app.post("/x")\n` +
      `def b():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x", "POST /x"]);
  });

  it("resolves a kwarg flood to POST /x (path first, methods read, other kwargs ignored)", async () => {
    const f = await py("flood.py",
      `@app.route("/x", methods=["POST"], strict_slashes=False, endpoint="e", defaults={"a": 1})\n` +
      `def h():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("does not throw on a conditional decorator and does not bless it: @(login_required if PROD else noop)", async () => {
    // The conditional expression is neither an identifier, an attribute, nor a
    // recognized auth call, so it can never bless; the sibling @app.post route is
    // still extracted, unauthed.
    const f = await py("conditional.py",
      `@(login_required if PROD else noop)\n` +
      `@app.post("/x")\n` +
      `def h():\n` +
      `    return {}\n`);
    expect(() => extractPythonRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual(["POST /x auth=false"]);
  });

  it("ignores getattr(app, \"route\")(\"/x\") — the callee is a call, not an app/router attribute", async () => {
    const f = await py("getattr.py",
      `@getattr(app, "route")("/x")\n` +
      `def h():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  // ── Unicode ──
  it("handles a unicode path and a unicode handler name, blessing @login_required stacked BELOW the route decorator", async () => {
    const f = await py("unicode.py",
      `@app.route("/café", methods=["POST"])\n` +
      `@login_required\n` +
      `def crée_commande():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual(["POST /café auth=true"]);
  });

  it("does not bless a unicode auth-decorator name (@認証必須): recognition is an ASCII lexicon", async () => {
    const f = await py("unicodeauth.py",
      `@app.post("/x")\n` +
      `@認証必須\n` +
      `def h():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });

  it("does not extract a unicode receiver (@ルーター.route): a non-ASCII receiver is a recognition miss, never a bless", async () => {
    const f = await py("unicoderecv.py",
      `@ルーター.route("/x")\n` +
      `def h():\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not bless body-only auth (if not g.user: abort(401) inside the handler)", async () => {
    // In-body enforcement is invisible to a decorator/parameter-level check;
    // resolving it to false is the correct never-false-bless direction (an
    // over-flag, never an over-bless).
    const f = await py("bodyauth.py",
      `@app.post("/x")\n` +
      `def h():\n` +
      `    if not g.user:\n` +
      `        abort(401)\n` +
      `    return {}\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });
});

// ─── Task 6: task-review pins (documenting existing behavior; NOT changing it) ──
describe("documented trade-offs (task-review pins)", () => {
  it("a fully-literal methods list of only unrecognized verbs resolves GET and exits the mutating vote", async () => {
    // methods=["MKCOL"] is fully visible but holds no HTTP_VERBS member, so it is
    // treated like an empty literal list: GET (Flask's default), which keeps the
    // route OUT of the mutating auth vote. Documented trade from the Task 2
    // review: an exotic-but-real WebDAV verb is not surfaced as mutating. Not
    // ambiguity (the list is fully readable), so "ALL" would be wrong here.
    const f = await py("mkcol.py", `@app.route("/x", methods=["MKCOL"])\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
  });

  it("does not bless custom or non-IsAuthenticated permission classes: permission_classes([IsAdminUser]) and ([FooPermission])", async () => {
    // Only IsAuthenticated is in PERMISSION_AUTH. IsAdminUser is a real DRF class
    // that requires staff, but it is not in the narrow whitelist, and FooPermission
    // is an unknown custom class; both resolve hasAuth:false per never-false-bless
    // (an unrecognized permission class is ambiguity, which never blesses).
    const f = await py("custcompermclass.py",
      `@api_view(["POST"])\n` +
      `@permission_classes([IsAdminUser])\n` +
      `def a(request):\n` +
      `    return Response({})\n\n` +
      `@api_view(["POST"])\n` +
      `@permission_classes([FooPermission])\n` +
      `def b(request):\n` +
      `    return Response({})\n`);
    expect(extractPythonRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/a auth=false",
      "/b auth=false",
    ]);
  });
});

// ─── Final review Fix 1: permission_classes blesses ONLY api_view routes ────
//
// @permission_classes([IsAuthenticated]) is DRF machinery. It is runtime-inert
// when stacked under a Flask (@app.route) or FastAPI (@router.post) route
// decorator, so it must never bless those routes; it may bless only a route
// derived from @api_view, and only when it sits BELOW @api_view (DRF's own
// positional rule).
describe("permission_classes is api_view-scoped (never blesses Flask/FastAPI routes)", () => {
  it("does NOT bless a Flask @app.post route with @permission_classes([IsAuthenticated]) below it", async () => {
    const f = await py("flaskperm.py",
      `@app.post("/x")\n` +
      `@permission_classes([IsAuthenticated])\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });

  it("does NOT bless a FastAPI @router.post route with @permission_classes([IsAuthenticated]) below it", async () => {
    const f = await py("routerperm.py",
      `@router.post("/x")\n` +
      `@permission_classes([IsAuthenticated])\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });

  it("still blesses an @api_view route with @permission_classes([IsAuthenticated]) below it (unchanged)", async () => {
    const f = await py("apiviewperm.py",
      `@api_view(["POST"])\n` +
      `@permission_classes([IsAuthenticated])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/create_thing auth=true"]);
  });
});

// ─── Final review Fix 2: optional-auth veto for hooks and middleware classes ─
//
// The optional-flavored veto that the Depends path already applies (an
// optional/anonymous dependency admits unauthenticated requests, so it must not
// bless) was missing from the before_request hook-name check and the
// add_middleware class-name check. Both now veto on the optionality segments.
describe("optional-auth veto: hook names and middleware class names", () => {
  it("does NOT bless @app.before_request def optional_authenticate() (optional veto)", async () => {
    const f = await py("opthook.py", `@app.before_request\ndef optional_authenticate():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });

  it("optional_authenticate before_request hook does not bless its receiver's routes", async () => {
    const f = await py("opthookroute.py",
      `@app.before_request\n` +
      `def optional_authenticate():\n` +
      `    return None\n\n` +
      `@app.route("/x", methods=["POST"])\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });

  it("does NOT bless app.add_middleware(OptionalAuthMiddleware) (optional veto)", async () => {
    const f = await py("optmw.py", `app.add_middleware(OptionalAuthMiddleware)\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });
});

// ─── Final review Fix 3: @api_view hidden-verb list resolves ALL, not GET ────
//
// Aligns asApiViewDecorator with resolveMethod's ALL-on-unresolvable
// convention: a list holding a non-string element (a variable verb) is
// statically unresolvable, so it stays in the mutating vote as ALL rather than
// silently defaulting GET.
describe("@api_view hidden-verb list resolves ALL", () => {
  it("resolves @api_view([METHOD]) to ALL (hidden non-string element, unresolvable)", async () => {
    const f = await py("apiviewvar.py",
      `@api_view([METHOD])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("resolves @api_view([*BASE, \"POST\"]) to POST (a visible literal still resolves it)", async () => {
    const f = await py("apiviewsplat.py",
      `@api_view([*BASE, "POST"])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });
});

// ─── Final review Fix 4: lexicon boundary pins (sets unchanged) ──────────────
//
// The shipped AUTH_ENFORCE_SEGMENTS / AUTH_SUBJECT_SEGMENTS sets are broader
// than the plan's Integration contract (they add protect(ed)/restrict(ed)/
// verified and users/jwt/role(s)/admin/credentials). The sets are deliberately
// left unchanged pending owner lexicon sign-off; these tests pin the closest
// non-auth neighbors that must stay FALSE so the broadened surface has an
// explicit boundary.
describe("hook-name lexicon boundary pins (Fix 4)", () => {
  it("does NOT bless restricted_zone_redirect (ENFORCE restricted, no SUBJECT)", async () => {
    const f = await py("h1.py", `@app.before_request\ndef restricted_zone_redirect():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });

  it("does NOT bless track_user_metrics (SUBJECT user, no ENFORCE/CORE)", async () => {
    const f = await py("h2.py", `@app.before_request\ndef track_user_metrics():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });

  it("does NOT bless role_labels (SUBJECT role, no ENFORCE)", async () => {
    const f = await py("h3.py", `@app.before_request\ndef role_labels():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });

  it("does NOT bless protect_branch (ENFORCE protect, no SUBJECT)", async () => {
    const f = await py("h4.py", `@app.before_request\ndef protect_branch():\n    pass\n`);
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });
});

// ─── EXPOSURE FIXED (was: two-tier hook lexicon false-bless) ─────────────────
//
// These fixtures used to bless on NAME alone (ENFORCE+SUBJECT: verify+user,
// protect+user). Body-first classification fixes the exposure: a fully-visible
// hook body that does not enforce auth resolves not-auth, so an email-confirming
// verify_user_email and a data-scrubbing protect_user_data no longer bless their
// receiver's routes — flat not-auth, no hedge (the body is visible, so it is not
// even "unsure"). The name never rescues a visible non-enforcing body.
describe("EXPOSURE FIXED: attributive non-auth hooks resolve flat not-auth (body-first)", () => {
  it("verify_user_email that only sends a confirmation email does NOT bless (auth=false, no unsure hedge)", async () => {
    const f = await py("exposure-verify-user-email.py",
      `@app.before_request\n` +
      `def verify_user_email():\n` +
      `    send_confirmation_email(g.user.email)\n` +
      `    return None\n\n` +
      `@app.route("/x", methods=["POST"])\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("protect_user_data that only scrubs stored data does NOT bless (auth=false, no unsure hedge)", async () => {
    const f = await py("exposure-protect-user-data.py",
      `@app.before_request\n` +
      `def protect_user_data():\n` +
      `    scrub_pii(record)\n` +
      `    return None\n\n` +
      `@app.route("/y", methods=["POST"])\n` +
      `def y():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/y auth=false"]);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });
});

// ─── Task 6: the systematic never-false-bless sweep ─────────────────────────
//
// A single registry of every ambiguity / "cannot determine" branch the Python
// extractor has, restated as a fixture with ground truth. ONE table-driven test
// asserts the invariant that matters: no route whose ground truth is
// authed:false is ever emitted with hasAuth:true. Positive (authed:true) entries
// are documentation only — the assertion filters to the negatives. Any NEW
// python fixture added in a later task MUST be registered here so the invariant
// keeps whole-module coverage. Broken-parse fixtures are included too: they emit
// nothing, and `emitted?.hasAuth ?? false` treats "not emitted" as not-blessed.
const NEVER_FALSE_BLESS_SWEEP: Array<{
  name: string;
  source: string;
  groundTruth: Array<{ path: string; method: string; authed: boolean }>;
}> = [
  // ── Decorator-order (positional auth binding) ──
  {
    name: "auth-above-route",
    source:
      `@login_required\n@app.post("/orders")\ndef create_order():\n    return {}\n`,
    groundTruth: [{ path: "/orders", method: "POST", authed: false }],
  },
  {
    name: "mixed-stack-a-b",
    source:
      `@app.post("/a")\n@login_required\n@app.post("/b")\ndef h():\n    return {}\n`,
    groundTruth: [
      { path: "/a", method: "POST", authed: true },
      { path: "/b", method: "POST", authed: false },
    ],
  },
  // ── flask-jwt-extended optional auth ──
  {
    name: "jwt-optional-true",
    source:
      `@app.post("/x")\n@jwt_required(optional=True)\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "jwt-optional-flag",
    source:
      `@app.post("/x")\n@jwt_required(optional=OPTIONAL_AUTH)\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  // ── Decorator lexicon near-misses ──
  {
    name: "feature-requires",
    source:
      `@app.post("/a")\n@feature.requires("new_ui")\ndef a():\n    return {}\n\n` +
      `@app.post("/b")\n@pytest.mark.requires\ndef b():\n    return {}\n`,
    groundTruth: [
      { path: "/a", method: "POST", authed: false },
      { path: "/b", method: "POST", authed: false },
    ],
  },
  {
    name: "author-stats-substring",
    source: `@app.post("/x")\n@author_stats\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "track-metrics-and-guard",
    source:
      `@app.post("/a")\n@track_metrics\ndef a():\n    return {}\n\n` +
      `@app.post("/b")\n@guard\ndef b():\n    return {}\n`,
    groundTruth: [
      { path: "/a", method: "POST", authed: false },
      { path: "/b", method: "POST", authed: false },
    ],
  },
  {
    name: "adjacent-noleak",
    source:
      `@app.post("/a")\n@login_required\ndef a():\n    return {}\n\n` +
      `@app.post("/b")\ndef b():\n    return {}\n`,
    groundTruth: [
      { path: "/a", method: "POST", authed: true },
      { path: "/b", method: "POST", authed: false },
    ],
  },
  // ── Unrecognized / invisible auth signals (all resolve false) ──
  {
    name: "unicode-auth-decorator",
    source: `@app.post("/x")\n@認証必須\ndef h():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "conditional-decorator",
    source:
      `@(login_required if PROD else noop)\n@app.post("/x")\ndef h():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "body-only-auth",
    source:
      `@app.post("/x")\ndef h():\n    if not g.user:\n        abort(401)\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  // ── FastAPI Depends: non-auth dependencies ──
  {
    name: "depends-nonauth",
    source:
      `@router.post("/db")\ndef h1(db=Depends(get_db)):\n    return {}\n\n` +
      `@router.post("/settings")\ndef h2(x=Depends(get_settings)):\n    return {}\n\n` +
      `@router.post("/pagination")\ndef h3(x=Depends(pagination_params)):\n    return {}\n\n` +
      `@router.post("/bare")\ndef h4(x=Depends()):\n    return {}\n`,
    groundTruth: [
      { path: "/db", method: "POST", authed: false },
      { path: "/settings", method: "POST", authed: false },
      { path: "/pagination", method: "POST", authed: false },
      { path: "/bare", method: "POST", authed: false },
    ],
  },
  // ── Depends segment near-miss set (brief-mandated) ──
  {
    name: "depends-nearmiss",
    source:
      `@router.post("/x1")\ndef h1(a=Depends(get_author_stats)):\n    return {}\n\n` +
      `@router.post("/x2")\ndef h2(a=Depends(get_authors)):\n    return {}\n\n` +
      `@router.post("/x3")\ndef h3(a=Depends(get_jwt_settings)):\n    return {}\n\n` +
      `@router.post("/x4")\ndef h4(a=Depends(get_api_key_usage_stats)):\n    return {}\n\n` +
      `@router.post("/x5")\ndef h5(a=Depends(get_current_user_optional)):\n    return {}\n\n` +
      `@router.post("/x6")\ndef h6(a=Depends(get_current_user_or_none)):\n    return {}\n`,
    groundTruth: [
      { path: "/x1", method: "POST", authed: false },
      { path: "/x2", method: "POST", authed: false },
      { path: "/x3", method: "POST", authed: false },
      { path: "/x4", method: "POST", authed: false },
      { path: "/x5", method: "POST", authed: false },
      { path: "/x6", method: "POST", authed: false },
    ],
  },
  // ── Depends: argument text never blesses (incl. Depends(Client(url=jwt_issuer_url))) ──
  {
    name: "depends-argtext",
    source:
      `@router.post("/x1")\ndef h1(a=Depends(make_client("oauth2_url"))):\n    return {}\n\n` +
      `@router.post("/x2")\ndef h2(a=Depends(Client(url=jwt_issuer_url))):\n    return {}\n`,
    groundTruth: [
      { path: "/x1", method: "POST", authed: false },
      { path: "/x2", method: "POST", authed: false },
    ],
  },
  // ── dependencies= kwarg on the route decorator ──
  {
    name: "dep-kwarg",
    source:
      `@router.post("/dep-verify", dependencies=[Depends(verify_token)])\ndef h1():\n    return {}\n\n` +
      `@router.post("/dep-db", dependencies=[Depends(get_db)])\ndef h2():\n    return {}\n\n` +
      `@router.post("/dep-author", dependencies=[Depends(get_author_stats)])\ndef h3():\n    return {}\n\n` +
      `@router.post("/dep-unrelated", dependencies=[Security(some_unrelated_name)])\ndef h4():\n    return {}\n`,
    groundTruth: [
      { path: "/dep-verify", method: "POST", authed: true },
      { path: "/dep-db", method: "POST", authed: false },
      { path: "/dep-author", method: "POST", authed: false },
      { path: "/dep-unrelated", method: "POST", authed: false },
    ],
  },
  // ── Module-level Annotated alias (Depends invisible at the param) ──
  {
    name: "annotated-alias",
    source:
      `CurrentUser = Annotated[User, Depends(get_current_user)]\n\n` +
      `@router.post("/alias")\ndef h(user: CurrentUser):\n    return {}\n`,
    groundTruth: [{ path: "/alias", method: "POST", authed: false }],
  },
  // ── Mixed-receiver middleware files (brief-mandated) ──
  {
    name: "mixed-bp",
    source:
      `@admin_bp.before_request\ndef require_login():\n    abort(401)\n\n` +
      `@admin_bp.route("/users", methods=["POST"])\ndef create_user():\n    return {}\n\n` +
      `@public_bp.route("/webhook", methods=["POST"])\ndef webhook():\n    return {}\n`,
    groundTruth: [
      { path: "/users", method: "POST", authed: true },
      { path: "/webhook", method: "POST", authed: false },
    ],
  },
  {
    name: "mixed-router",
    source:
      `admin_router = APIRouter(dependencies=[Depends(get_current_user)])\n` +
      `public_router = APIRouter()\n\n` +
      `@admin_router.post("/admin")\ndef admin_op():\n    return {}\n\n` +
      `@public_router.post("/public")\ndef public_op():\n    return {}\n`,
    groundTruth: [
      { path: "/admin", method: "POST", authed: true },
      { path: "/public", method: "POST", authed: false },
    ],
  },
  // ── DRF permission_classes negatives ──
  {
    name: "perm-allowany",
    source:
      `@api_view(["POST"])\n@permission_classes([AllowAny])\ndef create_thing(request):\n    return Response({})\n`,
    groundTruth: [{ path: "/create_thing", method: "POST", authed: false }],
  },
  {
    name: "perm-readonly",
    source:
      `@api_view(["POST"])\n@permission_classes([IsAuthenticatedOrReadOnly])\ndef create_thing(request):\n    return Response({})\n`,
    groundTruth: [{ path: "/create_thing", method: "POST", authed: false }],
  },
  {
    name: "perm-above-apiview",
    source:
      `@permission_classes([IsAuthenticated])\n@api_view(["POST"])\ndef create_thing(request):\n    return Response({})\n`,
    groundTruth: [{ path: "/create_thing", method: "POST", authed: false }],
  },
  {
    name: "apiview-noperm",
    source:
      `@api_view(["POST"])\ndef create_thing(request):\n    return Response({})\n`,
    groundTruth: [{ path: "/create_thing", method: "POST", authed: false }],
  },
  {
    name: "perm-custom",
    source:
      `@api_view(["POST"])\n@permission_classes([IsAdminUser])\ndef a(request):\n    return Response({})\n\n` +
      `@api_view(["POST"])\n@permission_classes([FooPermission])\ndef b(request):\n    return Response({})\n`,
    groundTruth: [
      { path: "/a", method: "POST", authed: false },
      { path: "/b", method: "POST", authed: false },
    ],
  },
  // permission_classes is DRF-only and runtime-inert under a Flask route
  // decorator: it must never bless an @app/@router route (Fix 1).
  {
    name: "flask-perm",
    source:
      `@app.post("/x")\n@permission_classes([IsAuthenticated])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  // A before_request hook with a non-auth name (SUBJECT login, no ENFORCE/CORE)
  // must not bless the routes on its receiver (two-tier negative, route level).
  {
    name: "before-request-nonauth-hook",
    source:
      `@app.before_request\ndef track_login_metrics():\n    return None\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  // ── Broken-parse fixtures (emit nothing; nothing can be blessed) ──
  {
    name: "merged-dd-missing-colon",
    source:
      `@app.post("/bad")\n@login_required\ndef bad()\n    return 1\n` +
      `@app.post("/good")\ndef good():\n    return 2\n`,
    groundTruth: [
      { path: "/bad", method: "POST", authed: false },
      { path: "/good", method: "POST", authed: false },
    ],
  },
  {
    name: "body-error-clean-sibling",
    source:
      `@app.post("/bad")\ndef bad():\n    x = = 1\n\n` +
      `@app.post("/good")\ndef good():\n    return 2\n`,
    groundTruth: [
      { path: "/bad", method: "POST", authed: false },
      { path: "/good", method: "POST", authed: false },
    ],
  },
];

describe("never-false-bless sweep", () => {
  it("no route with ground truth authed:false is ever emitted hasAuth:true", async () => {
    for (const entry of NEVER_FALSE_BLESS_SWEEP) {
      const f = await py(`sweep/${entry.name}.py`, entry.source);
      const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
      for (const gt of entry.groundTruth.filter((g) => !g.authed)) {
        const emitted = routes.find((r) => r.path === gt.path && r.method === gt.method);
        expect(emitted?.hasAuth ?? false, `${entry.name}: ${gt.method} ${gt.path}`).toBe(false);
      }
    }
  });
});

// ─── ADDENDUM Task 1: body-signature analyzer (pure helpers) ────────────────
//
// These test the pure, exported helpers directly: a hook body node in ->
// "reject" | "none" | "opaque" (bodyAuthSignature), and the precedence layer
// classifyHookAuth -> "auth" | "not-auth" | "unsure". The governing invariant
// (NEVER-FALSE-BLESS) means "auth"/"reject" only ever fires on a verified
// rejection signature; every ambiguity resolves away from a bless.

// Select the body + defs of a named function ("hook" by default). Selecting by
// name (not descendantsOfType[0]) keeps one-hop fixtures — where a same-file
// helper is defined before the hook — unambiguous.
async function hookBody(src: string, fnName = "hook") {
  const f = await py("body.py", src);
  const root = f.tree!.rootNode;
  const defs = collectFunctionDefs(root);
  const named = root
    .descendantsOfType("function_definition")
    .filter((d): d is SyntaxNode => d !== null);
  const def = named.find((d) => d.childForFieldName("name")?.text === fnName) ?? named[0]!;
  return { body: def.childForFieldName("body")!, defs };
}
const sig = async (src: string, fnName = "hook") => {
  const { body, defs } = await hookBody(src, fnName);
  return bodyAuthSignature(body, defs);
};

describe("body-signature grammar prerequisites", () => {
  const rootOf = async (src: string) => (await py("g.py", src)).tree!.rootNode;
  const noError = (n: SyntaxNode) => expect(n.hasError).toBe(false);

  it("abort(401): call > identifier + argument_list > integer", async () => {
    const root = await rootOf(`def f():\n    abort(401)\n`);
    noError(root);
    const call = root.descendantsOfType("call")[0]!;
    expect(call.childForFieldName("function")!.type).toBe("identifier");
    expect(call.childForFieldName("function")!.text).toBe("abort");
    const args = call.childForFieldName("arguments")!;
    expect(args.type).toBe("argument_list");
    expect(args.namedChild(0)!.type).toBe("integer");
    expect(args.namedChild(0)!.text).toBe("401");
  });

  it("raise HTTPException(...): raise_statement > namedChild(0) call with keyword_argument", async () => {
    const root = await rootOf(`def f():\n    raise HTTPException(status_code=401)\n`);
    noError(root);
    const rs = root.descendantsOfType("raise_statement")[0]!;
    const call = rs.namedChild(0)!;
    expect(call.type).toBe("call");
    expect(call.childForFieldName("function")!.text).toBe("HTTPException");
    const kw = call.childForFieldName("arguments")!.namedChild(0)!;
    expect(kw.type).toBe("keyword_argument");
    expect(kw.childForFieldName("name")!.text).toBe("status_code");
  });

  it("bare raise PermissionDenied: raise_statement > identifier, NOT a call", async () => {
    const root = await rootOf(`def f():\n    raise PermissionDenied\n`);
    noError(root);
    const raised = root.descendantsOfType("raise_statement")[0]!.namedChild(0)!;
    expect(raised.type).toBe("identifier");
    expect(raised.text).toBe("PermissionDenied");
  });

  it("return redirect(url_for('auth.login')): return_statement > call > call", async () => {
    const root = await rootOf(`def f():\n    return redirect(url_for('auth.login'))\n`);
    noError(root);
    const val = root.descendantsOfType("return_statement")[0]!.namedChild(0)!;
    expect(val.type).toBe("call");
    expect(val.childForFieldName("function")!.text).toBe("redirect");
    const inner = val.childForFieldName("arguments")!.namedChild(0)!;
    expect(inner.type).toBe("call");
    expect(inner.childForFieldName("function")!.text).toBe("url_for");
  });

  it("return jsonify({}), 401: return_statement > expression_list ending in integer", async () => {
    const root = await rootOf(`def f():\n    return jsonify({}), 401\n`);
    noError(root);
    const val = root.descendantsOfType("return_statement")[0]!.namedChild(0)!;
    expect(val.type).toBe("expression_list");
    const kids = val.namedChildren.filter((n): n is SyntaxNode => n !== null);
    const last = kids[kids.length - 1]!;
    expect(last.type).toBe("integer");
    expect(last.text).toBe("401");
  });

  it("'user_id' not in session: comparison_operator with an unnamed 'not in' child", async () => {
    const root = await rootOf(`def f():\n    if 'user_id' not in session:\n        pass\n`);
    noError(root);
    const cmp = root.descendantsOfType("comparison_operator")[0]!;
    const ops = cmp.children
      .filter((c): c is SyntaxNode => c !== null && !c.isNamed)
      .map((c) => c.type);
    expect(ops).toContain("not in");
  });

  it("session.get('user'): call on an attribute callee", async () => {
    const root = await rootOf(`def f():\n    session.get('user')\n`);
    noError(root);
    const fn = root.descendantsOfType("call")[0]!.childForFieldName("function")!;
    expect(fn.type).toBe("attribute");
    expect(fn.childForFieldName("attribute")!.text).toBe("get");
    expect(fn.childForFieldName("object")!.text).toBe("session");
  });

  it("pass body is a block > pass_statement", async () => {
    const root = await rootOf(`def f():\n    pass\n`);
    noError(root);
    const body = root.descendantsOfType("function_definition")[0]!.childForFieldName("body")!;
    expect(body.type).toBe("block");
    expect(body.namedChild(0)!.type).toBe("pass_statement");
  });

  it("async def is a function_definition with intact name/body fields", async () => {
    const root = await rootOf(`async def f():\n    abort(401)\n`);
    noError(root);
    const def = root.descendantsOfType("function_definition")[0]!;
    expect(def.type).toBe("function_definition");
    expect(def.childForFieldName("name")!.text).toBe("f");
    expect(def.childForFieldName("body")!.type).toBe("block");
  });

  it("a @lru_cache-decorated def still surfaces in descendantsOfType('function_definition')", async () => {
    const root = await rootOf(`@functools.lru_cache\ndef helper():\n    abort(401)\n`);
    noError(root);
    const defs = root
      .descendantsOfType("function_definition")
      .filter((d): d is SyntaxNode => d !== null);
    expect(defs).toHaveLength(1);
    expect(defs[0].childForFieldName("name")!.text).toBe("helper");
  });
});

describe("bodyAuthSignature: reject signatures", () => {
  const REJECTS: Array<[string, string]> = [
    ["abort(401) alone", `def hook():\n    abort(401)\n`],
    ["flask.abort(401) attribute callee", `def hook():\n    flask.abort(401)\n`],
    ["return abort(401)", `def hook():\n    return abort(401)\n`],
    [
      "abort(401) nested in try/if/for",
      `def hook():\n    for x in items:\n        try:\n            if bad:\n                abort(401)\n        except Exception:\n            pass\n`,
    ],
    [
      "raise HTTPException(status_code=401, detail='no')",
      `def hook():\n    raise HTTPException(status_code=401, detail="no")\n`,
    ],
    ["raise HTTPException(401) positional", `def hook():\n    raise HTTPException(401)\n`],
    [
      "raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)",
      `def hook():\n    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)\n`,
    ],
    [
      "corroborated 403: session read + abort(403)",
      `def hook():\n    user = session.get("user_id")\n    if user is None:\n        abort(403)\n`,
    ],
    ["raise AuthenticationError('nope')", `def hook():\n    raise AuthenticationError("nope")\n`],
    ["raise Unauthorized()", `def hook():\n    raise Unauthorized()\n`],
    [
      "raise werkzeug.exceptions.Unauthorized()",
      `def hook():\n    raise werkzeug.exceptions.Unauthorized()\n`,
    ],
    ["bare raise PermissionDenied", `def hook():\n    raise PermissionDenied\n`],
    [
      "return redirect(url_for('auth.login'))",
      `def hook():\n    return redirect(url_for("auth.login"))\n`,
    ],
    ["return redirect('/login')", `def hook():\n    return redirect("/login")\n`],
    ["return RedirectResponse('/login')", `def hook():\n    return RedirectResponse("/login")\n`],
    [
      "session guard then redirect to login",
      `def hook():\n    if not session.get("user_id"):\n        return redirect(url_for("auth.login"))\n`,
    ],
    [
      "pyAuthFile wrapper: header read + jsonify tuple 401",
      `def hook():\n    token = request.headers.get("Authorization")\n    if not token:\n        return jsonify({"error": "unauthorized"}), 401\n`,
    ],
    [
      "current_user guard then abort(401)",
      `def hook():\n    if not current_user.is_authenticated:\n        abort(401)\n`,
    ],
    ["verify_jwt_in_request() alone", `def hook():\n    verify_jwt_in_request()\n`],
    [
      "one-hop helper: _reject_anon() aborts 401",
      `def _reject_anon():\n    if not g.user:\n        abort(401)\n\n\ndef hook():\n    _reject_anon()\n`,
    ],
    [
      "one-hop helper decorated with @functools.lru_cache",
      `@functools.lru_cache\ndef _reject_anon():\n    if not g.user:\n        abort(401)\n\n\ndef hook():\n    _reject_anon()\n`,
    ],
    [
      "one-hop async helper",
      `async def _reject_anon():\n    if not g.user:\n        abort(401)\n\n\ndef hook():\n    _reject_anon()\n`,
    ],
  ];
  it.each(REJECTS)('"%s" -> reject', async (_name, src) => {
    expect(await sig(src)).toBe("reject");
  });
});

describe("bodyAuthSignature: none (visible body, no rejection)", () => {
  const NONES: Array<[string, string]> = [
    [
      "verify_user_email body: email + return None",
      `def hook():\n    send_confirmation_email(g.user.email)\n    return None\n`,
    ],
    ["scrub_pii(record)", `def hook():\n    scrub_pii(record)\n`],
    ["anonymize(record)", `def hook():\n    anonymize(record)\n`],
    ["logger.info(...)", `def hook():\n    logger.info("hit %s", request.path)\n`],
    ["g.request_id = uuid4().hex", `def hook():\n    g.request_id = uuid4().hex\n`],
    [
      "header setter (subscript assignment)",
      `def hook():\n    response.headers["X-Frame-Options"] = "DENY"\n`,
    ],
    ["pass", `def hook():\n    pass\n`],
    ["docstring only", `def hook():\n    """just docs"""\n`],
    ["abort(400)", `def hook():\n    abort(400)\n`],
    ["abort(404)", `def hook():\n    abort(404)\n`],
    ["abort(500)", `def hook():\n    abort(500)\n`],
    ["raise HTTPException(status_code=404)", `def hook():\n    raise HTTPException(status_code=404)\n`],
    ["lone uncorroborated abort(403)", `def hook():\n    abort(403)\n`],
    [
      "lone uncorroborated raise HTTPException(status_code=403)",
      `def hook():\n    raise HTTPException(status_code=403)\n`,
    ],
    [
      "lone uncorroborated raise HTTPException(status_code=HTTP_403_FORBIDDEN)",
      `def hook():\n    raise HTTPException(status_code=HTTP_403_FORBIDDEN)\n`,
    ],
    ["raise ValueError('bad')", `def hook():\n    raise ValueError("bad")\n`],
    ["raise KeyError", `def hook():\n    raise KeyError\n`],
    ["raise NotFound", `def hook():\n    raise NotFound\n`],
    [
      "return redirect(url_for('maintenance.notice'))",
      `def hook():\n    return redirect(url_for("maintenance.notice"))\n`,
    ],
    ["return redirect('/checkout')", `def hook():\n    return redirect("/checkout")\n`],
    ["session.get('locale') (not a credential key)", `def hook():\n    session.get("locale")\n`],
  ];
  it.each(NONES)('"%s" -> none', async (_name, src) => {
    expect(await sig(src)).toBe("none");
  });
});

describe("bodyAuthSignature: opaque (auth-flavored but unverifiable)", () => {
  const OPAQUES: Array<[string, string]> = [
    ["check_session() undefined helper", `def hook():\n    check_session()\n`],
    ["confirm(user) undefined helper", `def hook():\n    confirm(user)\n`],
    ["_do_auth() undefined helper", `def hook():\n    _do_auth()\n`],
    ["abort(code_var) unreadable status", `def hook():\n    abort(code_var)\n`],
    [
      "raise HTTPException(status_code=CODE) unreadable status",
      `def hook():\n    raise HTTPException(status_code=CODE)\n`,
    ],
    [
      "verify_jwt_in_request(optional=True) non-empty args",
      `def hook():\n    verify_jwt_in_request(optional=True)\n`,
    ],
    ["redirect(page_var) unreadable target", `def hook():\n    return redirect(page_var)\n`],
    [
      "credential read + opaque validate_or_die",
      `def hook():\n    token = request.headers.get("Authorization")\n    validate_or_die(token)\n`,
    ],
    [
      "duplicate same-file def: check_session unresolvable + hint",
      `def check_session():\n    pass\n\n\ndef check_session():\n    pass\n\n\ndef hook():\n    check_session()\n`,
    ],
    ["get_jwt_identity() analytics: jwt hint, never reject", `def hook():\n    get_jwt_identity()\n`],
  ];
  it.each(OPAQUES)('"%s" -> opaque', async (_name, src) => {
    expect(await sig(src)).toBe("opaque");
  });

  it("cycle a()->b()->a() terminates and returns none (no reject, no hint)", async () => {
    const src = `def a():\n    b()\n\n\ndef b():\n    a()\n`;
    expect(await sig(src, "a")).toBe("none");
  });
});

describe("classifyHookAuth: precedence", () => {
  const cls = async (name: string, src: string, simple: boolean, fnName = "hook") => {
    const { body, defs } = await hookBody(src, fnName);
    return classifyHookAuth(name, body, defs, simple);
  };

  it("veto beats a body-positive: optional_authenticate + abort(401) body -> not-auth", async () => {
    const body =
      `def hook():\n    token = request.headers.get("Authorization")\n    if token is None:\n        abort(401)\n`;
    expect(await cls("optional_authenticate", body, true)).toBe("not-auth");
  });

  it("body beats name (bless): boring gate() with session+abort(401) -> auth", async () => {
    const body = `def hook():\n    if not session.get("user_id"):\n        abort(401)\n`;
    expect(await cls("gate", body, true)).toBe("auth");
  });

  it("body beats name (deny): verify_user_email emailing body -> not-auth", async () => {
    const body = `def hook():\n    send_confirmation_email(g.user.email)\n    return None\n`;
    expect(await cls("verify_user_email", body, true)).toBe("not-auth");
  });

  it("visible pass stub never rescued: require_login/pass -> not-auth", async () => {
    expect(await cls("require_login", `def hook():\n    pass\n`, true)).toBe("not-auth");
  });

  it("tier-1 CORE does not rescue a visible stub: check_auth/pass -> not-auth", async () => {
    expect(await cls("check_auth", `def hook():\n    pass\n`, true)).toBe("not-auth");
  });

  it("wrong reject code: require_login/abort(404) -> not-auth", async () => {
    expect(await cls("require_login", `def hook():\n    abort(404)\n`, true)).toBe("not-auth");
  });

  it("opaque + CORE carve-out: authenticate_request delegating to _do_auth() -> auth", async () => {
    expect(await cls("authenticate_request", `def hook():\n    _do_auth()\n`, true)).toBe("auth");
  });

  it("opaque + tier-2 name: require_login -> check_session() -> unsure", async () => {
    expect(await cls("require_login", `def hook():\n    check_session()\n`, true)).toBe("unsure");
  });

  it("opaque + attributive name: verify_user_email -> confirm(user) -> unsure", async () => {
    expect(await cls("verify_user_email", `def hook():\n    confirm(user)\n`, true)).toBe("unsure");
  });

  it("opaque under a boring name: setup -> check_session() -> unsure (flavored delegation is evidence)", async () => {
    expect(await cls("setup", `def hook():\n    check_session()\n`, true)).toBe("unsure");
  });

  it("body null + CORE simple: authenticate -> auth", () => {
    expect(classifyHookAuth("authenticate", null, new Map(), true)).toBe("auth");
  });

  it("body null + tier-2 simple: verify_session -> unsure", () => {
    expect(classifyHookAuth("verify_session", null, new Map(), true)).toBe("unsure");
  });

  it("body null + attributive simple: verify_user_email -> unsure", () => {
    expect(classifyHookAuth("verify_user_email", null, new Map(), true)).toBe("unsure");
  });

  it("body null + auth segment on a non-simple target: AuthGate.check -> unsure (never blesses)", () => {
    expect(classifyHookAuth("AuthGate.check", null, new Map(), false)).toBe("unsure");
  });

  it("body null + zero flavor: add_request_id -> not-auth (no hedge)", () => {
    expect(classifyHookAuth("add_request_id", null, new Map(), true)).toBe("not-auth");
  });

  it("body null + optional veto: optional_auth_hook -> not-auth", () => {
    expect(classifyHookAuth("optional_auth_hook", null, new Map(), true)).toBe("not-auth");
  });
});

describe("SECURITY_AST_PY export bag: body-signature lexicons", () => {
  it("includes each new body-signature lexicon name", () => {
    const keys = Object.keys(SECURITY_AST_PY);
    for (const name of [
      "REJECT_STATUSES",
      "REJECT_STATUS_BLESSES_ALONE",
      "AUTH_EXCEPTION_ALONE",
      "AUTH_EXCEPTION_TOPIC",
      "AUTH_EXCEPTION_KIND",
      "LOGIN_REDIRECT_SEGMENTS",
      "KNOWN_AUTH_PRIMITIVES",
      "OPAQUE_AUTH_HINT_SEGMENTS",
      "CREDENTIAL_KEY_SEGMENTS",
    ]) {
      expect(keys).toContain(name);
    }
  });
});

// ─── ADDENDUM Task 2: safe-direction tightening 1 — prune nested def subtrees ──
//
// A reject signature inside a nested `function_definition` in the hook body is
// NOT executed inline, so it must not count as the hook rejecting. The body scan
// prunes nested def/lambda subtrees (the hook's own try/if/for branches still
// count). Moves strictly toward NEVER-FALSE-BLESS.
describe("tightening 1: nested def subtrees are pruned from the body scan", () => {
  it("bodyAuthSignature: an abort(401) inside a nested def + a logging body -> none (not reject)", async () => {
    const src = `def hook():\n    def _never():\n        abort(401)\n    logger.info("hi")\n`;
    expect(await sig(src)).toBe("none");
  });

  it("classifyHookAuth: add_request_id whose only 401 sits in a nested def -> not-auth", async () => {
    const { body, defs } = await hookBody(
      `def hook():\n    def _never():\n        abort(401)\n    logger.info("hi")\n`,
    );
    expect(classifyHookAuth("add_request_id", body, defs, true)).toBe("not-auth");
  });

  it("extractor: an add_request_id hook whose 401 is only in a nested def does NOT bless its routes", async () => {
    const f = await py("nesteddef.py",
      `@app.before_request\n` +
      `def add_request_id():\n` +
      `    def _never():\n` +
      `        abort(401)\n` +
      `    logger.info("hi")\n\n` +
      `@app.route("/x", methods=["POST"])\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
    expect(routes[0].authUnsureHook).toBeUndefined();
    expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth).toBe(false);
  });

  it("the hook's OWN try/if/for branches still count (a real inline 401 blesses)", async () => {
    const src = `def hook():\n    for x in items:\n        if bad:\n            abort(401)\n`;
    expect(await sig(src)).toBe("reject");
  });
});

// ─── ADDENDUM Task 2: safe-direction tightening 2 — guard-condition-then-403 ───
//
// A lone 403 anywhere + a credential read anywhere used to bless (a body-wide
// co-occurrence). That false-blessed a CSRF gate that merely reads the session.
// Now a 403 blesses ONLY when it sits in a reject driven by an `if` whose
// CONDITION references a credential/session/auth value. 401 blessing alone is
// unchanged. Moves strictly toward NEVER-FALSE-BLESS.
describe("tightening 2: a 403 blesses only inside a credential-guarded reject", () => {
  it("bodyAuthSignature: session read + a CSRF-guarded abort(403) -> NOT reject (opaque)", async () => {
    const src = `def hook():\n    user = session.get("user")\n    if not csrf_valid(request):\n        abort(403)\n`;
    const s = await sig(src);
    expect(s).not.toBe("reject");
    expect(s).toBe("opaque");
  });

  it("bodyAuthSignature: a credential-guarded abort(403) stays reject", async () => {
    const src = `def hook():\n    if "user_id" not in session:\n        abort(403)\n`;
    expect(await sig(src)).toBe("reject");
  });

  it("bodyAuthSignature: a bare truthiness guard on a user_agent-style attribute + abort(403) does NOT bless (no new false-bless from a substring 'user')", async () => {
    // The guard reads no credential SHAPE (no .get / is-None / in-string /
    // session-subscript), only a bare attribute whose name happens to contain the
    // 'user' segment. It must resolve away from reject, exactly as before the
    // tightening — the guarded-403 set is a strict subset of the old set.
    const src = `def hook():\n    if request.user_agent:\n        abort(403)\n`;
    expect(await sig(src)).not.toBe("reject");
    expect(await sig(src)).toBe("none");
  });

  it("extractor: a CSRF gate that reads the session but 403s on csrf failure does NOT bless", async () => {
    const f = await py("csrfgate.py",
      `@app.before_request\n` +
      `def csrf_gate():\n` +
      `    user = session.get("user")\n` +
      `    if not csrf_valid(request):\n` +
      `        abort(403)\n\n` +
      `@app.route("/x", methods=["POST"])\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes[0].hasAuth).toBe(false);
  });

  it("extractor: a credential-guarded 403 hook under a boring name blesses its routes", async () => {
    const f = await py("credgate.py",
      `@app.before_request\n` +
      `def gate():\n` +
      `    if "user_id" not in session:\n` +
      `        abort(403)\n\n` +
      `@app.route("/x", methods=["POST"])\n` +
      `def x():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=true"]);
  });
});

// ─── ADDENDUM Task 2: hook body signatures wired into the extractor ───────────
//
// The decorator/call-form hook path now classifies by BODY behavior. A verified
// reject body blesses the receiver's routes even under a boring name; a fully
// visible non-enforcing body never blesses, whatever the name (the
// verify_user_email fix, exercised end-to-end above).
describe("hook body signatures (extractor level)", () => {
  const hookRoute = (hook: string, body: string[]) =>
    [`@app.before_request`, `def ${hook}():`, ...body, ``,
     `@app.route("/x", methods=["POST"])`, `def x():`, `    return {}`, ``].join("\n");
  const firstRoute = async (src: string) => {
    const f = await py("hookext.py", src);
    return { routes: extractPythonRoutesAst(f.tree!, f.relativePath), tree: f.tree! };
  };

  const BODY_BLESS: Array<[string, string[]]> = [
    ["abort(401), boring name", ["    if not g.user:", "        abort(401)"]],
    ["flask.abort(401) attribute callee", ["    if not g.user:", "        flask.abort(401)"]],
    ["credential-guarded abort(403)", ['    if "user_id" not in session:', "        abort(403)"]],
    ["raise HTTPException(status_code=401)", ["    raise HTTPException(status_code=401)"]],
    ["redirect to login", ['    if not session.get("user_id"):', '        return redirect(url_for("auth.login"))']],
    ["header read then 401 tuple", ['    token = request.headers.get("Authorization")', "    if not token:", '        return jsonify({"error": "no"}), 401']],
    ["current_user guard then abort(401)", ["    if not current_user.is_authenticated:", "        abort(401)"]],
    ["verify_jwt_in_request()", ["    verify_jwt_in_request()"]],
  ];
  it.each(BODY_BLESS)('body reject "%s" blesses /x under the boring name gate', async (_n, body) => {
    const { routes, tree } = await firstRoute(hookRoute("gate", body));
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=true"]);
    expect(routes[0].authUnsureHook).toBeUndefined();
    expect(extractPythonFileMiddlewareAst(tree).hasAuth).toBe(true);
  });

  it("one-hop same-file helper that aborts 401 blesses under a boring hook name", async () => {
    const { routes } = await firstRoute(
      `def _reject_anon():\n    if not g.user:\n        abort(401)\n\n\n` +
      `@app.before_request\ndef gate():\n    _reject_anon()\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=true"]);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  const BODY_NONE_NEG: Array<[string, string, string[]]> = [
    ["verify_user_email emailing", "verify_user_email", ["    send_confirmation_email(g.user.email)", "    return None"]],
    ["protect_user_data scrubbing", "protect_user_data", ["    scrub_pii(record)", "    return None"]],
    ["log-only require_login", "require_login", ['    logger.info("hit %s", request.path)']],
    ["header-set-only verify_token", "verify_token", ['    response.headers["X-Frame-Options"] = "DENY"']],
    ["pass under require_login", "require_login", ["    pass"]],
    ["docstring under check_auth", "check_auth", ['    """docs"""']],
    ["abort(400)", "gate", ["    abort(400)"]],
    ["abort(404)", "gate", ["    abort(404)"]],
    ["raise ValueError", "gate", ['    raise ValueError("bad")']],
    ["non-login redirect", "gate", ['    return redirect("/checkout")']],
    ["lone abort(403) under csrf_protect", "csrf_protect", ["    abort(403)"]],
    ["lone abort(403) under maintenance_gate", "maintenance_gate", ["    abort(403)"]],
  ];
  it.each(BODY_NONE_NEG)('visible non-enforcing body "%s" -> flat not-auth (key absent)', async (_n, hook, body) => {
    const { routes, tree } = await firstRoute(hookRoute(hook, body));
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
    expect(routes[0].authUnsureHook).toBeUndefined();
    expect(extractPythonFileMiddlewareAst(tree).hasAuth).toBe(false);
  });

  it("require_admin whose only reject is a LONE abort(403) -> not-auth, key absent (forced by the visible-none rule that also fixes verify_user_email)", async () => {
    // NOTE: the brief's parenthetical expected `unsure` here, but a lone abort(403)
    // resolves the body to `none` (Task 1's frozen catalog), and a visible `none`
    // body is flat not-auth regardless of name — the exact rule the
    // verify_user_email fix depends on. Both outcomes are hasAuth:false; not-auth
    // is the more conservative, design-consistent one.
    const { routes } = await firstRoute(hookRoute("require_admin", ["    abort(403)"]));
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("a boring `before` hook calling only verify_jwt_in_request(optional=True) -> unsure, never a bless", async () => {
    const { routes } = await firstRoute(hookRoute("before", ["    verify_jwt_in_request(optional=True)"]));
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBe("before");
  });

  it("lanes untouched: a validate_payload/pass hook sets validation, never auth (route level)", async () => {
    const { routes } = await firstRoute(hookRoute("validate_payload", ["    pass"]));
    expect(routes[0].hasValidation).toBe(true);
    expect(routes[0].hasAuth).toBe(false);
  });

  it("receiver scoping preserved: a body-blessed admin_bp hook blesses only admin_bp routes", async () => {
    const f = await py("scoped.py",
      `@admin_bp.before_request\ndef gate():\n    abort(401)\n\n` +
      `@admin_bp.route("/users", methods=["POST"])\ndef create_user():\n    return {}\n\n` +
      `@public_bp.route("/webhook", methods=["POST"])\ndef webhook():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/users auth=true",
      "/webhook auth=false",
    ]);
  });
});

// ─── ADDENDUM Task 2: unsure hooks surface the exact hook name ────────────────
//
// An auth-flavored but statically unverifiable hook resolves `unsure`: hasAuth
// stays false (never blesses) and route.authUnsureHook carries the REGISTERED
// hook's name so a renderer can hedge the copy. Covers decorator + call-form
// registration.
describe("unsure hooks (extractor level)", () => {
  const routesOf = async (src: string) => {
    const f = await py("unsure.py", src);
    return { routes: extractPythonRoutesAst(f.tree!, f.relativePath), tree: f.tree! };
  };
  const ROUTE = `\n@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`;

  it("opaque auth-flavored helper: @app.before_request require_login -> check_session() -> authUnsureHook 'require_login'", async () => {
    const { routes, tree } = await routesOf(
      `@app.before_request\ndef require_login():\n    check_session()\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBe("require_login");
    expect(extractPythonFileMiddlewareAst(tree).hasAuth).toBe(false);
  });

  it("call-form imported hook: app.before_request(verify_session) -> authUnsureHook 'verify_session'", async () => {
    const { routes } = await routesOf(
      `from .auth import verify_session\napp.before_request(verify_session)\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBe("verify_session");
  });

  it("call-form CORE name blesses: app.before_request(authenticate) -> auth=true, key absent", async () => {
    const { routes } = await routesOf(`app.before_request(authenticate)\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(true);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("call-form lambda: app.before_request(lambda: abort(401)) -> auth=true", async () => {
    const { routes } = await routesOf(`app.before_request(lambda: abort(401))\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(true);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("call-form attribute target: app.before_request(AuthGate.check) -> unsure, hook name 'AuthGate.check'", async () => {
    const { routes } = await routesOf(`app.before_request(AuthGate.check)\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBe("AuthGate.check");
  });

  it("attributive-collision unresolvable: verify_user_email -> confirm(user) -> unsure, never blessed on name", async () => {
    const { routes } = await routesOf(
      `@app.before_request\ndef verify_user_email():\n    confirm(user)\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBe("verify_user_email");
  });

  it("@bp.before_app_request unsure hook marks authUnsureHook app-wide", async () => {
    const { routes } = await routesOf(
      `@bp.before_app_request\ndef require_login():\n    check_session()\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBe("require_login");
  });

  it("per-route auth clears unsure: unsure hook + @login_required below the route -> auth=true, key absent", async () => {
    const { routes } = await routesOf(
      `@app.before_request\ndef require_login():\n    check_session()\n\n` +
      `@app.route("/x", methods=["POST"])\n@login_required\ndef x():\n    return {}\n`);
    expect(routes[0].hasAuth).toBe(true);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("global real auth clears receiver unsure: app-scoped abort(401) hook + an unsure receiver hook -> auth=true, key absent", async () => {
    const { routes } = await routesOf(
      `@app.before_request\ndef gate():\n    abort(401)\n\n` +
      `@orders_bp.before_request\ndef require_login():\n    check_session()\n\n` +
      `@orders_bp.route("/x", methods=["POST"])\ndef x():\n    return {}\n`);
    expect(routes[0].hasAuth).toBe(true);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("deterministic attribution: two unsure hooks on one receiver -> the FIRST in document order", async () => {
    const { routes } = await routesOf(
      `@app.before_request\ndef require_login():\n    check_session()\n\n` +
      `@app.before_request\ndef verify_user_email():\n    confirm(user)\n` + ROUTE);
    expect(routes[0].authUnsureHook).toBe("require_login");
  });

  it("errored hook dd is invisible: no throw, no bless, no unsure on any emitted route", async () => {
    const f = await py("errdd.py",
      `@app.before_request\ndef gate():\n    x = = 1\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`);
    expect(() => extractPythonRoutesAst(f.tree!, f.relativePath)).not.toThrow();
    for (const r of extractPythonRoutesAst(f.tree!, f.relativePath)) {
      expect(r.hasAuth).toBe(false);
      expect(r.authUnsureHook).toBeUndefined();
    }
  });

  it("cycle-safe hook a()->b()->a() -> not blessed, not unsure (boring name resolves none)", async () => {
    const { routes } = await routesOf(
      `def b():\n    a()\n\n\n@app.before_request\ndef a():\n    b()\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });
});

// ─── ADDENDUM Task 2: Depends additive-only same-file body bless ──────────────
//
// A boring-named FastAPI dependency whose VISIBLE same-file body raises a
// verified 401 IS auth enforcement. Order is veto first, name-segment hit
// second, same-file body reject third. Imported-target verdicts are unchanged
// (no same-file def to resolve).
describe("Depends additive-only body bless", () => {
  it("Depends(load_actor) whose same-file body raises HTTPException(401) blesses", async () => {
    const f = await py("depbody.py",
      `@router.post("/x")\ndef h(actor=Depends(load_actor)):\n    return {}\n\n\n` +
      `def load_actor(request):\n    token = request.headers.get("Authorization")\n` +
      `    if not token:\n        raise HTTPException(status_code=401)\n    return token\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=true"]);
  });

  it("Depends(get_current_user_optional) whose body raises 401 -> auth=false (veto beats body)", async () => {
    const f = await py("depveto.py",
      `@router.post("/x")\ndef h(user=Depends(get_current_user_optional)):\n    return {}\n\n\n` +
      `def get_current_user_optional(request):\n    token = request.headers.get("Authorization")\n` +
      `    if not token:\n        raise HTTPException(status_code=401)\n    return token\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
  });

  it("imported Depends verdicts unchanged: oauth2_scheme blesses, get_author_stats does not", async () => {
    const f = await py("depimported.py",
      `@router.post("/x1")\ndef h1(x=Depends(oauth2_scheme)):\n    return {}\n\n` +
      `@router.post("/x2")\ndef h2(x=Depends(get_author_stats)):\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual([
      "/x1 auth=true",
      "/x2 auth=false",
    ]);
  });
});
