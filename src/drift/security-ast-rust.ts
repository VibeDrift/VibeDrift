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

// ─── Body-first auth classification (Task 3) ─────────────────────────────────
//
// GOVERNING INVARIANT — NEVER-FALSE-BLESS. A route blesses ONLY when a covering
// (ANCESTOR) `.layer`/`.route_layer` wraps a `middleware::from_fn(fn)` whose
// in-file body VERIFIABLY rejects (401-family, or a credential-guarded 403).
// There is NO name-only bless and NO type-name bless. Every opaque, imported,
// unreadable, or veto case resolves `not-auth` or `unsure`; every auth-flavored
// EXTRACTOR TYPE on a handler param resolves `unsure` (LOCKED, v1 does NOT read
// the `FromRequest` impl even when it is in-file). Mirrors the Go design in
// security-ast-go.ts (classifyGoMiddlewareAuth + bodyAuthSignatureGo).
//
// LAYER SCOPING (the crux): an Axum `.layer`/`.route_layer` wraps only the
// routes registered BEFORE it. In the tree the layer call is the OUTER node and
// the routes it wraps are its DESCENDANTS (a LEFT-associative chain nests as
// route_B(layer_L(route_A(new())))). `coveringLayerArgs` walks UP from a route
// call collecting ONLY ancestor layer args, so `.layer(auth).route(A)` — where A
// is the OUTER node and the layer a descendant — never blesses A.

/** Three-way behavioral signal of a from_fn body: a 401-family (or
 *  credential-guarded 403) reject blesses; a credential-read / opaque-auth-call
 *  body with no reject is `opaque` (drives unsure-vs-not-auth on the name); a
 *  visible non-enforcing body is `none`. Mirrors GoBodySignal. */
export type RustBodySignal = "reject" | "none" | "opaque";
/** Precedence outcome. `unsure` is not-authed internally (never sets hasAuth) —
 *  it only records the hook name so a renderer can hedge. Rules 4/5 (opaque /
 *  unreadable) NEVER return "auth". Mirrors GoAuthOutcome. */
export type RustAuthOutcome = "auth" | "not-auth" | "unsure";

// Named status constants this module reads, mapped to code. Axum SCREAMING_CASE
// (StatusCode::UNAUTHORIZED) and Rocket/Actix PascalCase (Status::Unauthorized /
// HttpResponse::Unauthorized) both resolve. A bare integer literal (from_u16(401),
// Err(401)) is DELIBERATELY absent: v1 requires the named constant (a construction
// is not itself a reject; requiring the name is the safe-direction call).
const RUST_STATUS_CONSTS = new Map<string, "401" | "403" | "404" | "500">([
  ["UNAUTHORIZED", "401"], ["Unauthorized", "401"],
  ["FORBIDDEN", "403"], ["Forbidden", "403"],
  ["NOT_FOUND", "404"], ["NotFound", "404"],
  ["INTERNAL_SERVER_ERROR", "500"], ["InternalServerError", "500"],
]);
// The receiver path a status constant hangs off of (the `path` field of a
// scoped_identifier's LAST segment). `http::StatusCode::UNAUTHORIZED` has a
// nested scoped path whose own last segment is "StatusCode"; matched by suffix.
const STATUS_PATH_TAILS = new Set(["StatusCode", "Status", "HttpResponse"]);
// Actix bare-identifier 401 error constructors (`Err(ErrorUnauthorized(..))`).
const RUST_ERR_CTOR_401 = new Set(["ErrorUnauthorized"]);

