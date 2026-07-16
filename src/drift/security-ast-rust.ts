/**
 * AST-based route extraction for Rust (Axum builder routes, Actix/Rocket
 * attribute-macro routes), used by security-consistency.ts in place of the
 * regex line-window extractor whenever a parsed tree is available and clean.
 * Mirrors the shipped JS/TS, Python, and Go designs in security-ast.ts,
 * security-ast-python.ts, and security-ast-go.ts. Rust has zero coverage
 * today; this is the first module for the language.
 *
 * SCOPE (Task 1 + Task 2): route recognition and method/path resolution.
 * `hasAuth` is unconditionally false on every route this module emits — Task 3
 * fills the signal, Task 4 wires this module into security-consistency.ts.
 * Task 2 resolves the full method surface: the `on(MethodFilter, h)`
 * combinator and a chained multi-verb `get(l).post(c)` link (both verb-SHAPED
 * but unresolvable/multi -> "ALL" or the first mutating verb, never a silent
 * GET-drop) and Actix's generic `#[route("/x", method = "VERB")]` macro
 * (verbs read from the token tree). An arg1 with NO verb shape at all (a bare
 * identifier, an unrecognized callee) is still a deliberate SKIP.
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
 * module will not find, or a method it over-approximates to "ALL", rather
 * than one it misclassifies into or out of the mutating vote wrongly):
 *   - Axum's `on(MethodFilter, handler)` precise verb is v1-DEFERRED: an
 *     `on(...)` call IS recognized as a route, but its `MethodFilter` argument
 *     is not parsed, so it resolves to "ALL" (stays in the mutating vote) —
 *     an over-approximation, never a GET-drop.
 *   - A method-router built as a separate `let mr = post(h); app.route("/x", mr)`
 *     binding is NOT recognized: a bare-identifier arg1 is structurally
 *     indistinguishable from a non-Axum `.route(path, someVar)` call (a config
 *     or HTTP-client builder), so it is skipped rather than resolved via local
 *     let-binding dataflow (deferred). A recall gap, never an over-capture.
 *   - Rocket's generic `#[route(GET, "/x")]` form (verb as a bare POSITIONAL
 *     token, not `method = "GET"`) is not read: only the Actix
 *     `#[route("/x", method = "VERB")]` string form resolves its verb; a
 *     positional-verb route macro falls through to "ALL" (any method).
 *   - `.nest("/api", api_routes())`: emits zero routes itself and the
 *     `"/api"` prefix is NOT applied to routes registered inside
 *     `api_routes()` (a separate expression/function entirely) — a
 *     cross-expression path gap, not a bless.
 *   - A `.layer(...)` (or any middleware call) applied to a router VARIABLE
 *     in a separate STATEMENT from a later `.route(...)` call on that same
 *     variable is never associated with that route: recognition here is
 *     single-fluent-chain only. Scope inheritance is Task 4.
 *   - HEAD and OPTIONS are excluded from `VERB_CALLEES` and
 *     `ATTR_ROUTE_METHODS` (they live in `EXCLUDED_VERB_CALLEES` only so a
 *     head/options-only method router is recognized-then-skipped): neither
 *     verb is ever emitted as a route by this module.
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
// Method-router verb callees that are NEVER mutating and never emitted as a
// route: `head(h)` / `options(o)`. Kept separate from VERB_CALLEES (which the
// module header documents as HEAD/OPTIONS-free) so a head/options callee is
// still RECOGNIZED as a method-router shape — a head/options-only router is a
// deliberate SKIP, not an unresolvable "ALL". Mapped to a canonical verb only
// so the exclusion filter in `resolveAxumMethod` can drop them.
const EXCLUDED_VERB_CALLEES = new Map([["head", "HEAD"], ["options", "OPTIONS"]]);
// `any(handler)` registers a route for every method — the same "ALL"
// sentinel Express's `.all()` resolves to, so it participates in the
// mutating vote alongside a real mutating verb.
const ANY_CALLEES = new Set(["any"]);
// Axum's `on(MethodFilter, handler)` combinator. Its precise `MethodFilter`
// verb is v1-DEFERRED (not parsed): an `on(...)` call is verb-SHAPED but its
// verb is unresolvable, so it resolves to the "ALL" sentinel and stays in the
// mutating vote (never a silent GET-drop). See PINNED RECALL GAPS.
const ON_CALLEES = new Set(["on"]);
// Actix-web-codegen / Rocket per-verb attribute macro names (`#[get(...)]`,
// `#[post(...)]`, `#[actix_web::post(...)]`). HEAD and OPTIONS are
// deliberately absent for the same reason VERB_CALLEES excludes them.
// Actix's generic `#[route("/x", method = "VERB")]` is handled separately
// (`ROUTE_MACRO`): its method lives inside the token tree, not the macro name.
const ATTR_ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
// The generic multi-method attribute macro (`#[route("/x", method = "POST")]`).
// Its verb(s) live in the token tree as `method = "VERB"` pairs, read by
// `attrMacroMethod`; no `method=` -> "ALL" (any method).
const ROUTE_MACRO = "route";
// The five HTTP verbs this module resolves by name (mutating set plus GET).
// A statically-literal-but-unrecognized verb (e.g. `"TRACE"`) resolves GET
// (DRF/Go precedent), distinct from an UNRESOLVABLE dynamic verb -> ALL.
const RECOGNIZED_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// The mutating verbs (plus the "ALL" sentinel) used to pick the winning method
// across a multi-verb chain or route macro: the FIRST mutating verb wins the
// resolution, so a mixed `get(l).post(c)` router stays in the mutating vote.
// Mirrors the Go/Python modules' own constant.
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

/** Collect the HTTP verbs a method-router expression registers. Walks the base
 *  callee and any method-router chain: a plain/scoped verb call (`post(h)`,
 *  `axum::routing::post(h)`), a chained multi-verb link (`get(l).post(c)`, a
 *  `field_expression` whose value is the inner method-router call), `any(..)`
 *  -> "ALL", `on(MethodFilter::VERB, ..)` -> "ALL" (verb v1-DEFERRED), and the
 *  never-mutating `head`/`options` callees (recognized so a head/options-only
 *  router is a deliberate skip, never mistaken for an unresolvable form).
 *  Returns `{ verbs, sawVerbShape }` — `sawVerbShape` gates the route: only a
 *  recognized BASE call (an inner verb/any/on callee) asserts the shape, so a
 *  chain whose base is not a router callee is skipped even if an outer field
 *  verb was collected (guards against a plain `receiver.post(h)` method call). */
