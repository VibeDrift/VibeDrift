import { describe, it, expect } from "vitest";
import { extractRustRoutesAst } from "../../../src/drift/security-ast-rust.js";
import { fileWithTree } from "../../helpers/drift-tree.js";

const rs = (path: string, src: string) => fileWithTree(path, src, "rust");

describe("security-ast-rust: grammar-fact pins", () => {
  it("pins the load-bearing Rust grammar facts this module is built on", async () => {
    // Probe-verified 2026-07-15 against the pinned tree-sitter-wasms rust
    // grammar. A grammar bump that renames these fails HERE with a named
    // fact, not as a silent recall collapse.

    // Axum builder `.route` anchor shape.
    const f = await rs("facts.rs",
      `fn app() -> Router {\n    Router::new().route("/x", post(h))\n}\n`);
    expect(f.tree!.rootNode.hasError).toBe(false);
    const routeCall = f.tree!.rootNode.descendantsOfType("call_expression")
      .find((c) => c?.childForFieldName("function")?.type === "field_expression"
        && c.childForFieldName("function")?.childForFieldName("field")?.text === "route")!;
    const fn = routeCall.childForFieldName("function")!;
    expect(fn.type).toBe("field_expression");
    const field = fn.childForFieldName("field")!;
    expect(field.type).toBe("field_identifier");
    expect(field.text).toBe("route");
    const args = routeCall.childForFieldName("arguments")!.namedChildren
      .filter((n) => n !== null);
    expect(args[0]!.type).toBe("string_literal");
    expect(args[1]!.type).toBe("call_expression");

    // string_literal is a LEAF (no string_content child) for a plain path.
    expect(args[0]!.namedChildCount).toBe(0);
    // raw_string_literal is a leaf too; its .text carries the r-prefix.
    const rawFile = await rs("raw.rs", `fn f() { let x = r"raw"; }\n`);
    const raw = rawFile.tree!.rootNode.descendantsOfType("raw_string_literal")[0]!;
    expect(raw.namedChildCount).toBe(0);
    expect(raw.text.startsWith("r")).toBe(true);

    // Method-router callee shapes.
    const plainVerb = args[1]!.childForFieldName("function")!;
    expect(plainVerb.type).toBe("identifier");
    expect(plainVerb.text).toBe("post");

    const scopedFile = await rs("scoped.rs",
      `fn app() -> Router {\n    Router::new().route("/x", axum::routing::post(h))\n}\n`);
    const scopedCall = scopedFile.tree!.rootNode.descendantsOfType("call_expression")
      .find((c) => c?.childForFieldName("function")?.type === "field_expression"
        && c.childForFieldName("function")?.childForFieldName("field")?.text === "route")!;
    const scopedArg1 = scopedCall.childForFieldName("arguments")!.namedChildren
      .filter((n) => n !== null)[1]!;
    const scopedFn = scopedArg1.childForFieldName("function")!;
    expect(scopedFn.type).toBe("scoped_identifier");
    expect(scopedFn.childForFieldName("name")?.text).toBe("post");

    const chainedFile = await rs("chained.rs",
      `fn app() -> Router {\n    Router::new().route("/x", get(l).post(c))\n}\n`);
    const chainedCall = chainedFile.tree!.rootNode.descendantsOfType("call_expression")
      .find((c) => c?.childForFieldName("function")?.type === "field_expression"
        && c.childForFieldName("function")?.childForFieldName("field")?.text === "route")!;
    const chainedArg1 = chainedCall.childForFieldName("arguments")!.namedChildren
      .filter((n) => n !== null)[1]!;
    const chainedFn = chainedArg1.childForFieldName("function")!;
    expect(chainedFn.type).toBe("field_expression");
    expect(chainedFn.childForFieldName("field")?.text).toBe("post");

    // StatusCode::UNAUTHORIZED shape (forward-looking, Task 3).
    const statusFile = await rs("status.rs", `fn f() { let x = StatusCode::UNAUTHORIZED; }\n`);
    const statusNode = statusFile.tree!.rootNode.descendantsOfType("scoped_identifier")[0]!;
    expect(statusNode.childForFieldName("path")?.type).toBe("identifier");
    expect(statusNode.childForFieldName("path")?.text).toBe("StatusCode");
    expect(statusNode.childForFieldName("name")?.type).toBe("identifier");
    expect(statusNode.childForFieldName("name")?.text).toBe("UNAUTHORIZED");

    // Attribute-macro association: a PRECEDING SIBLING, never a child.
    const attrFile = await rs("attr.rs", `#[post("/x")]\nfn h(){}\n`);
    const fnItem = attrFile.tree!.rootNode.descendantsOfType("function_item")[0]!;
    expect(fnItem.previousNamedSibling?.type).toBe("attribute_item");
    expect(fnItem.descendantsOfType("attribute_item").length).toBe(0);
    const attrItem = attrFile.tree!.rootNode.descendantsOfType("attribute_item")[0]!;
    const attr = attrItem.namedChildren.filter((n) => n !== null)
      .find((n) => n.type === "attribute")!;
    expect(attr.childForFieldName("path")).toBeNull();
    const tokenTree = attr.childForFieldName("arguments")!;
    expect(tokenTree.type).toBe("token_tree");
    const firstString = tokenTree.namedChildren.filter((n) => n !== null)
      .find((n) => n.type === "string_literal")!;
    expect(firstString.text).toBe('"/x"');

    // middleware::from_fn / from_fn_with_state shapes (forward-looking, Task 3).
    const mwFile = await rs("mw.rs", `fn app() { let x = middleware::from_fn(auth); }\n`);
    const mwCall = mwFile.tree!.rootNode.descendantsOfType("call_expression")[0]!;
    const mwFn = mwCall.childForFieldName("function")!;
    expect(mwFn.type).toBe("scoped_identifier");
    expect(mwFn.childForFieldName("name")?.text).toBe("from_fn");
    const mwArgs = mwCall.childForFieldName("arguments")!.namedChildren.filter((n) => n !== null);
    expect(mwArgs.length).toBe(1);
    expect(mwArgs[0]!.type).toBe("identifier");

    const mwStateFile = await rs("mwstate.rs",
      `fn app() { let x = middleware::from_fn_with_state(st, auth); }\n`);
    const mwStateCall = mwStateFile.tree!.rootNode.descendantsOfType("call_expression")[0]!;
    const mwStateArgs = mwStateCall.childForFieldName("arguments")!.namedChildren
      .filter((n) => n !== null);
    expect(mwStateArgs[mwStateArgs.length - 1]!.text).toBe("auth");

    // impl Trait for Type shape (forward-looking, Task 3).
    const implFile = await rs("impl.rs", `impl FromRequest for AuthUser {}\n`);
    const implItem = implFile.tree!.rootNode.descendantsOfType("impl_item")[0]!;
    expect(implItem.childForFieldName("trait")?.text).toBe("FromRequest");
    expect(implItem.childForFieldName("type")?.text).toBe("AuthUser");

    const inherentFile = await rs("inherent.rs", `impl AuthUser {}\n`);
    const inherentItem = inherentFile.tree!.rootNode.descendantsOfType("impl_item")[0]!;
    expect(inherentItem.childForFieldName("trait")).toBeNull();

    // Broken source still returns a tree (never null), flagged via hasError.
    const broken = await rs("broken.rs", `fn f( {{{ .route(`);
    expect(broken.tree).toBeDefined();
    expect(broken.tree!.rootNode.hasError).toBe(true);
  });
});

