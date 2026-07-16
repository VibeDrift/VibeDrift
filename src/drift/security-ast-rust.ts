/**
 * AST-based route extraction for Rust (Axum builder routes, Actix/Rocket
 * attribute-macro routes), used by security-consistency.ts in place of the
 * regex line-window extractor whenever a parsed tree is available and clean.
 * Mirrors the shipped JS/TS, Python, and Go designs in security-ast.ts,
 * security-ast-python.ts, and security-ast-go.ts. Rust has zero coverage
 * today; this is the first module for the language.
 *
 * TASK 1 SCOPE: route recognition only. `hasAuth` is unconditionally false
 * on every route this module emits — Task 3 fills the signal, Task 4 wires
 * this module into security-consistency.ts. Method/path resolution beyond
 * the single-verb-callee case (the `on(filter, h)` combinator, a chained
 * multi-verb `get(l).post(c)` link, Rocket's generic `#[route(GET, "/x")]`
 * macro) is Task 2; those shapes are recognized structurally as NOT a route
 * today (a recall gap, never a bless) rather than guessed.
 *
 * A find-replace port from a sibling module fails silently on five Rust
 * grammar traps (probe-verified against the pinned tree-sitter-wasms rust
 * grammar; see the G0 pin test in security-ast-rust.test.ts):
 *   1. An `attribute_item` (`#[post("/x")]`) is a PRECEDING SIBLING of the
 *      `function_item` it decorates, NEVER a child of it. Association walks
 *      forward from the attribute via `nextNamedSibling`, skipping
 *      `line_comment` / `block_comment` / intervening `attribute_item`
 *      siblings (stacked attributes, doc comments between them); a macro
 *      with no following `function_item` (end of file, or the next item is a
 *      `struct_item`/`mod_item`/anything else) attaches to nothing and is
 *      dropped.
 *   2. `attribute` has NO `path` field of its own (that name is reserved for
 *      a NESTED `scoped_identifier`'s own path/name pair, e.g.
 *      `actix_web::post`). The macro callee is `attribute.namedChild(0)`
 *      (an `identifier` for `post`, a `scoped_identifier` whose `name` field
 *      is `post` for `actix_web::post`). The route path is the FIRST
 *      `string_literal` (or `raw_string_literal`) found inside the
 *      `token_tree` at `attribute.childForFieldName("arguments")` — Rocket's
 *      `#[post("/users", data = "<user>")]` has a SECOND string literal
 *      (`"<user>"`) in the same token tree; only the first is the path.
 *   3. `string_literal` is a LEAF for path purposes: `.text.slice(1, -1)`
 *      strips the two quote characters. (A literal containing an escape
 *      sequence DOES carry `escape_sequence` named children — the leaf
 *      assumption is about `namedChildCount === 0` for a plain literal, not
 *      a universal claim — but `.text.slice(1, -1)` is correct either way
 *      since it operates on raw source text, never on children.)
 *      `raw_string_literal` is a leaf too, with a variable `r`/`r#`/`r##`
 *      prefix; `rustStringText` strips it by regex and returns null on a
 *      mismatch (a miss is safe, a guessed path is not). Raw-string route
 *      paths are rare and simply skipped rather than mis-parsed.
 *   4. Axum's builder has NO named receiver to key off of (unlike Gin's `r`
 *      or Flask's `app`): `Router::new().route("/x", post(h))`,
 *      `Router::<AppState>::new().route(...)`, and a route registered on a
 *      plain variable (`app.route("/x", post(h))`) all share nothing but the
 *      call SHAPE. Recognition is purely structural: a `call_expression`
 *      whose `function` is a `field_expression` with `field.text ===
 *      "route"`, exactly two named arguments, arg0 a leading-slash string,
 *      arg1 resolving to a recognized verb callee. Passthrough links
 *      (`.layer(...)`, `.with_state(...)`, `.fallback(...)`, `.merge(...)`,
 *      `.nest(...)`) simply fail the `field.text === "route"` check and are
 *      skipped without disturbing recognition of neighboring `.route(...)`
 *      links in the same chain — no receiver-name bookkeeping is needed at
 *      all, unlike the Go/Python modules.
 *   5. A fluent chain of N `.route(...)` links is ONE deeply left-nested
 *      `call_expression` tree, and `descendantsOfType` visits it PRE-ORDER
 *      (outer before inner): the OUTERMOST node is the LAST-WRITTEN link,
 *      and that node's `startPosition` is the start of the ENTIRE chain
 *      (`Router::new()`'s own line), not the line where that link's own
 *      `.route(` token sits. Naively pushing routes in traversal order and
 *      reading `call.startPosition.row` for the anchor line would both
 *      REVERSE route order and report the WRONG line for every link but the
 *      first. This module anchors each builder route on the `field_identifier`
 *      node (`fn.childForFieldName("field")`, the `route` token itself),
 *      whose position is that specific link's own, and re-sorts the
 *      collected builder matches by that position before emitting — the
 *      attribute-macro pass needs no such fix, since `attribute_item`
 *      siblings are flat, never nested inside each other.
 *
 * INVARIANT SCOPE: the never-false-bless guarantee (never mark an unauthed
 * route as authed) holds on THIS AST path; every route emitted here carries
 * `hasAuth: false` unconditionally (Task 1). There is no regex fallback for
 * Rust anywhere in this codebase, so a construct sitting inside a parse
 * error (`inErroredContext`) is simply skipped — a parse error can only
 * shrink the recognized route set for that construct, never emit a wrong
 * one, and never trigger a legacy regex over-bless the way the Go/Python
 * modules' fallback can.
 *
 * PINNED RECALL GAPS (measured, never a false-bless; each is a route this
 * module will not find rather than one it misclassifies):
 *   - Axum's `on(MethodFilter, handler)` combinator (`ON_CALLEES` is
 *     forward-declared for Task 2; its `MethodFilter` argument is not parsed
 *     yet, so an `on(...)` call is simply not recognized as a route).
 *   - A chained multi-verb link (`get(l).post(c)`) as `.route`'s arg1: the
 *     outer callee is a `field_expression`, not an `identifier` or
 *     `scoped_identifier`, and `resolveAxumMethod` does not unwrap it, so
 *     the whole `.route(...)` call is skipped rather than guessing one verb.
 *   - Rocket's generic `#[route(GET, "/x")]` macro: `"route"` is
 *     deliberately absent from `ATTR_ROUTE_METHODS` (its method lives inside
 *     the token tree, not in the macro name), so it is unrecognized rather
 *     than resolved as a bogus `"ROUTE"` method.
 *   - `.nest("/api", api_routes())`: emits zero routes itself and the
 *     `"/api"` prefix is NOT applied to routes registered inside
 *     `api_routes()` (a separate expression/function entirely) — a
 *     cross-expression path gap, not a bless.
 *   - A `.layer(...)` (or any middleware call) applied to a router VARIABLE
 *     in a separate STATEMENT from a later `.route(...)` call on that same
 *     variable is never associated with that route: recognition here is
 *     single-fluent-chain only. Scope inheritance is Task 4.
 *   - HEAD and OPTIONS are excluded from both `VERB_CALLEES` and
 *     `ATTR_ROUTE_METHODS` entirely (never recognized, mirroring the Go
 *     module's `VERB_FIELDS` convention): neither verb is ever emitted as a
 *     route by this module.
 */