// Auth lexicons — VERBATIM copies of the Go sets (security-ast-go.ts). Keeping
// them byte-identical means a rename smuggling attempt fails the same way in both
// languages and the whole-segment discipline is shared.
const RUST_AUTH_VETO_SEGMENTS = new Set([
  "skip", "bypass", "mock", "disable", "disabled", "optional", "noop", "fake",
  "stub", "dummy", "test", "dev", "insecure", "parse", "handler", "login",
  "log", "logger", "logging", "metrics", "stats",
]);
const RUST_AUTH_SEGMENTS = new Set([
  "auth", "auth2", "authenticate", "authenticated", "authentication",
  "authorize", "authorization", "jwt", "oauth", "oauth2", "bearer",
  "session", "token", "user", "users", "credential", "credentials",
  "principal", "identity",
]);
const RUST_AUTH_PAIRS = new Set([
  "logged in", "require auth", "require login", "require user", "require role",
  "require session", "ensure user", "ensure auth", "ensure session",
  "verify token", "verify user", "verify session", "token required",
  "check auth", "check session", "is authenticated", "validate token",
]);
const RUST_OPAQUE_HINT_SEGMENTS = new Set([
  ...RUST_AUTH_SEGMENTS, "check", "confirm", "guard", "verify", "require",
  "ensure", "protect", "restrict",
]);
// Credential-surface reads (a `.get("Authorization")` etc.); the string key must
// be credential-flavored and NOT csrf/xsrf/agent. Mirrors the Go credential set.
const RUST_CRED_READ_FIELDS = new Set([
  "get", "get_header", "header", "typed_header", "cookie", "cookies", "get_cookie",
]);
const RUST_CREDENTIAL_KEY_SEGMENTS = new Set([
  "user", "uid", "token", "jwt", "auth", "authorization", "login",
  "credentials", "session", "bearer", "cookie", "sid",
]);
const RUST_CREDENTIAL_KEY_VETO = new Set(["csrf", "xsrf", "agent"]);
// Optionality wrappers on a handler-param TYPE veto the extractor lane entirely
// (`Option<AuthUser>` / MaybeAuth / OptionalUser never even hedge).
const RUST_OPTIONALITY_SEGMENTS = new Set(["option", "optional", "maybe"]);
// Non-auth Axum/Actix extractor types: a handler param of one of these
// contributes NOTHING (no bless, no hedge).
const RUST_NON_AUTH_EXTRACTORS = new Set([
  "Json", "Query", "Path", "State", "Form", "Extension", "Bytes", "RawQuery",
  "TypedHeader", "Multipart", "Host", "ConnectInfo", "OriginalUri", "Request",
]);
// Auth-flavored extractor types whose NAME hedges (never blesses). The five
// canonical names the brief pins plus a few common synonyms; `Claims` is here
// because it is not segment-flavored on its own.
const RUST_AUTH_EXTRACTOR_TYPES = new Set([
  "AuthUser", "Claims", "RequireAuth", "Identity", "Bearer",
  "AuthenticatedUser", "CurrentUser", "LoggedInUser", "Principal", "JwtClaims",
]);
// Axum middleware constructors whose LAST argument is the middleware handler.
const FROM_FN_CALLEES = new Set(["from_fn", "from_fn_with_state"]);
// Middleware-applying chain fields whose ANCESTOR position over a route makes it
// a covering layer. `wrap` (Actix) is included for classification completeness;
// body-first still gates any bless, so a non-rejecting wrap never blesses.
const LAYER_FIELDS = new Set(["layer", "route_layer", "wrap"]);

const SCOPED_ID_T = new Set(["scoped_identifier"]);
const CALL_EXPR_T = new Set(["call_expression"]);
const IF_EXPR_T = new Set(["if_expression"]);
const LET_DECL_T = new Set(["let_declaration"]);
const RETURN_EXPR_T = new Set(["return_expression"]);

/** Lowercase segments of an identifier, split on non-alphanumeric AND CamelCase
 *  boundaries. Copied VERBATIM from security-ast-go.ts:603 (whole-segment
 *  matching makes substring blessing structurally impossible). */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0);
}

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

interface RustRoute {
  method: string;
  path: string;
  anchor: SyntaxNode;
  handler: string | null;
  // The route-registration `call_expression` (builder `.route(...)` link), the
  // START of the covering-layer ancestor walk. Null for attribute-macro routes
  // (Actix/Rocket have no builder layer chain; only the extractor lane applies).
  call: SyntaxNode | null;
}

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
  return { method, path, anchor: field, handler: axumHandlerName(named[1]), call };
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
  return { method, path, anchor: attrItem, handler: sib.childForFieldName("name")?.text ?? null, call: null };
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

