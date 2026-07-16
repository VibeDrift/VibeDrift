import { describe, it, expect } from "vitest";
import {
  extractPythonRoutesAst,
  extractPythonFileMiddlewareAst,
  bodyAuthSignature,
  classifyHookAuth,
  collectFunctionDefs,
  SECURITY_AST_PY,
} from "../../../src/drift/security-ast-python.js";
import { extractJsRoutesAst } from "../../../src/drift/security-ast.js";
import { buildXFileIndex, resolvePyHookBody } from "../../../src/drift/security-xfile-index.js";
import { securityConsistency } from "../../../src/drift/security-consistency.js";
import { SECURITY_SUBCATEGORIES } from "../../../src/drift/types.js";
import type { SyntaxNode } from "../../../src/core/types.js";
import { fileWithTree } from "../../helpers/drift-tree.js";

const py = (path: string, src: string) => fileWithTree(path, src, "python");

/** Build a virtual multi-file python repo (DriftFiles with parsed trees) from
 *  [relativePath, source] pairs. Parsed SEQUENTIALLY — web-tree-sitter is not
 *  safe to drive concurrently. */
async function repo(files: [string, string][]) {
  const out = [];
  for (const [path, src] of files) out.push(await py(path, src));
  return out;
}

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

  it("resolves methods=ALLOWED (a variable with NO same-file assignment) to ALL: the unresolved case; see the resolved-var suite below for the assigned case", async () => {
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

// ─── Upgrade 2: methods= same-file variable resolution ──────────────────────
//
// A `methods=VAR` kwarg now resolves through VAR's value WHEN VAR is written
// EXACTLY ONCE at module top level to a literal list/tuple/set of string
// verbs (reusing the same methodFromLiteral reduction the inline literal path
// uses). Every other shape — imported, computed, an identifier alias chain,
// reassigned more than once, or written through any of the poisoned forms
// below (augmented assignment, a mutating method call, `global`, walrus, a
// for-loop target, a subscript/slice-target assignment, a `with ... as`
// binding, or a conditional/def-local assignment) — stays unresolvable and
// resolves "ALL", never a silent GET: the invariant is never dropping a
// mutating route out of the vote because its methods= variable was
// unreadable.
describe("methods= same-file variable resolution", () => {
  it("resolves methods=ALLOWED to POST when ALLOWED = [\"GET\", \"POST\"] is the sole same-file assignment (mutating verb wins, same reduction as the inline literal path)", async () => {
    const f = await py("resolved-list.py",
      `ALLOWED = ["GET", "POST"]\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves methods=VERBS to PUT when VERBS = (\"PUT\",) is a same-file tuple literal", async () => {
    const f = await py("resolved-tuple.py",
      `VERBS = ("PUT",)\n\n@app.route("/x", methods=VERBS)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("PUT");
  });

  it("resolves methods=VERBS to DELETE when VERBS = {\"delete\"} is a same-file set literal (uppercased)", async () => {
    const f = await py("resolved-set.py",
      `VERBS = {"delete"}\n\n@app.route("/x", methods=VERBS)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("DELETE");
  });

  it("resolves methods=VERBS to GET when VERBS = [\"GET\"]: a fully visible literal legitimately exits the mutating vote; the route IS emitted", async () => {
    const f = await py("resolved-get.py",
      `VERBS = ["GET"]\n\n@app.route("/x", methods=VERBS)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
  });

  it("resolves methods=VERBS to GET when VERBS = []: fully visible and empty, mirrors the inline empty-literal pin (visibility, not ambiguity)", async () => {
    const f = await py("resolved-empty.py",
      `VERBS = []\n\n@app.route("/x", methods=VERBS)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
  });

  it("resolves methods=VERBS to GET when VERBS = [\"MKCOL\"]: fully visible with no recognized verb, mirrors the inline MKCOL pin", async () => {
    const f = await py("resolved-mkcol.py",
      `VERBS = ["MKCOL"]\n\n@app.route("/x", methods=VERBS)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
  });

  it("resolves methods=ALLOWED to POST when ALLOWED = [*BASE, \"POST\"]: the visible literal wins, the same shared helper as the inline kwarg", async () => {
    const f = await py("resolved-splat-verb.py",
      `ALLOWED = [*BASE, "POST"]\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves methods=ALLOWED to ALL when ALLOWED = [*BASE]: no visible literal verb even though the assignment itself is unambiguous", async () => {
    const f = await py("resolved-splat-only.py",
      `ALLOWED = [*BASE]\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("resolves methods=ALLOWED to POST when ALLOWED: list[str] = [\"POST\"] is an annotated assignment (still an `assignment` node)", async () => {
    const f = await py("resolved-annotated.py",
      `ALLOWED: list[str] = ["POST"]\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("stays ALL for ALL_VERBS = BASE + EXTRA: a computed (binary_operator) same-file value, not a literal", async () => {
    const f = await py("computed.py",
      `ALL_VERBS = BASE + EXTRA\n\n@app.route("/x", methods=ALL_VERBS)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for an imported `from config import ALLOWED`: no same-file assignment to chase", async () => {
    const f = await py("imported.py",
      `from config import ALLOWED\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for ALLOWED = get_methods(): a computed call, not a literal", async () => {
    const f = await py("computed-call.py",
      `ALLOWED = get_methods()\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for an alias chain (A = [\"POST\"]; B = A; methods=B): an identifier RHS is refused, never chased", async () => {
    const f = await py("alias-chain.py",
      `A = ["POST"]\nB = A\n\n@app.route("/x", methods=B)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for a twice-reassigned variable: two same-file literal assignments make the value ambiguous", async () => {
    const f = await py("twice-reassigned.py",
      `ALLOWED = ["GET"]\nALLOWED = ["POST"]\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("CONDITIONAL-REASSIGN TRAP: ALLOWED = [\"GET\"] then `if F: ALLOWED = [\"GET\", \"POST\"]` stays ALL, never GET (a nested module-scope reassign is a SECOND write that poisons the name, not an invisible one)", async () => {
    const f = await py("conditional-reassign.py",
      `ALLOWED = ["GET"]\nif FEATURE_WRITES:\n    ALLOWED = ["GET", "POST"]\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("TRY-REASSIGN TRAP: ALLOWED = [\"GET\"] then `try: ALLOWED = load()` stays ALL, never GET (a try-block rebind is a second write)", async () => {
    const f = await py("try-reassign.py",
      `ALLOWED = ["GET"]\ntry:\n    ALLOWED = load()\nexcept Exception:\n    pass\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("AUGMENTED-ASSIGNMENT TRAP: ALLOWED = [\"GET\"] then ALLOWED += [\"POST\"] stays ALL, never GET (a naive single-assignment scan would resolve GET and silently drop the POST route from the mutating vote)", async () => {
    const f = await py("augmented-trap.py",
      `ALLOWED = ["GET"]\nALLOWED += ["POST"]\n\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL when `global ALLOWED` is declared and written inside a def", async () => {
    const f = await py("global-write.py",
      `ALLOWED = ["GET"]\n\ndef configure():\n    global ALLOWED\n    ALLOWED = ["POST"]\n\n` +
      `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for a walrus write to the variable", async () => {
    const f = await py("walrus-write.py",
      `ALLOWED = ["GET"]\nif (ALLOWED := recompute()):\n    pass\n\n` +
      `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for a for-loop target write to the variable", async () => {
    const f = await py("for-target-write.py",
      `ALLOWED = ["GET"]\nfor ALLOWED in candidate_lists():\n    pass\n\n` +
      `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("MUTATION TRAP: ALLOWED.append(\"DELETE\") stays ALL, never GET", async () => {
    const f = await py("append-trap.py",
      `ALLOWED = ["GET"]\nALLOWED.append("DELETE")\n\n` +
      `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for a tuple-unpack write `x, ALLOWED = pair`", async () => {
    const f = await py("tuple-unpack-write.py",
      `ALLOWED = ["GET"]\nx, ALLOWED = pair\n\n` +
      `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("SLICE-REPLACEMENT TRAP: ALLOWED = [\"GET\"] then ALLOWED[:] = load_methods() stays ALL, never GET (a subscript-left assignment a naive identifier-left census would miss)", async () => {
    const f = await py("slice-replacement-trap.py",
      `ALLOWED = ["GET"]\nALLOWED[:] = load_methods()\n\n` +
      `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("ELEMENT-ASSIGNMENT TRAP: ALLOWED = [\"GET\"] then ALLOWED[0] = \"POST\" stays ALL, never GET (another subscript-left assignment)", async () => {
    const f = await py("element-trap.py",
      `ALLOWED = ["GET"]\nALLOWED[0] = "POST"\n\n` +
      `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("WITH-AS TRAP: `with open(\"m\") as ALLOWED:` rebinds the name, stays ALL", async () => {
    const f = await py("with-as-trap.py",
      `ALLOWED = ["GET"]\nwith open("m") as ALLOWED:\n    pass\n\n` +
      `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for a lone assignment inside an `if:` block: conditional, not an unconditional same-file literal", async () => {
    const f = await py("conditional-assignment.py",
      `if COND:\n    VERBS = ["GET"]\n\n@app.route("/x", methods=VERBS)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("stays ALL for a def-local sole assignment: not a module top-level write", async () => {
    const f = await py("def-local-assignment.py",
      `def configure():\n    VERBS = ["GET"]\n\n@app.route("/x", methods=VERBS)\ndef h():\n    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });

  it("resolves a multiline decorator with methods=ALLOWED identically to the inline-literal multiline pin (POST)", async () => {
    const f = await py("multiline-var.py",
      `ALLOWED = ["POST", "GET"]\n\n` +
      `@app.route(\n` +
      `    "/x",\n` +
      `    methods=ALLOWED,\n` +
      `)\n` +
      `def h():\n` +
      `    return {}\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("POST");
  });

  it("resolves a trailing-kwarg flood with methods=ALLOWED identically to the inline-literal flood pin (POST)", async () => {
    const f = await py("flood-var.py",
      `ALLOWED = ["POST"]\n\n` +
      `@app.route("/x", methods=ALLOWED, strict_slashes=False, endpoint="e", defaults={"a": 1})\n` +
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

  // The highest-risk permission-class negative: IsAuthenticatedOrReadOnly is a
  // string PREFIX of the blessed IsAuthenticated. Recognition is EXACT Set
  // membership (PERMISSION_AUTH.has), never a prefix/substring test, so the
  // prefix must NOT bless even though the blessed class blesses in the same
  // shape. Pins that the two verdicts diverge (a prefix relaxation would fail
  // here loudly rather than silently over-bless a write-exposing route).
  it("IsAuthenticatedOrReadOnly (a prefix of the blessed IsAuthenticated) does NOT bless: recognition is exact Set membership, not a prefix match", async () => {
    const blessed = await py("blessed.py",
      `@api_view(["POST"])\n@permission_classes([IsAuthenticated])\ndef a(request):\n    return Response({})\n`);
    const prefixed = await py("prefixed.py",
      `@api_view(["POST"])\n@permission_classes([IsAuthenticatedOrReadOnly])\ndef b(request):\n    return Response({})\n`);
    expect(extractPythonRoutesAst(blessed.tree!, blessed.relativePath)[0].hasAuth).toBe(true);
    const b = extractPythonRoutesAst(prefixed.tree!, prefixed.relativePath)[0];
    expect(b.hasAuth).toBe(false);
    expect("authUnsureHook" in b).toBe(false);
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

  it("does not bless a custom, unrecognized permission class: permission_classes([FooPermission])", async () => {
    // FooPermission is not in PERMISSION_AUTH (an unknown custom class is
    // ambiguity, which never blesses per never-false-bless). IsAdminUser WAS
    // grouped here too until Upgrade 2 (Task 3): it is now recognized (see the
    // "IsAdminUser in PERMISSION_AUTH" describe below), so it is asserted
    // separately as a positive alongside this negative.
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
      "/a auth=true",
      "/b auth=false",
    ]);
  });

  it("@api_view(METHODS) with a same-file METHODS = [\"POST\"] stays ALL: Upgrade 2 names methods= only, not api_view's positional list argument (deliberate boundary)", async () => {
    const f = await py("apiview-methodsvar.py",
      `METHODS = ["POST"]\n\n` +
      `@api_view(METHODS)\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("ALL");
  });
});

// ─── Upgrade 2 (Task 3): IsAdminUser recognized in PERMISSION_AUTH ──────────
//
// IsAdminUser is unconditional auth (Django's IsAdminUser requires
// request.user.is_staff, which implies an authenticated user; there is no
// per-method carve-out the way IsAuthenticatedOrReadOnly has), so recognizing
// it carries zero false-bless risk. Its neighbors (AllowAny,
// IsAuthenticatedOrReadOnly, an unrecognized custom class) are unaffected.
describe("IsAdminUser in PERMISSION_AUTH", () => {
  it("blesses @permission_classes([IsAdminUser]) BELOW @api_view", async () => {
    const f = await py("isadminuser.py",
      `@api_view(["POST"])\n` +
      `@permission_classes([IsAdminUser])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/create_thing auth=true"]);
  });

  it("blesses the attribute form @permission_classes([permissions.IsAdminUser])", async () => {
    const f = await py("isadminuser-attr.py",
      `@api_view(["POST"])\n` +
      `@permission_classes([permissions.IsAdminUser])\n` +
      `def create_thing(request):\n` +
      `    return Response({})\n`);
    const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/create_thing auth=true"]);
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
    // /a is a documented POSITIVE since Upgrade 2 (Task 3): IsAdminUser is now
    // in PERMISSION_AUTH. Sweep positives are documentation-only (the sweep
    // assertion filters to `!authed`); /b (FooPermission, unrecognized) is the
    // negative this entry still exercises.
    groundTruth: [
      { path: "/a", method: "POST", authed: true },
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
  // ── ADDENDUM Task 5: body-signature ambiguity fixtures ──
  // Every new body-analysis branch, restated as a co-located mutating route with
  // ground-truth authed:false. Visible non-enforcing bodies (email/scrub/log/
  // header/pass/wrong-code/non-login-redirect) resolve flat not-auth; opaque and
  // optionality bodies resolve unsure (hasAuth still false); the two Task 1
  // tightenings (lone-403 does NOT bless, optional-veto beats a reject body) stay
  // pinned. The single assertion below only checks the negatives never bless.
  {
    name: "verify-user-email-emails-only",
    source:
      `@app.before_request\ndef verify_user_email():\n    send_confirmation_email(g.user.email)\n    return None\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "protect-user-data-scrubs-only",
    source:
      `@app.before_request\ndef protect_user_data():\n    scrub_pii(record)\n    return None\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "log-only-auth-named-hook",
    source:
      `@app.before_request\ndef require_login():\n    logger.info("hit %s", request.path)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "header-set-only-hook",
    source:
      `@app.before_request\ndef verify_token():\n    response.headers["X-Frame-Options"] = "DENY"\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "pass-body-auth-named-hook",
    source:
      `@app.before_request\ndef require_login():\n    pass\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "abort-404-hook",
    source:
      `@app.before_request\ndef gate():\n    abort(404)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "abort-400-hook",
    source:
      `@app.before_request\ndef gate():\n    abort(400)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "abort-variable-hook", // opaque -> unsure, hasAuth still false
    source:
      `@app.before_request\ndef require_login():\n    abort(code_var)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "raise-valueerror-hook",
    source:
      `@app.before_request\ndef gate():\n    raise ValueError("bad")\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "redirect-non-login-hook",
    source:
      `@app.before_request\ndef gate():\n    return redirect("/checkout")\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "optional-veto-with-reject-body", // veto beats a real reject body
    source:
      `@app.before_request\ndef optional_authenticate():\n    token = request.headers.get("Authorization")\n    if token is None:\n        abort(401)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "opaque-auth-flavored-helper", // opaque -> unsure
    source:
      `@app.before_request\ndef require_login():\n    check_session()\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "call-form-imported-hook", // imported target -> unsure
    source:
      `from .auth import verify_session\napp.before_request(verify_session)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "attribute-target-hook", // Cls.method target -> unsure
    source:
      `app.before_request(AuthGate.check)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "attributive-collision-unresolvable", // verify_user_email + opaque call -> unsure
    source:
      `@app.before_request\ndef verify_user_email():\n    confirm(user)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "hook-helper-cycle", // a()->b()->a() terminates as none
    source:
      `def b():\n    a()\n\n\n@app.before_request\ndef a():\n    b()\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "errored-hook-dd", // the hook's decorated_definition errors -> invisible
    source:
      `@app.before_request\ndef gate():\n    x = = 1\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "csrf-protect-lone-403-hook", // lone abort(403), no credential read: never blesses
    source:
      `@app.before_request\ndef csrf_protect():\n    abort(403)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "maintenance-gate-lone-403-hook", // same 403-corroboration rule, feature gate shape
    source:
      `@app.before_request\ndef maintenance_gate():\n    abort(403)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "verify-jwt-optional-true-hook", // non-empty arg admits anonymous -> opaque/unsure
    source:
      `@app.before_request\ndef before():\n    verify_jwt_in_request(optional=True)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  // CRITICAL 1: guarded-403 over-match. A 403 gated by a bare credential-ish name
  // against a non-credential container (`"login" in request.path`) or an
  // is-None on an attribute that merely contains the "user" segment
  // (`request.user_agent`) is NOT a credential guard and must never bless.
  {
    name: "path-filter-403", // "login" in request.path is a path filter, not an auth guard
    source:
      `@app.before_request\ndef path_filter():\n    if "login" in request.path:\n        abort(403)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "user-agent-403", // request.user_agent is None reads no credential surface
    source:
      `@app.before_request\ndef user_agent_gate():\n    if request.user_agent is None:\n        abort(403)\n\n` +
      `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  // ACCEPTED OVER-BLESS (documented, NOT asserted authed:false): a boring `gate`
  // hook that early-returns for public paths then abort(401)s reads as a verified
  // reject and blesses its receiver's routes at RECEIVER granularity — including
  // the path it actually exempts. The per-path exemption is invisible to a
  // receiver-scoped analyzer; this is a known, accepted over-bless (route marked
  // authed:true so the never-false-bless assertion below does NOT flag it), the
  // one deliberate over-bless the body path carries. Recorded here so it is an
  // explicit verdict, not a silent pass.
  {
    name: "partial-guard-public-exempt",
    source:
      `@app.before_request\ndef gate():\n    if request.path in PUBLIC:\n        return\n    abort(401)\n\n` +
      `@app.route("/public", methods=["POST"])\ndef public():\n    return {}\n`,
    groundTruth: [{ path: "/public", method: "POST", authed: true }],
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

// ─── ADDENDUM Task 5: the unsure-state sweep + structural invariants ─────────
//
// The machine statement of the THIRD output state. Every fixture whose ground
// truth is "auth-flavored but statically unverifiable" must emit its route with
// hasAuth false AND authUnsureHook === the exact hook name (deterministic
// attribution: a fixture that stops being unsure fails loudly here instead of
// silently degrading to flat copy). The cross-registry law then pins the whole
// third state: unsure never blesses, blessed never hedges.
interface UnsureEntry {
  name: string;
  source: string;
  hook: string; // exact expected authUnsureHook
  path: string;
  method: string;
}
const UNSURE_ROUTE = `\n@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`;
const UNSURE_SWEEP: UnsureEntry[] = [
  {
    name: "opaque-auth-flavored-helper",
    source: `@app.before_request\ndef require_login():\n    check_session()\n` + UNSURE_ROUTE,
    hook: "require_login", path: "/x", method: "POST",
  },
  {
    name: "call-form-imported-hook",
    source: `from .auth import verify_session\napp.before_request(verify_session)\n` + UNSURE_ROUTE,
    hook: "verify_session", path: "/x", method: "POST",
  },
  {
    name: "attribute-target-hook",
    source: `app.before_request(AuthGate.check)\n` + UNSURE_ROUTE,
    hook: "AuthGate.check", path: "/x", method: "POST",
  },
  {
    name: "attributive-collision-unresolvable",
    source: `@app.before_request\ndef verify_user_email():\n    confirm(user)\n` + UNSURE_ROUTE,
    hook: "verify_user_email", path: "/x", method: "POST",
  },
  {
    name: "verify-jwt-optional-true-hook",
    source: `@app.before_request\ndef before():\n    verify_jwt_in_request(optional=True)\n` + UNSURE_ROUTE,
    hook: "before", path: "/x", method: "POST",
  },
  {
    name: "before-app-request-unsure",
    source: `@bp.before_app_request\ndef require_login():\n    check_session()\n` + UNSURE_ROUTE,
    hook: "require_login", path: "/x", method: "POST",
  },
  {
    name: "abort-variable-hook",
    source: `@app.before_request\ndef require_login():\n    abort(code_var)\n` + UNSURE_ROUTE,
    hook: "require_login", path: "/x", method: "POST",
  },
  {
    // ITEM 5: mixed scope. Both an app-scoped unsure hook AND a receiver-scoped
    // unsure hook are present; the route on the named receiver must attribute the
    // RECEIVER hook (verify_local), NOT the app-scoped one (verify_global). Pins
    // the shipped receiver-first precedence.
    name: "mixed-scope-receiver-first",
    source:
      `@app.before_request\ndef verify_global():\n    check_session()\n\n` +
      `@orders_bp.before_request\ndef verify_local():\n    check_session()\n\n` +
      `@orders_bp.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    hook: "verify_local", path: "/x", method: "POST",
  },
];

describe("unsure-state sweep + structural invariants (addendum Task 5)", () => {
  it("every unsure fixture emits its route hasAuth false AND authUnsureHook equal to the expected hook", async () => {
    for (const e of UNSURE_SWEEP) {
      const f = await py(`unsuresweep/${e.name}.py`, e.source);
      const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
      const r = routes.find((x) => x.path === e.path && x.method === e.method);
      expect(r, e.name).toBeDefined();
      expect(r!.hasAuth, e.name).toBe(false);
      expect(r!.authUnsureHook, e.name).toBe(e.hook);
    }
  });

  it("FileMiddleware honesty: no unsure fixture ever sets FileMiddleware.hasAuth", async () => {
    for (const e of UNSURE_SWEEP) {
      const f = await py(`unsuresweep/${e.name}.py`, e.source);
      expect(extractPythonFileMiddlewareAst(f.tree!).hasAuth, e.name).toBe(false);
    }
  });

  it("third-state law over BOTH registries: authUnsureHook implies hasAuth false, hasAuth true implies the key is absent", async () => {
    const sources = [
      ...NEVER_FALSE_BLESS_SWEEP.map((e) => ({ name: e.name, source: e.source })),
      ...UNSURE_SWEEP.map((e) => ({ name: e.name, source: e.source })),
    ];
    for (const s of sources) {
      const f = await py(`law/${s.name}.py`, s.source);
      for (const r of extractPythonRoutesAst(f.tree!, f.relativePath)) {
        if (r.authUnsureHook !== undefined) {
          expect(r.hasAuth, `${s.name} ${r.method} ${r.path}`).toBe(false);
        }
        if (r.hasAuth === true) {
          expect("authUnsureHook" in r, `${s.name} ${r.method} ${r.path}`).toBe(false);
        }
      }
    }
  });

  it("ambiguous-body generator sweep: every opaque/ambiguous body under an auth-named hook resolves not-auth or unsure, never a bless", async () => {
    const bodies = [
      "    abort(code_var)",
      "    abort(404)",
      "    abort(500)",
      "    raise HTTPException(status_code=CODE)",
      "    return redirect(url_for(page_var))",
      "    raise SomeException()",
      "    opaque_boring_call()",
    ];
    for (const body of bodies) {
      const src =
        `@app.before_request\ndef require_login():\n${body}\n\n` +
        `@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`;
      const f = await py("ambig.py", src);
      const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
      expect(routes[0]?.hasAuth ?? false, body).toBe(false);
    }
  });

  it("methods=variable never GET-defaults: every statically unresolvable form resolves ALL, specifically never GET", async () => {
    const FORMS: Array<[string, string]> = [
      ["computed binary", `@app.route("/x", methods=BASE + EXTRA)\ndef h():\n    return {}\n`],
      ["imported (no same-file assignment)", `@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["call rhs", `ALLOWED = get_methods()\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["identifier alias chain", `ALLOWED = OTHER\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["twice reassigned", `ALLOWED = ["GET"]\nALLOWED = ["POST"]\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["conditional reassign (nested second write)", `ALLOWED = ["GET"]\nif F:\n    ALLOWED = ["GET", "POST"]\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["try-block reassign (nested second write)", `ALLOWED = ["GET"]\ntry:\n    ALLOWED = load()\nexcept Exception:\n    pass\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["augmented", `ALLOWED = ["GET"]\nALLOWED += ["POST"]\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["conditional (not top-level)", `if PROD:\n    ALLOWED = ["POST"]\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["subscript element write", `ALLOWED = ["GET"]\nALLOWED[0] = "POST"\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["slice replacement", `ALLOWED = ["GET"]\nALLOWED[:] = ["POST"]\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["with-as binding", `ALLOWED = ["GET"]\nwith open("m") as ALLOWED:\n    pass\n@app.route("/x", methods=ALLOWED)\ndef h():\n    return {}\n`],
      ["inline splat [*BASE]", `@app.route("/x", methods=[*BASE])\ndef h():\n    return {}\n`],
      ["non-string element", `@app.route("/x", methods=[SOME_VERB])\ndef h():\n    return {}\n`],
    ];
    for (const [label, src] of FORMS) {
      const f = await py("mvar.py", src);
      const routes = extractPythonRoutesAst(f.tree!, f.relativePath);
      expect(routes[0], label).toBeDefined();
      expect(routes[0].method, label).toBe("ALL");
      expect(routes[0].method, label).not.toBe("GET");
    }
  });

  it("hasError gate: broken-parse and errored-hook fixtures emit nothing bless-able and nothing hedged", async () => {
    const broken = [
      `@app.post("/bad")\n@login_required\ndef bad()\n    return 1\n@app.post("/good")\ndef good():\n    return 2\n`,
      `@app.post("/bad")\ndef bad():\n    x = = 1\n\n@app.post("/good")\ndef good():\n    return 2\n`,
      `@app.before_request\ndef gate():\n    x = = 1\n\n@app.route("/x", methods=["POST"])\ndef x():\n    return {}\n`,
    ];
    for (const src of broken) {
      const f = await py("broken.py", src);
      for (const r of extractPythonRoutesAst(f.tree!, f.relativePath)) {
        expect(r.hasAuth).toBe(false);
        expect(r.authUnsureHook).toBeUndefined();
      }
    }
  });

  it("byte-identity: JS AST routes and Go regex routes never carry the Python-only authUnsureHook", async () => {
    const jf = await fileWithTree(
      "src/routes/x.ts",
      `const router = express.Router();\nrouter.post("/x", requireAuth, (req, res) => res.json({}));\n`,
      "typescript",
    );
    const jsRoute = extractJsRoutesAst(jf.tree!, jf.relativePath, undefined)[0];
    expect("authUnsureHook" in jsRoute).toBe(false);
    // Serialized shape unchanged (no stray hedge key leaks into the JS RouteInfo).
    expect(JSON.stringify(jsRoute)).toBe(
      `{"method":"POST","path":"/x","file":"src/routes/x.ts","line":2,"hasAuth":true,"hasValidation":false,"hasRateLimit":false,"hasErrorHandler":false}`,
    );
    // Go regex path (no tree): a fired auth finding renders the flat deviator
    // copy, never the hedge — proving Go RouteInfos carry no authUnsureHook.
    const goFile = (n: string, auth: boolean) => ({
      relativePath: `gosrv/routes/${n}.go`,
      language: "go" as const,
      content:
        `package routes\n${auth ? "// authMiddleware\n" : ""}func R${n}(e *echo.Echo) {\n${auth ? "\te.Use(authMiddleware)\n" : ""}\te.POST("/${n}", c${n})\n}\n`,
      lineCount: 6,
      tree: undefined,
    });
    const goCtx = {
      files: [goFile("a", true), goFile("b", true), goFile("c", true), goFile("d", true), goFile("e", false)],
      totalLines: 30,
      dominantLanguage: "go",
    };
    const goAuth = securityConsistency
      .detect(goCtx as any)
      .filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.auth);
    expect(goAuth.length).toBeGreaterThan(0);
    for (const a of goAuth) {
      const rendered = (a.recommendation + JSON.stringify(a.deviatingFiles)).toLowerCase();
      expect(rendered).not.toContain("double check");
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

  it("opaque + CORE name never blesses: authenticate_request delegating to _do_auth() -> unsure", async () => {
    // Reconciled with the Go/Rust LOCKED decision: an opaque body hedges on ANY
    // name (including a CORE auth name), it never blesses. Only a VERIFIED reject
    // (rule 2) blesses.
    expect(await cls("authenticate_request", `def hook():\n    _do_auth()\n`, true)).toBe("unsure");
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

  it("body null + CORE simple never blesses: authenticate -> unsure", () => {
    // An unreadable body never blesses on name (Go/Rust parity); a CORE auth name
    // hedges to unsure, double check.
    expect(classifyHookAuth("authenticate", null, new Map(), true)).toBe("unsure");
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

  // CRITICAL 1 (false-bless): the guarded-403 bless gate must read a STRUCTURAL
  // credential surface (a session/request .get call, a session/g subscript, a
  // credential membership against session/request.session/request.headers, or an
  // is-None test on a known credential surface), never a bare credential-ish name
  // against ANY container. A path filter that 403s and a user-agent null-check
  // that 403s must NOT drive a bless.
  it("bodyAuthSignature: `if \"login\" in request.path: abort(403)` does NOT bless (string-in-ANY-container over-match closed)", async () => {
    const src = `def hook():\n    if "login" in request.path:\n        abort(403)\n`;
    expect(await sig(src)).not.toBe("reject");
    expect(await sig(src)).toBe("opaque");
  });

  it("bodyAuthSignature: `if request.user_agent is None: abort(403)` does NOT bless (bare credential-segment name over-match closed)", async () => {
    const src = `def hook():\n    if request.user_agent is None:\n        abort(403)\n`;
    expect(await sig(src)).not.toBe("reject");
    expect(await sig(src)).toBe("opaque");
  });

  it("bodyAuthSignature: `if not session.get(\"user\"): abort(403)` stays reject (structural .get guard on session)", async () => {
    const src = `def hook():\n    if not session.get("user"):\n        abort(403)\n`;
    expect(await sig(src)).toBe("reject");
  });

  it("bodyAuthSignature: `if request.headers.get(\"Authorization\") is None: abort(403)` stays reject (structural header .get guard)", async () => {
    const src = `def hook():\n    if request.headers.get("Authorization") is None:\n        abort(403)\n`;
    expect(await sig(src)).toBe("reject");
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

  it("call-form CORE name never blesses: app.before_request(authenticate) -> unsure, hook 'authenticate'", async () => {
    // Reconciled: an unreadable before_request hook hedges on name, never blesses.
    const { routes } = await routesOf(`app.before_request(authenticate)\n` + ROUTE);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBe("authenticate");
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

describe("extractPythonRoutesAst: cross-file imported hook / dependency resolution", () => {
  // HEADLINE — an imported before_request hook whose in-repo body verifiably
  // rejects blesses every route on its receiver; without the index it stays UNSURE
  // (never blesses), byte-identical to today.
  it("imported rejecting before_request hook: unsure -> auth (with index)", async () => {
    const files = await repo([
      ["pkg/routes.py",
        `from .auth import verify_session\n` +
        `app.before_request(verify_session)\n\n` +
        `@app.post("/orders")\ndef create_order():\n    return {}\n`],
      ["pkg/auth.py",
        `def verify_session():\n    if session.get("user_id") is None:\n        abort(401)\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "pkg/routes.py")!;

    const withIdx = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index);
    expect(withIdx.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /orders auth=true",
    ]);
    expect(withIdx.every((r) => r.authUnsureHook === undefined)).toBe(true);

    // Index absent: today's behavior — unsure, never blessed (byte-identity guard).
    const noIdx = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath);
    expect(noIdx.map((r) => `${r.path} auth=${r.hasAuth} hook=${r.authUnsureHook ?? ""}`)).toEqual([
      "/orders auth=false hook=verify_session",
    ]);
  });

  // Boring-named imported Depends: not a name-lexicon hit; blesses ONLY via the
  // resolved rejecting body (rule 2), never a new name path.
  it("boring-named imported Depends whose in-repo body rejects blesses", async () => {
    const files = await repo([
      ["routes.py",
        `from .deps import load_actor\n\n` +
        `@router.get("/me")\ndef me(user=Depends(load_actor)):\n    return user\n`],
      ["deps.py",
        `def load_actor():\n    if session.get("user_id") is None:\n        abort(401)\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    expect(extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index)
      .map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/me auth=true"]);
    // Index absent: load_actor is no lexicon hit -> stays not-auth (byte-identity).
    expect(extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath)
      .map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/me auth=false"]);
  });

  // Direct optional dependency: the CALL-SITE veto short-circuits before any body
  // or cross-file resolution.
  it("direct imported Depends(get_current_user_optional) stays not-auth (name veto)", async () => {
    const files = await repo([
      ["routes.py",
        `from .deps import get_current_user_optional\n\n` +
        `@router.get("/me")\ndef me(user=Depends(get_current_user_optional)):\n    return user\n`],
      ["deps.py",
        `def get_current_user_optional():\n    if session.get("user_id") is None:\n        abort(401)\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    expect(extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index)
      .map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/me auth=false"]);
  });

  // ALIASED optional Depends (never-false-bless): the alias hides "optional"; the
  // veto MUST run on the RESOLVED ORIGINAL name or the rejecting body false-blesses.
  it("aliased imported Depends(load_actor -> get_current_user_optional) stays not-auth", async () => {
    const files = await repo([
      ["routes.py",
        `from .deps import get_current_user_optional as load_actor\n\n` +
        `@router.get("/me")\ndef me(user=Depends(load_actor)):\n    return user\n`],
      ["deps.py",
        `def get_current_user_optional():\n    if session.get("user_id") is None:\n        abort(401)\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    expect(extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index)
      .map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/me auth=false"]);
  });

  // ALIASED optional before_request hook (never-false-bless): resolved-name veto on
  // the hook path. Alias `check` has no "optional" segment; the resolved original
  // does, so the rejecting body must NOT bless.
  it("aliased imported before_request(check -> get_current_user_optional) stays not-auth", async () => {
    const files = await repo([
      ["routes.py",
        `from .auth import get_current_user_optional as check\n` +
        `app.before_request(check)\n\n` +
        `@app.post("/x")\ndef x():\n    return {}\n`],
      ["auth.py",
        `def get_current_user_optional():\n    if session.get("user_id") is None:\n        abort(401)\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    const routes = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index);
    expect(routes.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  // TARGET-file defs: the resolved body's one-hop helper must resolve in the TARGET
  // file, not the importer. The importer defines a same-named _check that does NOT
  // reject; the target's _check does. Blessing proves the TARGET defs were supplied.
  it("resolved body's one-hop helper resolves against the TARGET file's defs", async () => {
    const files = await repo([
      ["routes.py",
        `from .auth import verify_session\n\n` +
        `def _check():\n    return None\n\n` +
        `app.before_request(verify_session)\n\n` +
        `@app.post("/x")\ndef x():\n    return {}\n`],
      ["auth.py",
        `def verify_session():\n    _check()\n\n` +
        `def _check():\n    if session.get("user_id") is None:\n        abort(401)\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    expect(extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index)
      .map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=true"]);
  });

  // IN-FILE precedence / byte-identity: a locally-defined verify_session (visible
  // non-enforcing body) classifies from the LOCAL def; a same-named cross-file
  // rejecting def never overrides it. Index present === index absent.
  it("in-file def takes precedence over a same-named cross-file def", async () => {
    const files = await repo([
      ["routes.py",
        `def verify_session():\n    return None\n\n` +
        `app.before_request(verify_session)\n\n` +
        `@app.post("/x")\ndef x():\n    return {}\n`],
      ["auth.py",
        `def verify_session():\n    if session.get("user_id") is None:\n        abort(401)\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    const withIdx = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index);
    const noIdx = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath);
    expect(withIdx.map((r) => `${r.path} auth=${r.hasAuth}`)).toEqual(["/x auth=false"]);
    expect(withIdx).toEqual(noIdx); // cross-file never consulted
  });

  // External / not-in-repo symbol: no candidate file -> refuse -> stays UNSURE,
  // byte-identical to the pre-change serialization.
  it("imported-from-nonexistent-module hook stays unsure (byte-identical)", async () => {
    const files = await repo([
      ["routes.py",
        `from external_auth import verify_session\n` +
        `app.before_request(verify_session)\n\n` +
        `@app.post("/x")\ndef x():\n    return {}\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    const withIdx = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index);
    const noIdx = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath);
    expect(withIdx.map((r) => `${r.path} auth=${r.hasAuth} hook=${r.authUnsureHook ?? ""}`))
      .toEqual(["/x auth=false hook=verify_session"]);
    expect(withIdx).toEqual(noIdx);
  });

  // Target with a parse error: resolvePyHookBody refuses (no fileDefs entry) -> the
  // route stays UNSURE. A broken target must never contribute a bless.
  it("broken target file never blesses (stays unsure)", async () => {
    const files = await repo([
      ["routes.py",
        `from .auth import verify_session\n` +
        `app.before_request(verify_session)\n\n` +
        `@app.post("/x")\ndef x():\n    return {}\n`],
      // Deliberately unparseable.
      ["auth.py", `def verify_session(\n    if if if\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    expect(extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index)
      .map((r) => `${r.path} auth=${r.hasAuth} hook=${r.authUnsureHook ?? ""}`))
      .toEqual(["/x auth=false hook=verify_session"]);
  });

  // Aliased-module ATTRIBUTE target (module-qualified form is DEFERRED in v1):
  // a.check_user is an attribute arg0, never resolved cross-file, byte-identical,
  // never blessed.
  it("aliased-module attribute hook target is not resolved cross-file (byte-identical)", async () => {
    const files = await repo([
      ["routes.py",
        `import myapp.auth as a\n` +
        `app.before_request(a.check_user)\n\n` +
        `@app.post("/x")\ndef x():\n    return {}\n`],
      ["myapp/auth.py",
        `def check_user():\n    if session.get("user_id") is None:\n        abort(401)\n`],
    ]);
    const index = buildXFileIndex(files);
    const routeFile = files.find((f) => f.relativePath === "routes.py")!;
    const withIdx = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath, index);
    const noIdx = extractPythonRoutesAst(routeFile.tree!, routeFile.relativePath);
    expect(withIdx.every((r) => r.hasAuth === false)).toBe(true);
    expect(withIdx).toEqual(noIdx);
  });
});

// ─── Task 5: adversarial never-false-bless sweep (cross-file, Python) ────────
//
// GOVERNING INVARIANT — a WRONG cross-file attribution (a route blessed from
// the wrong body, or blessed when resolution should have refused) is a
// false-bless. Every entry below registers a REAL rejecting body somewhere in
// the repo, so a broken refuse guard would visibly bless the route; the sweep
// asserts it never does. Hook names use "verify_session" (never "authenticate"
// or another AUTH_CORE_SEGMENTS/DEPENDS_AUTH_SEGMENTS member) so no entry is
// accidentally satisfied by the PRE-EXISTING name-only CORE bless
// (classifyHookAuth rule 5) or the Depends name-lexicon hit — every refusal
// here is driven by cross-file resolution, not a name shortcut.

interface PyXFileSweepEntry {
  name: string;
  files: [string, string][];
  routeFile: string;
  groundTruth: Array<{ path: string; method: string; authed: boolean }>;
}

const REJECT = (name: string) =>
  `def ${name}():\n    if session.get("user_id") is None:\n        abort(401)\n`;

const PY_NEVER_FALSE_BLESS_XFILE: PyXFileSweepEntry[] = [
  {
    name: "absolute (dotted) import — never a resolvable target",
    files: [
      ["app/routes.py", `from app.auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "relative import beyond the repo root",
    files: [
      ["routes.py", `from ..auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["auth.py", REJECT("verify_session")],
    ],
    routeFile: "routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "multi-candidate: module.py AND package/__init__.py both exist",
    files: [
      ["app/routes.py", `from .auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
      ["app/auth/__init__.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "duplicate def in the target file",
    files: [
      ["app/routes.py", `from .auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", `${REJECT("verify_session")}\ndef verify_session():\n    return None\n`],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "symbol absent in target, defined only by a sibling (WRONG-FILE)",
    files: [
      ["app/routes.py", `from .auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", `def helpers():\n    return 1\n`],
      ["app/other.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "wildcard import binds the used name directly (wildcard-name)",
    files: [
      ["app/routes.py", `from .auth import *\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "wildcard elsewhere + explicit co-import (WILDCARD-PRESENT blanket refuse)",
    files: [
      ["app/routes.py", `from .other import *\nfrom .auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
      ["app/other.py", `def other():\n    return 1\n`],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "re-export chain deeper than one hop (depth exceeded)",
    files: [
      ["app/routes.py", `from .auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth/__init__.py", `from .a import verify_session\n`],
      ["app/auth/a.py", `from .b import verify_session\n`],
      ["app/auth/b.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "target file has a parse error",
    files: [
      ["app/routes.py", `from .auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", `def verify_session(\n    if if if\n`],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "module-scope assignment shadows the imported name (local-shadow)",
    files: [
      ["app/routes.py", `from .auth import verify_session\nverify_session = None\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "poisoned: two RELATIVE imports bind the same name",
    files: [
      ["app/routes.py", `from .auth import verify_session\nfrom .other_auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
      ["app/other_auth.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "poisoned: relative + ABSOLUTE import bind the same name",
    files: [
      ["app/routes.py", `from .auth import verify_session\nfrom thirdparty import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "poisoned: relative + `import x as name` bind the same name",
    files: [
      ["app/routes.py", `from .auth import verify_session\nimport thirdparty as verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "ALIASED-OPTIONAL: alias hides the optional-auth veto name",
    files: [
      ["app/routes.py", `from .auth import get_current_user_optional as check\napp.before_request(check)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("get_current_user_optional")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
  {
    name: "attribute (module-qualified) hook target is never resolved cross-file",
    files: [
      ["app/routes.py", `import myapp.auth as a\napp.before_request(a.check_user)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["myapp/auth.py", REJECT("check_user")],
    ],
    routeFile: "app/routes.py",
    groundTruth: [{ path: "/x", method: "POST", authed: false }],
  },
];

describe("NEVER-FALSE-BLESS adversarial sweep (cross-file, Python)", () => {
  it("no ground-truth-unauthed route is ever emitted hasAuth:true (cross-file)", async () => {
    for (const e of PY_NEVER_FALSE_BLESS_XFILE) {
      const files = await repo(e.files);
      const index = buildXFileIndex(files);
      const rf = files.find((f) => f.relativePath === e.routeFile)!;
      const routes = extractPythonRoutesAst(rf.tree!, rf.relativePath, index);
      for (const gt of e.groundTruth.filter((g) => !g.authed)) {
        const emitted = routes.find((r) => r.path === gt.path && r.method === gt.method);
        // Non-vacuous: the route must actually have been extracted (the
        // classifier genuinely ran) — a route that silently vanished would
        // trivially satisfy the hasAuth assertion below without proving anything.
        expect(emitted, `${e.name}: route was never extracted`).toBeDefined();
        expect(emitted?.hasAuth ?? false, `${e.name}: ${gt.method} ${gt.path}`).toBe(false);
      }
    }
  });
});

describe("EXTERNAL-PARITY (cross-file adds zero blesses for out-of-repo Python symbols)", () => {
  const EXTERNAL_FIXTURES: Array<[string, [string, string][]]> = [
    ["import from a module that does not exist in-repo", [
      ["app/routes.py", `from .external_auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
    ]],
    ["absolute (dotted) import of an in-repo-looking module", [
      ["app/routes.py", `from app.auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
    ]],
    ["attribute (module-qualified) target", [
      ["app/routes.py", `import myapp.auth as a\napp.before_request(a.check_user)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["myapp/auth.py", REJECT("check_user")],
    ]],
    ["wildcard import present", [
      ["app/routes.py", `from .auth import *\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("verify_session")],
    ]],
  ];

  it("index-present and index-absent RouteInfo arrays are byte-identical for every external fixture", async () => {
    for (const [name, spec] of EXTERNAL_FIXTURES) {
      const files = await repo(spec);
      const index = buildXFileIndex(files);
      const rf = files.find((f) => f.relativePath === "app/routes.py")!;
      const withIndex = extractPythonRoutesAst(rf.tree!, rf.relativePath, index);
      const withoutIndex = extractPythonRoutesAst(rf.tree!, rf.relativePath);
      expect(withIndex, name).toEqual(withoutIndex);
    }
  });
});

describe("WRONG-FILE guard (Python, the single most important cross-file pin)", () => {
  it("a boring TARGET-file body wins over a rejecting SIBLING with the same name", async () => {
    const files = await repo([
      ["app/routes.py", `from .auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      // The EXACT import target: boring, visible, non-enforcing.
      ["app/auth.py", `def verify_session():\n    return None\n`],
      // A sibling with the SAME name that DOES reject — must never be consulted.
      ["app/other.py", REJECT("verify_session")],
    ]);
    const index = buildXFileIndex(files);
    const rf = files.find((f) => f.relativePath === "app/routes.py")!;
    const routes = extractPythonRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    // The TARGET file's own boring body drives the verdict: a visible
    // non-enforcing body is flat not-auth (rule 3), never hedged, and the
    // sibling's reject is NEVER consulted — there is no repo-wide name search.
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBeUndefined();

    // Direct proof: resolvePyHookBody resolves to the TARGET's own boring
    // body specifically, never the sibling's rejecting one.
    const resolved = resolvePyHookBody(index, "app/routes.py", "verify_session");
    expect(resolved).not.toBeNull();
    expect(bodyAuthSignature(resolved!.body!, resolved!.defs)).toBe("none");
  });
});

describe("ONE-HOP-CEILING (Python): a second cross-file hop is never followed", () => {
  it("a resolved hook whose reject needs a SECOND cross-file hop stays not-auth", async () => {
    const files = await repo([
      ["app/routes.py", `from .auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      // The FIRST hop's target: verify_session calls a helper that is itself
      // IMPORTED (a second cross-file hop), never defined in auth.py.
      ["app/auth.py", `from .helpers import _check\n\ndef verify_session():\n    _check()\n`],
      ["app/helpers.py", REJECT("_check")],
    ]);
    const index = buildXFileIndex(files);
    const rf = files.find((f) => f.relativePath === "app/routes.py")!;
    const routes = extractPythonRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(false);

    // Non-vacuous: the FIRST hop resolves fine (auth.py's verify_session IS
    // found); the reject only lives two hops away (helpers.py's _check), which
    // classification never reaches — it uses ONLY the defining file's own defs.
    const resolved = resolvePyHookBody(index, "app/routes.py", "verify_session");
    expect(resolved).not.toBeNull();
    expect(resolved!.defs.has("_check")).toBe(false); // _check is not in auth.py's own defs
    expect(bodyAuthSignature(resolved!.body!, resolved!.defs)).not.toBe("reject");
  });
});

// ─── Task 2 review — required Python coverage pins (mandatory additions) ─────

describe("Task 2 review — required Python coverage pins", () => {
  it("DIRECT (non-aliased) imported optional HOOK stays not-auth via the resolved-name veto", async () => {
    const files = await repo([
      ["app/routes.py", `from .auth import get_current_user_optional\napp.before_request(get_current_user_optional)\n\n@app.post("/x")\ndef x():\n    return {}\n`],
      ["app/auth.py", REJECT("get_current_user_optional")],
    ]);
    const index = buildXFileIndex(files);
    const rf = files.find((f) => f.relativePath === "app/routes.py")!;

    // Non-vacuous: resolution DOES succeed (the target body IS the rejecting
    // one) — the optional-auth veto is what stops the bless, not a resolution
    // failure.
    const resolved = resolvePyHookBody(index, "app/routes.py", "get_current_user_optional");
    expect(resolved).not.toBeNull();
    expect(bodyAuthSignature(resolved!.body!, resolved!.defs)).toBe("reject");

    const routes = extractPythonRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(false);
    expect(routes[0].authUnsureHook).toBeUndefined();
  });

  it("a TARGET body calling a helper that exists ONLY in the importer does not bless (helper-only-in-importer inverse)", async () => {
    const files = await repo([
      ["app/routes.py",
        `from .auth import verify_session\n\n` +
        `def _check():\n    if session.get("user_id") is None:\n        abort(401)\n\n` +
        `app.before_request(verify_session)\n\n` +
        `@app.post("/x")\ndef x():\n    return {}\n`],
      // The TARGET file's verify_session calls _check — but _check exists
      // ONLY in the importer above, never here.
      ["app/auth.py", `def verify_session():\n    _check()\n`],
    ]);
    const index = buildXFileIndex(files);
    const rf = files.find((f) => f.relativePath === "app/routes.py")!;

    // Non-vacuous: resolution DOES succeed (the target body IS found) — but
    // `_check` exists ONLY in the importer (routes.py), never in the target's
    // (auth.py) own defs, so the one-hop MUST NOT reach across to it.
    const resolved = resolvePyHookBody(index, "app/routes.py", "verify_session");
    expect(resolved).not.toBeNull();
    expect(resolved!.defs.has("_check")).toBe(false);
    expect(bodyAuthSignature(resolved!.body!, resolved!.defs)).not.toBe("reject");

    const routes = extractPythonRoutesAst(rf.tree!, rf.relativePath, index);
    expect(routes).toHaveLength(1);
    expect(routes[0].hasAuth).toBe(false);
  });
});