import type { Tree, SyntaxNode } from "../core/types.js";
import type { RouteInfo } from "./security-consistency.js";

// Field name for Axum's fluent builder registration (`Router::new().route(...)`).
const ROUTE_FIELD = "route";

// Axum routing-fn verb callees (`get(h)`, `post(h)`, `axum::routing::put(h)`),
// keyed by the exact lowercase spelling Axum itself uses, mapped to the
// canonical uppercase HTTP verb. HEAD and OPTIONS are deliberately absent
// (mirrors Go's VERB_FIELDS convention): neither is ever emitted as a route.
const VERB_CALLEES = new Map([
  ["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"],
]);
// `any(handler)` registers a route for every method — the same "ALL"
// sentinel Express's `.all()` resolves to, so it participates in the
// mutating vote alongside a real mutating verb.
const ANY_CALLEES = new Set(["any"]);
// Axum's `on(MethodFilter, handler)` combinator: forward-declared for Task 2
// (its `MethodFilter` argument is not parsed by this task; see PINNED RECALL
// GAPS above), never consulted by `resolveAxumMethod` yet.
const ON_CALLEES = new Set(["on"]);
// Actix-web-codegen / Rocket per-verb attribute macro names (`#[get(...)]`,
// `#[post(...)]`, `#[actix_web::post(...)]`). HEAD and OPTIONS are
// deliberately absent for the same reason VERB_CALLEES excludes them.
// Rocket's generic `#[route(METHOD, "/x")]` is deliberately absent too (see
// PINNED RECALL GAPS above): its method lives inside the token tree, not in
// the macro name, and Task 1 does not read it out.
const ATTR_ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
// Verbs a RESOLVED route.method may carry once emitted: forward-declared for
// Task 2/3/4 use (Task 1's single-verb-callee resolution never needs to pick
// among multiple candidates), mirroring the Go/Python modules' own constant.
const MUTATING_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL"]);