/** "401"|"403"|"404"|"500"|"other"|null for a Rust status node. v1 reads only the
 *  NAMED constant (StatusCode::UNAUTHORIZED / Status::Unauthorized, FORBIDDEN/
 *  Forbidden, ...); a bare integer_literal is NOT blessed (from_u16(401) is a
 *  construction, not a reject — a miss is safe). Never guesses a bare local const. */
function rustRejectStatus(n: SyntaxNode | null): "401" | "403" | "404" | "500" | "other" | null {
  if (!n) return null;
  if (n.type === "scoped_identifier") {
    const pathText = n.childForFieldName("path")?.text ?? "";
    const tail = pathText.split("::").pop() ?? pathText;
    const name = n.childForFieldName("name")?.text ?? "";
    if (STATUS_PATH_TAILS.has(tail)) return RUST_STATUS_CONSTS.get(name) ?? "other";
  }
  if (n.type === "integer_literal") return "other"; // v1: bare integer never blesses
  return null;
}

/** Descendants of `node` of one of `types`, NOT descending into nested
 *  `closure_expression` / `function_item` subtrees (a reject in a non-inline
 *  closure/nested fn is not executed inline). Pre-order; the root is never
 *  yielded. Mirror of goPrunedDescendants (security-ast-go.ts:635). The targeted
 *  `.ok_or_else` closure is read explicitly, never via this walk. */