function collectMethodVerbs(arg1: SyntaxNode): { verbs: string[]; sawVerbShape: boolean } {
  const verbs: string[] = [];
  let sawVerbShape = false;
  let cur: SyntaxNode | null = arg1;
  for (let hops = 0; cur && hops < 16; hops++) {
    if (cur.type !== "call_expression") break;
    const fn = cur.childForFieldName("function");
    if (fn?.type === "identifier") {
      const name = fn.text;
      if (VERB_CALLEES.has(name)) { verbs.push(VERB_CALLEES.get(name)!); sawVerbShape = true; }
      else if (EXCLUDED_VERB_CALLEES.has(name)) { verbs.push(EXCLUDED_VERB_CALLEES.get(name)!); sawVerbShape = true; }
      else if (ANY_CALLEES.has(name)) { verbs.push("ALL"); sawVerbShape = true; }
      else if (ON_CALLEES.has(name)) { verbs.push("ALL"); sawVerbShape = true; } // v1: MethodFilter precise verb deferred
      break; // base of the chain
    }
    if (fn?.type === "scoped_identifier") {
      const name = fn.childForFieldName("name")?.text ?? "";
      if (VERB_CALLEES.has(name)) { verbs.push(VERB_CALLEES.get(name)!); sawVerbShape = true; }
      else if (EXCLUDED_VERB_CALLEES.has(name)) { verbs.push(EXCLUDED_VERB_CALLEES.get(name)!); sawVerbShape = true; }
      break;
    }
    if (fn?.type === "field_expression") {
      // A chain link (`get(l).post(c)`). Collect the outer verb but do NOT assert
      // the method-router shape here: only a recognized BASE call (an inner
      // verb/any/on callee) sets sawVerbShape. This skips a plain method call on
      // a non-router receiver (`receiver.post(h)`, whose base is a bare
      // identifier) rather than emitting it as a spurious mutating route.
      const verb = fn.childForFieldName("field")?.text ?? "";
      if (VERB_CALLEES.has(verb)) verbs.push(VERB_CALLEES.get(verb)!);
      else if (EXCLUDED_VERB_CALLEES.has(verb)) verbs.push(EXCLUDED_VERB_CALLEES.get(verb)!);
      cur = fn.childForFieldName("value"); // recurse into the inner method-router call
      continue;
    }
    break;
  }
  return { verbs, sawVerbShape };
}

/** Resolved method for an Axum builder arg1, or null to SKIP. Not a method
 *  router (a bare identifier, an unrecognized callee) -> null. A verb-SHAPED
 *  router whose usable verbs are all HEAD/OPTIONS -> null (never mutating). An
 *  unresolvable-but-verb-shaped form (`on(..)`, `any(..)`) -> "ALL": it stays
 *  in the mutating vote, never a silent GET-drop (mirror Go resolveAnyFieldMethod).
 *  Otherwise the first mutating verb across the chain, else the first verb. */