describe("extractRustRoutesAst: Axum builder routes", () => {
  it("extracts a POST builder route with method, path, and anchor line", async () => {
    const f = await rs("routes.rs",
      `fn app() -> Router {\n` +
      `    Router::new().route("/orders", post(create_order))\n` +
      `}\n`);
    const routes = extractRustRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual([
      "POST /orders auth=false",
    ]);
    expect(routes[0].line).toBe(2);
    expect(routes[0].file).toBe("routes.rs");
  });

  it("emits one route per .route link in a fluent chain, each with its own line", async () => {
    const f = await rs("chain.rs",
      `fn app() -> Router {\n` +
      `    Router::new()\n` +
      `        .route("/orders", post(create))\n` +
      `        .route("/orders/:id", delete(remove))\n` +
      `}\n`);
    const routes = extractRustRoutesAst(f.tree!, f.relativePath);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /orders", "DELETE /orders/:id"]);
    // Each link reports ITS OWN source line (the chain's outer node spans back
    // to Router::new()'s line, which would be wrong for both if reused).
    expect(routes.map((r) => r.line)).toEqual([3, 4]);
  });

  it("does NOT emit a route for a non-web .route call whose arg1 is not a verb", async () => {
    const f = await rs("n.rs", `fn f(cfg: Cfg) { cfg.route("/x", handler_service); }\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("recognizes a turbofish-based Router::<AppState>::new() base", async () => {
    const f = await rs("turbofish.rs",
      `fn app() -> Router<AppState> {\n    Router::<AppState>::new().route("/x", post(h))\n}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("emits a GET-only builder route for completeness", async () => {
    const f = await rs("health.rs",
      `fn app() -> Router {\n    Router::new().route("/health", get(health))\n}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /health"]);
  });

  it("does not let passthrough links (.layer/.with_state/.fallback/.merge) stop the walk", async () => {
    const f = await rs("passthrough.rs",
      `fn app() -> Router {\n` +
      `    Router::new()\n` +
      `        .route("/a", get(x))\n` +
      `        .layer(auth_layer())\n` +
      `        .with_state(state())\n` +
      `        .fallback(not_found)\n` +
      `        .route("/b", post(y))\n` +
      `        .merge(other())\n` +
      `}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /a", "POST /b"]);
  });

  it("recognizes sibling .route links around a .nest(...) without applying its prefix", async () => {
    // .nest("/api", api_routes()) itself emits zero routes; the /api prefix is
    // NOT applied to sibling routes (documented cross-expression recall gap).
    const f = await rs("nest.rs",
      `fn app() -> Router {\n` +
      `    Router::new()\n` +
      `        .route("/a", get(x))\n` +
      `        .nest("/api", api_routes())\n` +
      `        .route("/b", post(y))\n` +
      `}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["GET /a", "POST /b"]);
  });

  it("recognizes .route on a variable receiver (single-fluent-chain only)", async () => {
    const f = await rs("var.rs",
      `fn f() {\n    let app = Router::new();\n    app.route("/x", post(h));\n}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("does not resolve a .layer applied in a separate statement onto the route", async () => {
    // Documents current scope: middleware scope tracing is Task 4. A .layer
    // call on the same receiver in an earlier, separate statement never
    // touches this route's recognition (still recognized; hasAuth stays false
    // regardless either way in Task 1).
    const f = await rs("varlayer.rs",
      `fn f() {\n` +
      `    let app = Router::new();\n` +
      `    app.layer(auth());\n` +
      `    app.route("/x", post(h));\n` +
      `}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path} auth=${r.hasAuth}`)).toEqual(["POST /x auth=false"]);
  });
});

describe("extractRustRoutesAst: Actix/Rocket attribute macros", () => {
  it('extracts #[post("/users")] on the following fn', async () => {
    const f = await rs("actix.rs", `#[post("/users")]\nasync fn create_user() -> HttpResponse { todo!() }\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /users"]);
  });

  it("ignores non-route attributes", async () => {
    const f = await rs("d.rs", `#[derive(Debug)]\n#[tokio::main]\nasync fn main() {}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("recognizes an Actix scoped attribute #[actix_web::post(\"/x\")]", async () => {
    const f = await rs("actix_scoped.rs", `#[actix_web::post("/x")]\nasync fn h() {}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it('reads the first string_literal as the path for a Rocket data arg', async () => {
    const f = await rs("rocket.rs", `#[post("/users", data = "<user>")]\nfn h(){}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /users"]);
  });

  it("skips intervening attribute_item and comment siblings to find the fn", async () => {
    const f = await rs("intervening.rs",
      `#[post("/x")]\n` +
      `// a comment\n` +
      `#[allow(dead_code)]\n` +
      `async fn h() -> &'static str { "" }\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it("emits nothing for a route macro with no following function_item", async () => {
    const f = await rs("nofn.rs", `#[post("/x")]\n#[derive(Debug)]\nstruct Foo {}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it.each([
    ["#[derive(Debug)]\nstruct Foo {}\n"],
    ["#[cfg(test)]\nmod tests {}\n"],
    ["#[doc(\"hidden\")]\nfn h(){}\n"],
    ["#[tokio::main]\nasync fn main() {}\n"],
    ["#[get]\nfn h(){}\n"],
  ])("recognizes no route for negative attribute %#", async (src) => {
    const f = await rs("neg.rs", src);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});

describe("extractRustRoutesAst: comments and strings never extracted (G8)", () => {
  it("does not extract a .route call written inside a line comment", async () => {
    const f = await rs("linecomment.rs",
      `fn f() {\n    // Router::new().route("/x", post(h));\n}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not extract a .route call written inside a block comment", async () => {
    const f = await rs("blockcomment.rs",
      `fn f() {\n    /* Router::new().route("/x", post(h)); */\n}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("does not extract .route text embedded in a string literal", async () => {
    const f = await rs("stringtext.rs",
      `fn f() {\n    let s = ".route(\\"/fake\\", post(h))";\n}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });
});