function rustPrunedDescendants(node: SyntaxNode, types: Set<string>): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode) => {
    for (const child of n.namedChildren) {
      if (!child || child.type === "closure_expression" || child.type === "function_item") continue;
      if (types.has(child.type)) out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

/** True when a string key reads as a credential (segment hit, veto cancels). */
function rustCredKeyIsCredential(key: string): boolean {
  const segs = nameSegments(key);
  if (segs.some((s) => RUST_CREDENTIAL_KEY_VETO.has(s))) return false;
  return segs.some((s) => RUST_CREDENTIAL_KEY_SEGMENTS.has(s));
}

/** True when a call structurally reads a credential surface: `.get("Authorization")`
 *  (only when the receiver chain text mentions a header/cookie surface, excluding
 *  `cache.get(...)`), `.get_header(...)` / `.header(...)` / `.typed_header(...)`, or
 *  a cookie accessor. The string key must be credential-flavored and NOT
 *  csrf/xsrf/agent. Mirrors goIsCredentialReadCall. */
function rustIsCredentialReadCall(call: SyntaxNode): boolean {
  const fn = call.childForFieldName("function");
  if (!fn || fn.type !== "field_expression") return false;
  const field = fn.childForFieldName("field")?.text ?? "";
  if (!RUST_CRED_READ_FIELDS.has(field)) return false;
  const arg0 = call.childForFieldName("arguments")?.namedChild(0) ?? null;
  const key = arg0 && (arg0.type === "string_literal" || arg0.type === "raw_string_literal")
    ? rustStringText(arg0)
    : null;
  const recvText = fn.childForFieldName("value")?.text ?? "";
  const surfaceReceiver = /header|cookie/i.test(recvText);
  if (field === "get") {
    // A generic `.get(key)` counts only on a header/cookie surface with a
    // credential-flavored key (guards against cache.get("token")).
    return surfaceReceiver && key !== null && rustCredKeyIsCredential(key);
  }
  if (field === "cookie" || field === "cookies" || field === "get_cookie") return true;
  // get_header / header / typed_header: credential-flavored key, or a bare
  // header accessor with no string key (typed extractor).
  return key === null || rustCredKeyIsCredential(key);
}

/** True when an unresolvable callee name is auth-flavored enough to be opaque. */
function rustNameHasHint(name: string): boolean {
  return nameSegments(name).some((s) => RUST_OPAQUE_HINT_SEGMENTS.has(s));
}

/** Local names bound to a structural credential read (`let t = req.headers()
 *  .get("Authorization")`), pruned of nested closures. Lets `t.is_none()` count
 *  as a credential guard. Mirror goCredentialBoundLocals. */
function rustCredentialBoundLocals(body: SyntaxNode): Set<string> {
  const bound = new Set<string>();
  for (const decl of rustPrunedDescendants(body, LET_DECL_T)) {
    if (decl.hasError) continue;
    const pattern = decl.childForFieldName("pattern");
    const value = decl.childForFieldName("value");
    if (pattern?.type !== "identifier" || !value) continue;
    if (value.type === "call_expression" && rustIsCredentialReadCall(value)) bound.add(pattern.text);
  }
  return bound;
}

/** True when an if-guard's condition structurally reads a credential surface or
 *  references a credential-bound local (the guarded-403 bless gate). */
function rustGuardHasCredentialRead(cond: SyntaxNode | null, boundLocals: Set<string>): boolean {
  if (!cond) return false;
  const calls = rustPrunedDescendants(cond, CALL_EXPR_T);
  if (cond.type === "call_expression") calls.unshift(cond);
  if (calls.some((c) => !c.hasError && rustIsCredentialReadCall(c))) return true;
  if (boundLocals.size > 0) {
    const ids = rustPrunedDescendants(cond, new Set(["identifier"]));
    if (cond.type === "identifier") ids.unshift(cond);
    if (ids.some((id) => boundLocals.has(id.text))) return true;
  }
  return false;
}

/** True when a subtree contains a 403 status constant (pruned). Only consulted
 *  INSIDE a credential-guarded if-consequence — a bare 403 never blesses. */
function rustSubtreeHas403(node: SyntaxNode): boolean {
  for (const si of rustPrunedDescendants(node, SCOPED_ID_T)) {
    if (rustRejectStatus(si) === "403") return true;
  }
  return false;
}

/** True when `node`, sitting in a PRODUCE / return position, yields a 401
 *  rejection value: a bare `StatusCode::UNAUTHORIZED`, a `(StatusCode::
 *  UNAUTHORIZED, ..)` tuple, a `(STATUS,..).into_response()` / `STATUS
 *  .into_response()` call, or an `Err(<produces 401>)` construction. Recurses
 *  through `Err(..)` and `.into_response()`. Everything else — `Ok(..)`, a plain
 *  identifier, a comparison, a non-status call — yields false. This is the ONLY
 *  gate for a 401 bless: a 401 reached through here in a produce position (a
 *  `return` value, a block tail, an `Err(..)`, an `.ok_or(..)`) rejects; a 401 in
 *  an `if`/`while`/`match` condition/scrutinee, a comparison operand, a match-arm
 *  pattern, or a plain call argument is never routed here. Mirrors Go's
 *  produce-position gating (scanGoBody). */
function rustProduces401(node: SyntaxNode | null): boolean {
  if (!node) return false;
  switch (node.type) {
    case "scoped_identifier":
      return rustRejectStatus(node) === "401";
    case "tuple_expression": {
      const first = node.namedChildren.find((c): c is SyntaxNode => c !== null) ?? null;
      return first?.type === "scoped_identifier" && rustRejectStatus(first) === "401";
    }
    case "call_expression": {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier" && fn.text === "Err") {
        return rustProduces401(node.childForFieldName("arguments")?.namedChild(0) ?? null);
      }
      if (fn?.type === "field_expression" && fn.childForFieldName("field")?.text === "into_response") {
        return rustProduces401(fn.childForFieldName("value"));
      }
      return false;
    }
    default:
      return false;
  }
}

interface RustBodySignals { reject401: boolean; reject403Guarded: boolean; opaqueHint: boolean; credentialRead: boolean; }

/** Scan an effective from_fn body for the reject catalogue. reject401 blesses
 *  ALONE; reject403Guarded blesses only inside a credential-guarded 403 (mirror
 *  Go). Detects a 401 named status in any produce position (Err(STATUS),
 *  (STATUS,..).into_response(), .ok_or(STATUS), a bare tail STATUS, return
 *  Err(STATUS)) plus the ONE explicitly-read `.ok_or_else(|| STATUS)` closure and
 *  Actix `Err(ErrorUnauthorized(..))`. Nested closures are pruned (a reject in a
 *  non-inline closure never blesses). A credential read or an opaque auth-flavored
 *  call with no reject makes the body `opaque` (unsure on the name, never bless). */
function scanRustBody(body: SyntaxNode, defs: Map<string, SyntaxNode | null>): RustBodySignals {
  const out: RustBodySignals = { reject401: false, reject403Guarded: false, opaqueHint: false, credentialRead: false };

  // 1. A 401 named status blesses ONLY as a PRODUCED value (pruned of nested
  //    closures): a `return <STATUS>` value or a block TAIL expression that is a
  //    401, a `(STATUS,..).into_response()`, or an `Err(<produces 401>)`. A 401 in
  //    a comparison operand (`== StatusCode::UNAUTHORIZED`), an `if`/`while`/`match`
  //    condition/scrutinee, a `match`-arm PATTERN, or a plain call ARGUMENT (a
  //    `headers.insert(..)` or a logging macro) is a MENTION, never a reject — the
  //    invariant requires a verifiable rejection, not a mention. The `Err(..)`,
  //    `.ok_or(..)` and `.ok_or_else(..)` produce forms are read in the call scan
  //    (section 2). Mirrors Go's produce-position gating (scanGoBody).
  for (const ret of rustPrunedDescendants(body, RETURN_EXPR_T)) {
    if (ret.hasError) continue;
    if (rustProduces401(ret.namedChild(0) ?? null)) { out.reject401 = true; break; }
  }
  if (!out.reject401) {
    // A block TAIL expression (last child, no trailing `;`), or a bare-expression
    // body (`|req, next| STATUS`). Non-produce last children (an
    // `expression_statement`, a plain identifier) fail rustProduces401.
    const named = body.namedChildren.filter((c): c is SyntaxNode => c !== null);
    const tail = body.type === "block" ? (named[named.length - 1] ?? null) : body;
    if (rustProduces401(tail)) out.reject401 = true;
  }

  // 2. Call-position produce scan: `Err(<produces 401>)` (the idiomatic Axum
  //    reject value), the `.ok_or(STATUS)` / `.ok_or_else(|| STATUS)` produce
  //    forms (read explicitly), Actix bare-identifier 401 constructors, plus the
  //    credential-read and opaque-auth-call signals. A `.into_response()` that is
  //    NOT wrapped in a produce position (section 1) never reaches reject401 here.
  const boundLocals = rustCredentialBoundLocals(body);
  for (const call of rustPrunedDescendants(body, CALL_EXPR_T)) {
    if (call.hasError) continue;
    if (!out.credentialRead && rustIsCredentialReadCall(call)) out.credentialRead = true;
    const fn = call.childForFieldName("function");
    if (fn?.type === "field_expression") {
      const field = fn.childForFieldName("field")?.text;
      if (field === "ok_or") {
        if (rustProduces401(call.childForFieldName("arguments")?.namedChild(0) ?? null)) out.reject401 = true;
        continue;
      }
      if (field === "ok_or_else") {
        const closure = call.childForFieldName("arguments")?.namedChild(0) ?? null;
        const cbody = closure?.type === "closure_expression" ? closure.childForFieldName("body") : null;
        if (cbody) {
          if (cbody.type === "scoped_identifier" && rustRejectStatus(cbody) === "401") out.reject401 = true;
          else if (cbody.namedChildren.some((c) => c && c.type === "scoped_identifier" && rustRejectStatus(c) === "401")) {
            out.reject401 = true;
          } else {
            for (const si of rustPrunedDescendants(cbody, SCOPED_ID_T)) {
              if (rustRejectStatus(si) === "401") { out.reject401 = true; break; }
            }
          }
        }
        continue;
      }
      continue; // any other method call is not a produce path (into_response gated in section 1)
    }
    if (fn?.type === "identifier") {
      const name = fn.text;
      if (name === "Err") {
        if (rustProduces401(call.childForFieldName("arguments")?.namedChild(0) ?? null)) out.reject401 = true;
        continue;
      }
      if (RUST_ERR_CTOR_401.has(name)) { out.reject401 = true; continue; }
      // An unresolvable (not-in-file, or duplicate) auth-flavored callee -> opaque.
      if (!defs.has(name) && rustNameHasHint(name)) out.opaqueHint = true;
    }
  }

  // 3. Guarded 403: an `if <credential-condition> { <403 reject> }`.
  for (const ifs of rustPrunedDescendants(body, IF_EXPR_T)) {
    if (ifs.hasError) continue;
    const cond = ifs.childForFieldName("condition");
    const cons = ifs.childForFieldName("consequence");
    if (cons && rustGuardHasCredentialRead(cond, boundLocals) && rustSubtreeHas403(cons)) {
      out.reject403Guarded = true;
    }
  }

  return out;
}

/** A from_fn body's three-way behavioral signal. */
export function bodyAuthSignatureRust(body: SyntaxNode, defs: Map<string, SyntaxNode | null>): RustBodySignal {
  const s = scanRustBody(body, defs);
  if (s.reject401 || s.reject403Guarded) return "reject";
  if (s.opaqueHint || s.credentialRead) return "opaque";
  return "none";
}

/** True when a name is auth-FLAVORED (drives unsure-vs-not-auth for opaque /
 *  unreadable bodies — NEVER a bless). A veto segment cancels. Mirror goNameIsFlavored. */
function rustNameIsFlavored(name: string): boolean {
  const segs = nameSegments(name);
  if (segs.some((s) => RUST_AUTH_VETO_SEGMENTS.has(s))) return false;
  if (segs.some((s) => RUST_AUTH_SEGMENTS.has(s))) return true;
  for (let i = 0; i < segs.length - 1; i++) {
    if (RUST_AUTH_PAIRS.has(`${segs[i]} ${segs[i + 1]}`)) return true;
  }
  return false;
}

/** The LOCKED five-rule precedence. `body` is the from_fn's in-file body (or null
 *  when imported/unresolvable). Rules 4/5 (opaque / unreadable) NEVER return
 *  "auth" — a name alone never blesses. Mirror classifyGoMiddlewareAuth. */
export function classifyRustAuth(
  name: string, body: SyntaxNode | null, defs: Map<string, SyntaxNode | null>,
): RustAuthOutcome {
  const segs = nameSegments(name);
  if (segs.some((s) => RUST_AUTH_VETO_SEGMENTS.has(s))) return "not-auth"; // rule 1: veto beats a body reject
  if (body) {
    const sig = bodyAuthSignatureRust(body, defs);
    if (sig === "reject") return "auth";                                   // rule 2: a verified reject blesses
    if (sig === "none") return "not-auth";                                 // rule 3: visible non-enforcing body
    return rustNameIsFlavored(name) ? "unsure" : "not-auth";               // rule 4: opaque never blesses on name
  }
  return rustNameIsFlavored(name) ? "unsure" : "not-auth";                 // rule 5: unreadable never blesses on name
}

/** The callee NAME of a call/identifier/scoped_identifier: identifier text, or a
 *  scoped_identifier's last `name` segment. Never its arguments. */
function rustCalleeName(node: SyntaxNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "scoped_identifier") return node.childForFieldName("name")?.text ?? null;
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    return fn ? rustCalleeName(fn) : null;
  }
  return null;
}

