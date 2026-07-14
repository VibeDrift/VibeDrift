import { describe, it, expect } from "vitest";
import { extractPythonRoutesAst } from "../../../src/drift/security-ast-python.js";
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