function resolveAxumMethod(arg1: SyntaxNode): string | null {
  const { verbs, sawVerbShape } = collectMethodVerbs(arg1);
  if (!sawVerbShape) return null; // arg1 is not a method router: skip the route
  const usable = verbs.filter((v) => v !== "HEAD" && v !== "OPTIONS");
  if (usable.length === 0) return null; // HEAD/OPTIONS-only -> skip (never mutating)
  return usable.find((v) => MUTATING_VERBS.has(v)) ?? usable[0];
}

/** Handler name = the INNERMOST method-router call's first identifier argument
 *  (`post(create_order)` -> "create_order"; `get(l).post(c)` -> "l", the base
 *  call). RouteInfo has no handler slot; this is carried on RustRoute for
 *  Task 3's benefit only, unused downstream today. Null when the base call's
 *  first argument is not a plain identifier (e.g. `on(MethodFilter::POST, h)`,
 *  whose first argument is the filter). */
function axumHandlerName(arg1: SyntaxNode): string | null {
  let cur: SyntaxNode | null = arg1;
  for (let hops = 0; cur && hops < 16; hops++) {
    if (cur.type !== "call_expression") return null;
    const fn = cur.childForFieldName("function");
    if (fn?.type === "field_expression") { cur = fn.childForFieldName("value"); continue; }
    const inner = cur.childForFieldName("arguments")?.namedChild(0) ?? null;
    return inner?.type === "identifier" ? inner.text : null;
  }
  return null;
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

/** The `method = "VERB"` verbs of a generic `#[route(...)]` token tree, in
 *  source order, uppercased. The token tree is FLAT: an `identifier "method"`
 *  named child is followed (skipping the anonymous `=`) by a `string_literal`
 *  value. A non-string value (a bare identifier / const) is not readable and
 *  is skipped, so an empty result means "no readable method=". */
function readRouteMacroMethods(tokenTree: SyntaxNode): string[] {
  const kids = rustNamed(tokenTree);
  const out: string[] = [];
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].type !== "identifier" || kids[i].text !== "method") continue;
    const val = kids[i + 1];
    const text = val ? rustStringText(val) : null;
    if (text !== null) out.push(text.toUpperCase());
  }
  return out;
}

/** Resolved method for an attribute macro, or null to SKIP (the macro resolves
 *  to a non-mutating-only HEAD/OPTIONS set). A per-verb macro (`#[post(..)]`) is
 *  the macro name upper-cased. The generic `#[route(.., method = "VERB")]`
 *  macro reads its verbs from the token tree: no readable `method=` -> "ALL"
 *  (any method); a fully-literal unrecognized verb -> GET (DRF/Go precedent);
 *  HEAD/OPTIONS values are excluded, and a route whose only verbs are
 *  HEAD/OPTIONS resolves null (skip). Among the rest, the first mutating verb,
 *  else the first. */
function attrMacroMethod(macro: string, tokenTree: SyntaxNode | null): string | null {
  if (macro !== ROUTE_MACRO) return macro.toUpperCase();
  const raw = tokenTree ? readRouteMacroMethods(tokenTree) : [];
  if (raw.length === 0) return "ALL"; // no readable method= -> matches any method
  const mapped = raw
    .map((v) => (v === "HEAD" || v === "OPTIONS" ? null : RECOGNIZED_VERBS.has(v) ? v : "GET"))
    .filter((v): v is string => v !== null);
  if (mapped.length === 0) return null; // only HEAD/OPTIONS -> skip (never mutating)
  return mapped.find((v) => MUTATING_VERBS.has(v)) ?? mapped[0];
}

/** Attribute-macro route on the function_item that FOLLOWS the attribute_item sibling. */
function asAttributeRoute(attrItem: SyntaxNode): RustRoute | null {
  const attr = rustNamed(attrItem).find((n) => n.type === "attribute");
  if (!attr) return null;
  const callee = attr.namedChild(0);
  const macro = callee?.type === "identifier" ? callee.text
    : callee?.type === "scoped_identifier" ? (callee.childForFieldName("name")?.text ?? "") : "";
  if (!ATTR_ROUTE_METHODS.has(macro) && macro !== ROUTE_MACRO) return null;
  const tokenTree = attr.childForFieldName("arguments") ?? null;
  const pathNode = tokenTree
    ? rustNamed(tokenTree).find((n) => n.type === "string_literal" || n.type === "raw_string_literal")
    : null;
  const path = pathNode ? rustStringText(pathNode) : null;
  if (path === null || !path.startsWith("/")) return null;
  const method = attrMacroMethod(macro, tokenTree);
  if (method === null) return null; // HEAD/OPTIONS-only route macro -> skip
  // The route attaches to the nearest following function_item sibling, skipping comments
  // and other attributes.
  let sib: SyntaxNode | null = attrItem.nextNamedSibling;
  while (sib && (sib.type === "line_comment" || sib.type === "block_comment" || sib.type === "attribute_item")) {
    sib = sib.nextNamedSibling;
  }
  if (sib?.type !== "function_item") return null;
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