/** Classify a `.layer`/`.route_layer`/`.wrap` argument. `from_fn(X)` /
 *  `from_fn_with_state(state, X)` resolve X (the LAST arg) to its in-file
 *  function_item body → classifyRustAuth. A non-from_fn layer arg (TraceLayer::new,
 *  HttpAuthentication::bearer, a bare `auth_mw`) resolves body=null → rule 5
 *  (unsure if auth-flavored, else not-auth). NEVER blessed on the name. */
function classifyRustLayerArg(
  arg: SyntaxNode, defs: Map<string, SyntaxNode | null>,
): { outcome: RustAuthOutcome; name: string | null } {
  if (arg.type === "call_expression") {
    const fn = arg.childForFieldName("function");
    const calleeName = fn ? rustCalleeName(fn) : null;
    if (calleeName && FROM_FN_CALLEES.has(calleeName)) {
      const args = rustNamed(arg.childForFieldName("arguments"));
      const handler = args.length ? args[args.length - 1] : null; // from_fn: only arg; with_state: LAST arg
      if (handler?.type === "identifier") {
        const hname = handler.text;
        const def = defs.get(hname) ?? null;
        const hbody = def ? def.childForFieldName("body") : null;
        return { outcome: classifyRustAuth(hname, hbody, defs), name: hname };
      }
      if (handler?.type === "closure_expression") {
        // Inline `from_fn(|req, next| { ... })`: read the closure body directly;
        // an empty name means the body must carry the whole verdict (no name bless).
        const cbody = handler.childForFieldName("body");
        return { outcome: cbody ? classifyRustAuth("", cbody, defs) : "not-auth", name: null };
      }
      return { outcome: "not-auth", name: null };
    }
    // Non-from_fn layer constructor (TraceLayer::new_for_http(), Logger::default(),
    // HttpAuthentication::bearer(v)): body is unreadable -> rule 5 on the callee name.
    return { outcome: classifyRustAuth(calleeName ?? "", null, defs), name: calleeName };
  }
  if (arg.type === "identifier") {
    return { outcome: classifyRustAuth(arg.text, null, defs), name: arg.text };
  }
  if (arg.type === "scoped_identifier") {
    const name = arg.childForFieldName("name")?.text ?? "";
    return { outcome: classifyRustAuth(name, null, defs), name: name || null };
  }
  return { outcome: "not-auth", name: null };
}