export const SECURITY_AST_RUST = {
  VERB_CALLEES, ANY_CALLEES, ON_CALLEES, ATTR_ROUTE_METHODS, ROUTE_FIELD, MUTATING_VERBS,
};

/** Path/verb text of a Rust string literal. string_literal is a LEAF in the pinned
 *  grammar (slice off the two quote chars). raw_string_literal has an r + variable-#
 *  prefix, so strip r#*"…"#* by regex; a mismatch → null (skip, a miss is safe). Anything
 *  else (const, macro_invocation, binary_expression) → null: statically unresolvable, the
 *  route is skipped (a guessed path is never safe). */
function rustStringText(node: SyntaxNode): string | null {
  if (node.type === "string_literal") return node.text.slice(1, -1);
  if (node.type === "raw_string_literal") {
    const m = node.text.match(/^r(#*)"([\s\S]*)"\1$/);
    return m ? m[2] : null;
  }
  return null;
}

/** Non-null named children. */
function rustNamed(n: SyntaxNode | null | undefined): SyntaxNode[] {
  return n ? n.namedChildren.filter((c): c is SyntaxNode => c !== null) : [];
}

/** True when node or any ancestor BELOW source_file carries a parse error (per-construct
 *  surgical skip; there is no whole-file fallback for Rust — see the module header).
 *  Mirror inErroredContext, security-ast-go.ts: Rust error recovery can swallow a later
 *  valid registration into a broken call's arguments. */
function inErroredContext(node: SyntaxNode): boolean {
  let cur: SyntaxNode | null = node;
  while (cur && cur.type !== "source_file") {
    if (cur.hasError) return true;
    cur = cur.parent;
  }
  return false;
}

interface RustRoute { method: string; path: string; anchor: SyntaxNode; handler: string | null; }

/** Method for a builder route's arg1: a verb-callee call recognized via
 *  VERB_CALLEES (a plain `post(h)` identifier callee, or a scoped
 *  `axum::routing::post(h)` whose `name` field is the verb) or ANY_CALLEES
 *  (`any(h)`, resolves the "ALL" sentinel). Anything else — a bare
 *  identifier (`handler_service`, not even a call), the `on(filter, h)`
 *  combinator, a chained `get(l).post(c)` multi-verb callee (a
 *  `field_expression`, not an identifier/scoped_identifier) — returns null,
 *  so the caller skips the route entirely. A recall gap here can only drop a
 *  route, never bless one. */
function resolveAxumMethod(arg1: SyntaxNode): string | null {
  if (arg1.type !== "call_expression") return null;
  const fn = arg1.childForFieldName("function");
  let name: string | null = null;
  if (fn?.type === "identifier") name = fn.text;
  else if (fn?.type === "scoped_identifier") name = fn.childForFieldName("name")?.text ?? null;
  if (name === null) return null;
  if (VERB_CALLEES.has(name)) return VERB_CALLEES.get(name)!;
  if (ANY_CALLEES.has(name)) return "ALL";
  return null;
}

/** Handler name = arg1's own call's first identifier argument
 *  (`post(create_order)` -> "create_order"). RouteInfo has no handler slot;
 *  this is carried on RustRoute for Task 3's benefit only, unused downstream
 *  in Task 1. */
function axumHandlerName(arg1: SyntaxNode): string | null {
  if (arg1.type !== "call_expression") return null;
  const inner = arg1.childForFieldName("arguments")?.namedChild(0) ?? null;
  return inner?.type === "identifier" ? inner.text : null;
}

/** Recognize a builder .route(path, VERB(h)) anchor. Structural gate (Axum is fluent, no
 *  named receiver): function is field_expression, field == "route", 2 named args, arg0 a
 *  leading-slash string, arg1 resolving to a verb callee. Returns null otherwise (a
 *  spurious match can only add a deviation-side route, never a bless). Anchored on the
 *  field_identifier node, NOT the call itself — a fluent chain's outer call_expression
 *  spans back to the chain's start line (see module header, grammar trap 5); the field
 *  node is the one place this specific link's own source position lives. */
function asBuilderRoute(call: SyntaxNode): RustRoute | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "field_expression") return null;
  const field = fn.childForFieldName("field");
  if (field?.text !== ROUTE_FIELD) return null;
  const named = rustNamed(call.childForFieldName("arguments"));
  if (named.length !== 2) return null;
  const path = rustStringText(named[0]);
  if (path === null || !path.startsWith("/")) return null; // leading-slash gate
  const method = resolveAxumMethod(named[1]);
  if (method === null) return null; // not a recognized verb callee
  return { method, path, anchor: field, handler: axumHandlerName(named[1]) };
}

