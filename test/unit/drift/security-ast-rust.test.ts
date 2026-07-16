import { describe, it, expect } from "vitest";
import {
  extractRustRoutesAst,
  classifyRustAuth,
  collectRustFunctionDefs,
} from "../../../src/drift/security-ast-rust.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { SyntaxNode } from "../../../src/core/types.js";

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

describe("extractRustRoutesAst: method resolution (G3)", () => {
  const axum = (arg1: string) =>
    `fn app() -> Router {\n    Router::new().route("/x", ${arg1})\n}\n`;
  const method = async (name: string, arg1: string): Promise<string[]> => {
    const f = await rs(name, axum(arg1));
    return extractRustRoutesAst(f.tree!, f.relativePath).map((r) => r.method);
  };

  it("resolves each single method-router verb callee to its HTTP verb", async () => {
    expect(await method("mpost.rs", "post(h)")).toEqual(["POST"]);
    expect(await method("mput.rs", "put(h)")).toEqual(["PUT"]);
    expect(await method("mpatch.rs", "patch(h)")).toEqual(["PATCH"]);
    expect(await method("mdelete.rs", "delete(h)")).toEqual(["DELETE"]);
    expect(await method("mget.rs", "get(h)")).toEqual(["GET"]);
  });

  it("resolves any(h) to the ALL sentinel (stays in the mutating vote)", async () => {
    expect(await method("many.rs", "any(h)")).toEqual(["ALL"]);
  });

  it("resolves a scoped verb callee axum::routing::post(h) to POST", async () => {
    expect(await method("mscoped.rs", "axum::routing::post(h)")).toEqual(["POST"]);
  });

  it("collects both verbs of a chain and resolves the first mutating one", async () => {
    // get(list).post(create): GET + POST present -> POST wins the mutating vote.
    expect(await method("mchain1.rs", "get(list).post(create)")).toEqual(["POST"]);
    // get(a).put(b): the sole mutating verb PUT wins.
    expect(await method("mchain2.rs", "get(a).put(b)")).toEqual(["PUT"]);
  });

  it("resolves an unresolvable but verb-shaped on() combinator to ALL, never a GET-drop", async () => {
    // v1 DEFERRED: the precise MethodFilter verb is not parsed; the route stays
    // in the mutating vote as ALL rather than silently dropping to GET.
    expect(await method("mon.rs", "on(MethodFilter::POST, h)")).toEqual(["ALL"]);
  });

  it("skips a HEAD-only method-router (never mutating)", async () => {
    const f = await rs("mhead.rs", axum("head(h)"));
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips a chain whose only verbs are head/options", async () => {
    const f = await rs("mheadopt.rs", axum("head(h).options(o)"));
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips a bare MethodRouter-variable arg1 (not a method-router shape)", async () => {
    // route("/x", mr) is structurally indistinguishable from a non-Axum
    // .route(path, someVar) call; recognizing it would over-capture. Documented
    // recall gap: a let-bound `let mr = post(h)` route is not resolved here.
    const f = await rs("mbarevar.rs", axum("mr"));
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips an unrecognized non-verb callee my_router()", async () => {
    const f = await rs("munrec.rs", axum("my_router()"));
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips a plain method call receiver.post(h) whose base is not a router callee", async () => {
    // Guards the chain walk: an outer field verb alone must not synthesize a
    // spurious mutating route; only a recognized base call asserts the shape.
    const f = await rs("mfieldbase.rs", axum("receiver.post(h)"));
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("resolves attribute-macro verbs from the macro name", async () => {
    const g = await rs("aget.rs", `#[get("/g")]\nfn h(){}\n`);
    expect(extractRustRoutesAst(g.tree!, g.relativePath).map((r) => r.method)).toEqual(["GET"]);
    const p = await rs("apost.rs", `#[post("/p")]\nfn h(){}\n`);
    expect(extractRustRoutesAst(p.tree!, p.relativePath).map((r) => r.method)).toEqual(["POST"]);
    const d = await rs("adelete.rs", `#[delete("/d")]\nfn h(){}\n`);
    expect(extractRustRoutesAst(d.tree!, d.relativePath).map((r) => r.method)).toEqual(["DELETE"]);
  });

  it('resolves a generic #[route("/x", method = "POST")] macro to POST', async () => {
    const f = await rs("aroute.rs", `#[route("/x", method = "POST")]\nfn h(){}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["POST /x"]);
  });

  it('resolves a generic #[route("/x")] with no method= to ALL', async () => {
    const f = await rs("aroutenone.rs", `#[route("/x")]\nfn h(){}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath)
      .map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /x"]);
  });

  it('resolves a fully-literal unrecognized verb in #[route] to GET', async () => {
    // A statically-known-but-unrecognized verb resolves GET (DRF/Go precedent),
    // distinct from an UNRESOLVABLE dynamic verb which resolves ALL.
    const f = await rs("aroutetrace.rs", `#[route("/x", method = "TRACE")]\nfn h(){}\n`);
    expect(extractRustRoutesAst(f.tree!, f.relativePath).map((r) => r.method)).toEqual(["GET"]);
  });
});

describe("extractRustRoutesAst: path forms and string handling (G4)", () => {
  const axum = (path: string, arg1 = "post(h)") =>
    `fn app() -> Router {\n    Router::new().route(${path}, ${arg1})\n}\n`;
  const paths = async (name: string, path: string): Promise<string[]> => {
    const f = await rs(name, axum(path));
    return extractRustRoutesAst(f.tree!, f.relativePath).map((r) => r.path);
  };

  it("requires a leading slash (skips a slash-less or empty path)", async () => {
    const noslash = await rs("pnoslash.rs", axum(`"users"`));
    expect(extractRustRoutesAst(noslash.tree!, noslash.relativePath)).toEqual([]);
    const empty = await rs("pempty.rs", axum(`""`));
    expect(extractRustRoutesAst(empty.tree!, empty.relativePath)).toEqual([]);
  });

  it("accepts axum :id and brace {id} path params verbatim", async () => {
    expect(await paths("pcolon.rs", `"/users/:id"`)).toEqual(["/users/:id"]);
    expect(await paths("pbrace.rs", `"/users/{id}"`)).toEqual(["/users/{id}"]);
  });

  it("accepts the root path /", async () => {
    expect(await paths("proot.rs", `"/"`)).toEqual(["/"]);
  });

  it("accepts a unicode path verbatim", async () => {
    expect(await paths("punicode.rs", `"/café"`)).toEqual(["/café"]);
  });

  it("reads a raw-string-literal path, stripping the r-prefix and hashes", async () => {
    expect(await paths("praw.rs", `r"/raw"`)).toEqual(["/raw"]);
    expect(await paths("prawhash.rs", `r#"/hash"#`)).toEqual(["/hash"]);
  });

  it("skips a mis-form raw path that fails the strip regex (deliberate safe miss)", async () => {
    // A byte-raw string br"/x" is a raw_string_literal whose text starts with
    // `b`, not `r`; the strip regex returns null -> path unresolved -> skip.
    const f = await rs("prawbyte.rs", axum(`br"/x"`));
    expect(extractRustRoutesAst(f.tree!, f.relativePath)).toEqual([]);
  });

  it("skips a non-literal path (const, format!, or binary concat)", async () => {
    const konst = await rs("pconst.rs", axum(`PATH`));
    expect(extractRustRoutesAst(konst.tree!, konst.relativePath)).toEqual([]);
    const fmt = await rs("pfmt.rs", axum(`&format!("/x/{}", id)`));
    expect(extractRustRoutesAst(fmt.tree!, fmt.relativePath)).toEqual([]);
    const concat = await rs("pconcat.rs", axum(`"/x" + "/y"`));
    expect(extractRustRoutesAst(concat.tree!, concat.relativePath)).toEqual([]);
  });
});

// ─── Task 3: body-first auth classification ──────────────────────────────────
// GOVERNING INVARIANT: NEVER-FALSE-BLESS. A route blesses ONLY when a covering
// (ANCESTOR) .layer/.route_layer wraps a from_fn whose in-file body verifiably
// rejects. No type-name bless; no name-only bless. Every extractor type and
// every unreadable/opaque layer resolves UNSURE (authUnsureHook), never bless.

// Fold a middleware fn + a router chain into one source file.
const withMw = (mw: string, chain: string) =>
  `${mw}\nfn app() -> Router {\n    ${chain}\n}\n`;
// A rejecting from_fn body under a given name (401-family return).
const rejBody = (name: string) =>
  `async fn ${name}(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
  `    let t = req.headers().get("Authorization");\n` +
  `    if t.is_none() { return Err(StatusCode::UNAUTHORIZED); }\n` +
  `    Ok(next.run(req).await)\n}\n`;
const authOf = (rts: ReturnType<typeof extractRustRoutesAst>) =>
  rts.map((r) => `${r.method} ${r.path} auth=${r.hasAuth} hook=${r.authUnsureHook ?? "-"}`);

describe("auth POSITIVE: covering from_fn body reject blesses", () => {
  it("a covering from_fn whose body 401s blesses even a boring 'auth' name (rule 2)", async () => {
    const f = await rs("p1.rs",
      withMw(rejBody("auth"), `Router::new().route("/x", post(h)).layer(middleware::from_fn(auth))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("a body-only reject blesses under a boring name with no auth lexicon (mirror Go S7)", async () => {
    const gate =
      `async fn gate(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
      `    if req.uri().path().is_empty() { return Err(StatusCode::UNAUTHORIZED); }\n` +
      `    Ok(next.run(req).await)\n}\n`;
    const f = await rs("p2.rs",
      withMw(gate, `Router::new().route("/x", post(h)).layer(middleware::from_fn(gate))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("reject via (StatusCode::UNAUTHORIZED, msg).into_response() in an if guard blesses", async () => {
    const mw =
      `async fn mw(req: Request, next: Next) -> Response {\n` +
      `    if req.headers().get("Authorization").is_none() {\n` +
      `        return (StatusCode::UNAUTHORIZED, "no").into_response();\n` +
      `    }\n    next.run(req).await\n}\n`;
    const f = await rs("p3.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("reject via .ok_or(StatusCode::UNAUTHORIZED)? blesses", async () => {
    const mw =
      `async fn mw(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
      `    let _t = req.headers().get("Authorization").ok_or(StatusCode::UNAUTHORIZED)?;\n` +
      `    Ok(next.run(req).await)\n}\n`;
    const f = await rs("p4.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("reject via .ok_or_else(|| StatusCode::UNAUTHORIZED) reads the closure body and blesses", async () => {
    const mw =
      `async fn mw(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
      `    let _t = req.headers().get("x").ok_or_else(|| StatusCode::UNAUTHORIZED)?;\n` +
      `    Ok(next.run(req).await)\n}\n`;
    const f = await rs("p5.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("return Err((StatusCode::UNAUTHORIZED, body).into_response()) tuple form blesses", async () => {
    const mw =
      `async fn mw(req: Request, next: Next) -> Result<Response, Response> {\n` +
      `    if bad(&req) { return Err((StatusCode::UNAUTHORIZED, "b").into_response()); }\n` +
      `    Ok(next.run(req).await)\n}\n`;
    const f = await rs("p6.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("a bare tail StatusCode::UNAUTHORIZED (last block expr) blesses", async () => {
    const mw = `async fn mw(req: Request, next: Next) -> StatusCode {\n    StatusCode::UNAUTHORIZED\n}\n`;
    const f = await rs("p7.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("from_fn_with_state(state, auth) resolves the LAST arg to its body and blesses", async () => {
    const f = await rs("p8.rs",
      withMw(rejBody("auth"),
        `Router::new().route("/x", post(h)).layer(middleware::from_fn_with_state(app_state, auth))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("a guarded 403 that structurally reads a credential surface blesses (reject403Guarded)", async () => {
    const mw =
      `async fn mw(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
      `    let t = req.headers().get("Authorization");\n` +
      `    if t.is_none() { return Err(StatusCode::FORBIDDEN); }\n` +
      `    Ok(next.run(req).await)\n}\n`;
    const f = await rs("p9.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=true hook=-"]);
  });

  it("one covering .layer blesses EVERY route that is a DESCENDANT of it (whole-chain scope)", async () => {
    const chain =
      `Router::new()\n` +
      `        .route("/a", post(x))\n` +
      `        .route("/b", put(y))\n` +
      `        .route("/c", delete(z))\n` +
      `        .layer(middleware::from_fn(auth))`;
    const f = await rs("p10.rs", withMw(rejBody("auth"), chain));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual([
      "POST /a auth=true hook=-", "PUT /b auth=true hook=-", "DELETE /c auth=true hook=-",
    ]);
  });
});

describe("auth NEGATIVE: never-false-bless", () => {
  it("a from_fn body that only logs and calls next.run never blesses (rule 3, name flavored)", async () => {
    // Auth-flavored name, but a visible non-enforcing body -> not-auth. Name never rescues.
    const mw =
      `async fn auth_check(req: Request, next: Next) -> Response {\n` +
      `    tracing::info!("saw a request");\n    next.run(req).await\n}\n`;
    const f = await rs("n1.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(auth_check))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
  });

  it("a from_fn body returning 404 or 500 is NOT a bless", async () => {
    for (const [nm, status] of [["nf.rs", "NOT_FOUND"], ["se.rs", "INTERNAL_SERVER_ERROR"]]) {
      const mw =
        `async fn mw(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
        `    if bad(&req) { return Err(StatusCode::${status}); }\n` +
        `    Ok(next.run(req).await)\n}\n`;
      const f = await rs(nm, withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
      expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
    }
  });

  it("a bare 403 with NO credential-reading guard is NOT a bless (403 asymmetry)", async () => {
    const mw =
      `async fn mw(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
      `    if maintenance_mode() { return Err(StatusCode::FORBIDDEN); }\n` +
      `    Ok(next.run(req).await)\n}\n`;
    const f = await rs("n3.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
  });

  it("a bare integer status (Err(401) / from_u16(401)) is NOT a bless in v1", async () => {
    for (const [nm, expr] of [
      ["bi1.rs", "return Err(401);"],
      ["bi2.rs", "return Err(StatusCode::from_u16(401).unwrap());"],
    ]) {
      const mw =
        `async fn mw(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
        `    if bad(&req) { ${expr} }\n    Ok(next.run(req).await)\n}\n`;
      const f = await rs(nm, withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
      expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
    }
  });

  it("a 401 that is only a let-binding reference (never returned) is NOT a bless", async () => {
    // The invariant requires a verifiable rejection, not a mention. A bare
    // `let code = StatusCode::UNAUTHORIZED;` binding that is never returned/produced
    // must not bless the middleware.
    const mw =
      `async fn mw(req: Request, next: Next) -> Response {\n` +
      `    let _code = StatusCode::UNAUTHORIZED;\n    next.run(req).await\n}\n`;
    const f = await rs("n4b.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
  });

  it("a reject inside a NESTED, non-inline closure is pruned and never counted", async () => {
    const mw =
      `async fn mw(req: Request, next: Next) -> Response {\n` +
      `    let _f = || -> Result<(), StatusCode> { return Err(StatusCode::UNAUTHORIZED); };\n` +
      `    next.run(req).await\n}\n`;
    const f = await rs("n5.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(mw))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
  });

  // PASS-THROUGH middlewares that merely MENTION a downstream 401 in a NON-produce
  // position (a comparison operand, a header-insert argument, a match-arm pattern)
  // and then return the response unchanged. None rejects; none may bless. Neutral
  // names (tap / add_header / observe) so no name veto is in play — the body
  // signature alone must resolve not-auth. Reproduces the produce-position bug.
  it("MENTION-not-reject: a 401 in an `== StatusCode::UNAUTHORIZED` comparison never blesses", async () => {
    const mw =
      `async fn tap(req: Request, next: Next) -> Response {\n` +
      `    let resp = next.run(req).await;\n` +
      `    if resp.status() == StatusCode::UNAUTHORIZED {\n` +
      `        tracing::warn!("downstream returned 401");\n` +
      `    }\n    resp\n}\n`;
    const f = await rs("n9.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(tap))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
  });

  it("MENTION-not-reject: a 401-gated header INSERT (WWW-Authenticate) never blesses", async () => {
    const mw =
      `async fn add_header(req: Request, next: Next) -> Response {\n` +
      `    let mut resp = next.run(req).await;\n` +
      `    if resp.status() == StatusCode::UNAUTHORIZED {\n` +
      `        resp.headers_mut().insert("WWW-Authenticate", HeaderValue::from_static("Bearer"));\n` +
      `    }\n    resp\n}\n`;
    const f = await rs("n10.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(add_header))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
  });

  it("MENTION-not-reject: a 401 as a `match` arm PATTERN (metric observe) never blesses", async () => {
    const mw =
      `async fn observe(req: Request, next: Next) -> Response {\n` +
      `    let resp = next.run(req).await;\n` +
      `    match resp.status() {\n` +
      `        StatusCode::UNAUTHORIZED => metrics::incr("downstream_401"),\n` +
      `        _ => {}\n    }\n    resp\n}\n`;
    const f = await rs("n11.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(observe))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
  });

  it("a non-from_fn layer (TraceLayer / Logger) is not auth", async () => {
    const trace = await rs("n6a.rs",
      `fn app() -> Router {\n    Router::new().route("/x", get(h)).layer(TraceLayer::new_for_http())\n}\n`);
    expect(authOf(extractRustRoutesAst(trace.tree!, trace.relativePath))).toEqual(["GET /x auth=false hook=-"]);
    const logger = await rs("n6b.rs",
      `fn app() -> Router {\n    Router::new().route("/x", get(h)).wrap(Logger::default())\n}\n`);
    expect(authOf(extractRustRoutesAst(logger.tree!, logger.relativePath))).toEqual(["GET /x auth=false hook=-"]);
  });

  it("LAYER SCOPING crux: .layer(auth).route(A) puts A OUTSIDE the layer subtree -> A false", async () => {
    const chain = `Router::new().layer(middleware::from_fn(auth)).route("/late", post(h))`;
    const f = await rs("n7.rs", withMw(rejBody("auth"), chain));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /late auth=false hook=-"]);
  });

  it(".route_layer covers the preceding route link but NOT a route added after it", async () => {
    const chain =
      `Router::new()\n` +
      `        .route("/early", post(a))\n` +
      `        .route_layer(middleware::from_fn(auth))\n` +
      `        .route("/late", post(b))`;
    const f = await rs("n8.rs", withMw(rejBody("auth"), chain));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual([
      "POST /early auth=true hook=-", "POST /late auth=false hook=-",
    ]);
  });
});

describe("auth UNSURE: unreadable layer / imported / opaque", () => {
  it("an imported from_fn with no in-file def resolves UNSURE, naming the hook", async () => {
    const f = await rs("u1.rs",
      `fn app() -> Router {\n    Router::new().route("/x", post(h)).layer(middleware::from_fn(require_auth))\n}\n`);
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual([
      "POST /x auth=false hook=require_auth",
    ]);
  });

  it("an in-file from_fn body that only calls an external validator (no reject) is UNSURE", async () => {
    const mw =
      `async fn require_auth(req: Request, next: Next) -> Response {\n` +
      `    let _ = validate_session(&req);\n    next.run(req).await\n}\n`;
    const f = await rs("u2.rs",
      withMw(mw, `Router::new().route("/x", post(h)).layer(middleware::from_fn(require_auth))`));
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual([
      "POST /x auth=false hook=require_auth",
    ]);
  });

  it("a .wrap of a library closure / bare mw resolves UNSURE or not-auth (never bless)", async () => {
    const bearer = await rs("u3a.rs",
      `fn app() -> Router {\n    Router::new().route("/x", get(h)).wrap(HttpAuthentication::bearer(v))\n}\n`);
    const br = extractRustRoutesAst(bearer.tree!, bearer.relativePath);
    expect(br[0].hasAuth).toBe(false);
    const mw = await rs("u3b.rs",
      `fn app() -> Router {\n    Router::new().route("/x", get(h)).wrap(auth_mw)\n}\n`);
    const mr = extractRustRoutesAst(mw.tree!, mw.relativePath);
    expect(mr[0].hasAuth).toBe(false);
  });

  it("direct classifier pins: a NAME alone never returns 'auth'", async () => {
    const empty = new Map<string, SyntaxNode | null>();
    expect(classifyRustAuth("require_auth", null, empty)).toBe("unsure");
    expect(classifyRustAuth("logger", null, empty)).toBe("not-auth");

    // A veto segment beats even a real body reject (rule 1).
    const f = await rs("pin.rs", rejBody("skip_auth"));
    const defs = collectRustFunctionDefs(f.tree!.rootNode);
    const body = f.tree!.rootNode.descendantsOfType("function_item")[0]!.childForFieldName("body")!;
    expect(classifyRustAuth("skip_auth", body, defs)).toBe("not-auth");
  });
});

describe("auth extractor-typed → UNSURE (LOCKED no-type-bless)", () => {
  const handlerRoute = (params: string) =>
    `async fn h(${params}) -> Response { todo!() }\n` +
    `fn app() -> Router {\n    Router::new().route("/x", post(h))\n}\n`;

  it("an auth-extractor-typed param resolves UNSURE naming the type (never a type-name bless)", async () => {
    for (const ty of ["AuthUser", "Claims", "RequireAuth", "Identity", "Bearer"]) {
      const f = await rs(`e_${ty}.rs`, handlerRoute(`user: ${ty}`));
      expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual([
        `POST /x auth=false hook=${ty}`,
      ]);
    }
  });

  it("an Option/Maybe/Optional wrapper NEVER even hedges (optionality veto, hook absent)", async () => {
    for (const [nm, params] of [
      ["o1.rs", "user: Option<AuthUser>"],
      ["o2.rs", "user: MaybeAuth"],
      ["o3.rs", "user: OptionalUser"],
    ]) {
      const f = await rs(nm, handlerRoute(params));
      expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
    }
  });

  it("a non-auth extractor type contributes nothing (hook absent)", async () => {
    for (const [nm, params] of [
      ["j.rs", "body: Json<Order>"],
      ["p.rs", "id: Path<u32>"],
      ["s.rs", "state: State<AppState>"],
      ["q.rs", "q: Query<Params>"],
      ["fm.rs", "form: Form<Data>"],
    ]) {
      const f = await rs(nm, handlerRoute(params));
      expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual(["POST /x auth=false hook=-"]);
    }
  });

  it("v1 boundary pin: an in-file impl FromRequest for AuthUser is NOT read (still UNSURE)", async () => {
    const src =
      `struct AuthUser;\n` +
      `impl FromRequest for AuthUser {\n` +
      `    type Rejection = StatusCode;\n` +
      `    async fn from_request(req: Request, s: &S) -> Result<Self, StatusCode> {\n` +
      `        return Err(StatusCode::UNAUTHORIZED);\n` +
      `    }\n}\n` +
      `async fn h(user: AuthUser) -> Response { todo!() }\n` +
      `fn app() -> Router {\n    Router::new().route("/x", post(h))\n}\n`;
    const f = await rs("v1boundary.rs", src);
    // The rejecting FromRequest body is deliberately ignored in v1; the type name
    // hedges but never blesses (the biggest documented recall cost).
    expect(authOf(extractRustRoutesAst(f.tree!, f.relativePath))).toEqual([
      "POST /x auth=false hook=AuthUser",
    ]);
  });
});