/** Walk UP from a route's `.route` call collecting the ARG NODES of every ANCESTOR
 *  `.layer`/`.route_layer`/`.wrap` call. NEVER-FALSE-BLESS crux: the layer call is
 *  the OUTER node and the routes it wraps are its DESCENDANTS, so a covering layer
 *  is always an ANCESTOR of the route. The walk stops the moment it leaves the
 *  fluent chain (parent is no longer a chain-link whose receiver is the current
 *  node), so `.layer(auth).route(A)` — where A is the OUTER node and the layer a
 *  DESCENDANT — collects nothing and never blesses A. */
function coveringLayerArgs(routeCall: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  let cur: SyntaxNode = routeCall;
  for (let hops = 0; hops < 64; hops++) {
    const parent = cur.parent;
    if (!parent || parent.type !== "field_expression") break;             // left the chain
    if (!(parent.childForFieldName("value")?.equals(cur) ?? false)) break; // cur is not the receiver
    const grand = parent.parent;
    if (!grand || grand.type !== "call_expression") break;
    if (!(grand.childForFieldName("function")?.equals(parent) ?? false)) break;
    if (LAYER_FIELDS.has(parent.childForFieldName("field")?.text ?? "")) {
      for (const a of rustNamed(grand.childForFieldName("arguments"))) out.push(a);
    }
    cur = grand; // climb past this chain link (layer collected above, route/other skipped)
  }
  return out;
}