/** Task 1 stub: reads only the macro name (`"route"` is never a member of
 *  ATTR_ROUTE_METHODS, so this never sees Rocket's generic macro — see
 *  PINNED RECALL GAPS). `tokenTree` is accepted for Task 2's benefit (which
 *  will need to read a VERB out of it for the generic macro) but unused
 *  today. */
function attrMacroMethod(macro: string, _tokenTree: SyntaxNode | null): string {
  return macro.toUpperCase();
}

/** Attribute-macro route on the function_item that FOLLOWS the attribute_item sibling. */
function asAttributeRoute(attrItem: SyntaxNode): RustRoute | null {
  const attr = rustNamed(attrItem).find((n) => n.type === "attribute");
  if (!attr) return null;
  const callee = attr.namedChild(0);
  const macro = callee?.type === "identifier" ? callee.text
    : callee?.type === "scoped_identifier" ? (callee.childForFieldName("name")?.text ?? "") : "";
  if (!ATTR_ROUTE_METHODS.has(macro)) return null;
  const tokenTree = attr.childForFieldName("arguments") ?? null;
  const pathNode = tokenTree
    ? rustNamed(tokenTree).find((n) => n.type === "string_literal" || n.type === "raw_string_literal")
    : null;
  const path = pathNode ? rustStringText(pathNode) : null;
  if (path === null || !path.startsWith("/")) return null;
  // The route attaches to the nearest following function_item sibling, skipping comments
  // and other attributes.
  let sib: SyntaxNode | null = attrItem.nextNamedSibling;
  while (sib && (sib.type === "line_comment" || sib.type === "block_comment" || sib.type === "attribute_item")) {
    sib = sib.nextNamedSibling;
  }
  if (sib?.type !== "function_item") return null;
  const method = attrMacroMethod(macro, tokenTree);
  return { method, path, anchor: attrItem, handler: sib.childForFieldName("name")?.text ?? null };
}

/** File-wide map of top-level and impl-method function definitions by name
 *  (both share the `function_item` node type in Rust's flat grammar); a name
 *  seen more than once maps to null (duplicate: follow NEITHER). Forward-
 *  declared for Task 3's body-first auth resolution, unused by Task 1's own
 *  extraction. Mirrors collectGoFunctionDefs. */
export function collectRustFunctionDefs(root: SyntaxNode): Map<string, SyntaxNode | null> {
  const defs = new Map<string, SyntaxNode | null>();
  for (const def of root.descendantsOfType("function_item")) {
    if (!def || def.hasError) continue;
    const name = def.childForFieldName("name")?.text;
    if (!name) continue;
    defs.set(name, defs.has(name) ? null : def);
  }
  return defs;
}

export function extractRustRoutesAst(tree: Tree, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const root = tree.rootNode;

  // Attribute-macro routes (Actix/Rocket). attribute_item siblings are flat
  // (never nested inside each other), so traversal order already matches
  // source order.
  for (const attrItem of root.descendantsOfType("attribute_item")) {
    if (!attrItem || inErroredContext(attrItem)) continue;
    const r = asAttributeRoute(attrItem);
    if (r) routes.push(emitRoute(r, filePath));
  }

  // Builder .route routes (Axum). Filtering to field=="route" yields exactly
  // one anchor per route (the method-wrapper post(h)/get(h) calls have
  // identifier functions, never a field_expression, so they are naturally
  // skipped here — no double-visit). A fluent chain's pre-order traversal
  // visits the LAST-WRITTEN link first (grammar trap 5); sort the collected
  // matches by their own field-node position to restore source order before
  // emitting.
  const builderMatches: RustRoute[] = [];
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call || inErroredContext(call)) continue;
    const r = asBuilderRoute(call);
    if (r) builderMatches.push(r);
  }
  builderMatches.sort((a, b) =>
    a.anchor.startPosition.row - b.anchor.startPosition.row
    || a.anchor.startPosition.column - b.anchor.startPosition.column);
  for (const r of builderMatches) routes.push(emitRoute(r, filePath));

  return routes;
}

function emitRoute(r: RustRoute, filePath: string): RouteInfo {
  return {
    method: r.method,
    path: r.path,
    file: filePath,
    line: r.anchor.startPosition.row + 1, // anchor = the "route" field token (builder) or attribute_item (macro)
    hasAuth: false,        // Task 3 fills the signal
    hasValidation: false,  // deferred non-goal
    hasRateLimit: false,   // deferred non-goal
    hasErrorHandler: false, // write-only field; every AST path hard-codes false
  };
}