/** The OUTER type name of a handler-param type node: `AuthUser` -> "AuthUser",
 *  `Option<AuthUser>` -> "Option" (outer, so the optionality veto fires),
 *  `Json<T>` -> "Json", `&AuthUser` -> "AuthUser", `web::Json<T>` -> "Json". */
function rustTypeName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "type_identifier") return node.text;
  if (node.type === "generic_type") return rustTypeName(node.childForFieldName("type"));
  if (node.type === "scoped_type_identifier") return node.childForFieldName("name")?.text ?? null;
  if (node.type === "reference_type") return rustTypeName(node.childForFieldName("type"));
  return null;
}

/** Auth-extractor-typed handler param → the type NAME (UNSURE, never a bless in
 *  v1). Resolve the handler identifier → in-file function_item → each param's
 *  OUTER type name. An Option/Maybe/Optional wrapper vetoes the param entirely; a
 *  non-auth extractor (Json/Query/Path/State/Form/...) contributes nothing. v1
 *  does NOT read the type's `FromRequest` impl even when it is in-file (LOCKED —
 *  the biggest documented recall cost). Returns the FIRST auth-extractor type
 *  name, or null. */
function extractorTypeUnsure(handler: string | null, defs: Map<string, SyntaxNode | null>): string | null {
  if (!handler) return null;
  const def = defs.get(handler) ?? null;
  const params = def?.childForFieldName("parameters");
  if (!params) return null;
  for (const p of rustNamed(params)) {
    if (p.type !== "parameter") continue;
    const tname = rustTypeName(p.childForFieldName("type"));
    if (!tname) continue;
    const segs = nameSegments(tname);
    if (segs.some((s) => RUST_OPTIONALITY_SEGMENTS.has(s))) continue; // optionality veto -> no hedge
    if (RUST_NON_AUTH_EXTRACTORS.has(tname)) continue;                // Json/Path/State/... -> nothing
    if (RUST_AUTH_EXTRACTOR_TYPES.has(tname) || rustNameIsFlavored(tname)) return tname;
  }
  return null;
}

export function extractRustRoutesAst(tree: Tree, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const root = tree.rootNode;
  // File-wide function-def map for body-first auth resolution (Task 3): from_fn
  // middleware handlers and handler-param extractor lookups both key off it.
  const defs = collectRustFunctionDefs(root);

  // Attribute-macro routes (Actix/Rocket). attribute_item siblings are flat
  // (never nested inside each other), so traversal order already matches
  // source order.
  for (const attrItem of root.descendantsOfType("attribute_item")) {
    if (!attrItem || inErroredContext(attrItem)) continue;
    const r = asAttributeRoute(attrItem);
    if (r) routes.push(emitRoute(r, filePath, defs));
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
  for (const r of builderMatches) routes.push(emitRoute(r, filePath, defs));

  return routes;
}

function emitRoute(r: RustRoute, filePath: string, defs: Map<string, SyntaxNode | null>): RouteInfo {
  // Finalize per-route auth (Task 3). For each covering (ancestor) layer arg,
  // classify body-first: ANY "auth" blesses (hasAuth = true, hook cleared — a
  // blessed route never hedges). Else the FIRST "unsure" covering layer name, or
  // (if none) the auth-extractor type on the handler param, fills authUnsureHook.
  // A mutating route with no signal stays hasAuth=false with no hedge.
  let hasAuth = false;
  let authUnsureHook: string | undefined;
  for (const arg of r.call ? coveringLayerArgs(r.call) : []) {
    const { outcome, name } = classifyRustLayerArg(arg, defs);
    if (outcome === "auth") hasAuth = true;
    else if (outcome === "unsure" && authUnsureHook === undefined && name) authUnsureHook = name;
  }
  if (hasAuth) {
    authUnsureHook = undefined; // a blessed route never hedges
  } else if (authUnsureHook === undefined) {
    const ext = extractorTypeUnsure(r.handler, defs);
    if (ext) authUnsureHook = ext;
  }

  return {
    method: r.method,
    path: r.path,
    file: filePath,
    line: r.anchor.startPosition.row + 1, // anchor = the "route" field token (builder) or attribute_item (macro)
    hasAuth,               // Task 3: body-first, covering-ancestor-layer only
    hasValidation: false,  // deferred non-goal
    hasRateLimit: false,   // deferred non-goal
    hasErrorHandler: false, // write-only field; every AST path hard-codes false
    // authUnsureHook only on a NON-blessed, auth-flavored-opaque route; the key
    // is ABSENT otherwise so every other Rust route serializes byte-identically.
    ...(authUnsureHook !== undefined ? { authUnsureHook } : {}),
  };
}
