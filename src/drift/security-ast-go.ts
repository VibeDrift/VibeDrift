/**
 * AST-based route extraction for Go (Gin, Echo, chi, Gorilla mux, and
 * stdlib net/http), used by security-consistency.ts in place of the regex
 * line-window extractor whenever a parsed tree is available and clean.
 * Mirrors the shipped JS/TS design in src/drift/security-ast.ts and the
 * Python port in src/drift/security-ast-python.ts.
 *
 * A find-replace port from either sibling module fails silently on five Go
 * grammar traps:
 *   1. Both sides of `:=` and `=` are `expression_list` WRAPPERS, even for a
 *      single name/value pair (`api := r.Group("/api")` has a one-element
 *      `expression_list` on each side, not a bare `identifier`/`call_expression`
 *      the way Python's `assignment` does). `var name = value` is different
 *      again: `var_spec` exposes `name` and `value` directly, and `value` is
 *      itself an `expression_list` needing `namedChild(0)`.
 *   2. chi closure params shadow: `r.Route("/admin", func(r chi.Router) {
 *      r.Post("/users", h) })` rebinds `r` to a NEW router value inside the
 *      closure with the SAME NAME as the outer receiver. A scope-blind walk
 *      that resolves receivers purely by name (as this module does) gets the
 *      right answer here by coincidence of naming, but the closure-parameter
 *      case has to be handled on its own terms for the (more common) case
 *      where the inner parameter has a DIFFERENT name than the outer router.
 *   3. `With(...)` and `Subrouter()` are themselves `call_expression`
 *      OPERANDS, not identifiers: `r.With(auth).Post(...)` has a
 *      `call_expression` (`r.With(auth)`) sitting where a plain receiver
 *      identifier normally would; `r.PathPrefix("/x").Subrouter()` nests a
 *      second `call_expression` one level deeper still. Both need their own
 *      unwrapping, not a generic "receiver is always identifier/selector"
 *      assumption.
 *   4. Chained calls double-visit under a naive walk: `r.With(auth).Post(...)`
 *      is ONE `call_expression` for `.Post(...)` whose `function` operand is
 *      ANOTHER `call_expression` for `.With(auth)`. `descendantsOfType`
 *      surfaces BOTH nodes. This is harmless for `With` (never in
 *      `VERB_FIELDS`) and for Gorilla's `.HandleFunc(x).Methods("POST")`
 *      two-link chain (probe-verified: `descendantsOfType` visits the OUTER
 *      `.Methods(...)` call FIRST, but "Methods" is not itself a recognized
 *      route-registration field, so it is simply skipped when the walk
 *      reaches it; the INNER `HandleFunc` call is the anchor and resolves the
 *      chain by walking back UP via `chainedMethodVerbs`, never double
 *      counting). A Gorilla-style ROUTE-BUILDER chain
 *      (`r.Methods("POST").Path("/x").HandlerFunc(h)`) is a THIRD, different
 *      shape: three nested `call_expression`s where the registering field
 *      (`HandlerFunc`/`Handler`) sits OUTERMOST and the path/method live in
 *      chain links, not in that call's own arguments. This module does not
 *      unwind that chain (see PINNED RECALL GAPS below); every one of its
 *      three links is individually unrecognized, so it emits zero routes
 *      rather than guessing.
 *   5. Go 1.22's `net/http` added verb-prefixed pattern strings
 *      (`http.HandleFunc("POST /orders", h)`, `mux.HandleFunc("GET /x", h)`):
 *      the method lives INSIDE the path string, not in the call's field name.
 *      `splitServeMuxPattern` parses a leading `UPPERCASE-VERB ` prefix off a
 *      path that does NOT start with `/`; a host pattern
 *      (`"example.com/route"`) or a lowercase verb (`"post /x"`) is left
 *      alone and the whole registration is skipped, never guessed.
 *
 * INVARIANT SCOPE: the never-false-bless guarantee (never mark an unauthed
 * route as authed) holds on THIS AST path only. A file with a parse error
 * anywhere (`tree.rootNode.hasError`) is routed whole to the existing regex
 * extractor, which keeps its own legacy behavior unchanged. Per-route auth
 * recognition (Task 3) now emits `hasAuth: true` ONLY when a middleware-position
 * argument resolves to an in-file body that VERIFIABLY rejects (401-family, or a
 * credential-guarded 403); every opaque, imported, unreadable, or veto case
 * resolves `hasAuth: false` (plus `authUnsureHook` when auth-flavored-opaque), so
 * a wrong answer can only under-report auth, never over-report it. Scope
 * inheritance from Use/group middleware is Task 4 (still unwired).
 *
 * RESIDUAL EXPOSURE (matching the Python module's own accepted exposures): a
 * recognized-but-non-enforcing name whose in-file body actually rejects will
 * bless — e.g. a middleware named to imply auth that reads a credential and 401s
 * for an unrelated reason. The pre-LOCKED name-only plan additionally carried a
 * chi `jwtauth.Verifier`, config-object-through-wrap, and arity-1-DI false-bless;
 * those are CLOSED here by requiring a readable rejecting body to bless and by
 * restricting wrap recursion to transparent/unnamed outers (see the Task 3
 * section below).
 *
 * PINNED RECALL GAPS (measured, never a false-bless; each is a route this
 * module will not find rather than one it misclassifies):
 *   - Gorilla mux ROUTE-BUILDER chains (`r.Methods("POST").Path("/x").
 *     HandlerFunc(h)`, `r.Path("/x").Handler(h)`, `r.PathPrefix("/api").
 *     HandlerFunc(h)`): deliberately NOT unwound (see grammar trap 4). The
 *     registering call's field is `HandlerFunc`/`Handler`, never an anchor
 *     this module recognizes, and the path/method live in earlier chain
 *     links, not that call's own arguments. Extending recognition (walking
 *     the chain back to its base identifier, harvesting `Path`/`PathPrefix` +
 *     `Methods` links) is future work, deliberately not built. A skipped
 *     route is a miss, never a bless.
 *   - Embedded-engine method receivers: `type Server struct { *gin.Engine }`
 *     then `func (s *Server) routes() { s.POST("/orders", h) }`. The
 *     receiver `s` is a bare identifier that fails both the constructor gate
 *     (no `s := ctor()` assignment exists) and the naming convention, and
 *     this module does not read struct field lists to learn that `s`
 *     transitively embeds a known router type. The line-window regex
 *     extractor DOES see this route (it is a plain `X.POST(` match), so it
 *     shows up as a classified drop in the AST-vs-regex diff, not a silent
 *     one.
 *   - Conditional route registration guarded by a runtime flag (`if
 *     featureFlag { r.POST(...) }`): the route is extracted unconditionally,
 *     which is a recall-direction (never a bless-direction) simplification,
 *     consistent with how the JS/TS and Python siblings treat conditional
 *     registration.
 *
 * METHOD CONVENTION (Task 2, batched Sub-Phase A decision, LOCKED): an
 * unresolvable or absent method resolves to "ALL", mirroring the Python
 * module's own `methods=` divergence exactly — NEVER a silent GET-drop (an
 * unresolvable route must stay in the mutating vote) and NEVER "ANY" (not a
 * member of the shared mutating vocabulary; see
 * `SECURITY_AST.MUTATING`/`MUTATION_METHODS` in security-ast.ts /
 * security-consistency.ts). A fully-literal but UNRECOGNIZED verb
 * (`.Methods("MKCOL")`) resolves GET instead: fully visible is not ambiguity,
 * the same rule DRF's bare `@api_view()` gets in the Python module. HEAD and
 * OPTIONS are excluded on EVERY resolution path (chained `.Methods(...)`,
 * verb-first, and Go 1.22 verb-in-pattern) the same way `VERB_FIELDS` already
 * excludes them: neither verb is ever mutating, so omission can only
 * under-report, never bless.
 *
 * OPEN QUESTIONS FOR SIGN-OFF (deliberate divergences named so each lands as an
 * explicit, reviewed decision):
 *   - Position-aware `Use` / group-scope resolution, conditional-`Use` skip, and
 *     scope inheritance onto routes (Task 4 middleware scope): this module reads
 *     only PER-ROUTE middleware positions today, never file/group scope.
 *   - Arity-1 wrap recursion and pure-selector name resolution for auth helpers
 *     (Task 3): IMPLEMENTED below. Recursion descends single-argument calls only,
 *     through a transparent/unnamed outer, and a bare handler position is never
 *     read (body-first is middleware-position-only).
 *   - Validation/rate-limit lanes (Task 3) are per-route, whole-segment,
 *     NAME-based (body analysis is auth-lane only); file/group-scoped lanes are
 *     Task 4. A handler body calling `c.ShouldBindJSON` does NOT set
 *     `hasValidation` (the regex path's text window is dropped on the AST path).
 *
 * Route-registration scope covered so far: Gin/Echo/chi verb-selector calls
 * (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`Any`) on a structurally- or
 * conventionally-resolved receiver, plus chi's `With(...)` chain receiver
 * (auth recognition on the `With` argument is Task 3) and `Route(...)`
 * closure-parameter routers (Task 1); Gorilla mux `HandleFunc`/`Handle` with
 * a chained `.Methods(...)`, Gin's verb-first `Handle(method, path, h)`, chi's
 * verb-first `Method`/`MethodFunc`, Echo's verb-first `Add`, and Go 1.22
 * verb-in-pattern strings on both `Handle` and `HandleFunc` (Task 2). The
 * Gorilla route-builder chain form stays pinned out (see PINNED RECALL GAPS).
 */

import type { Tree, SyntaxNode } from "../core/types.js";
import type { RouteInfo, FileMiddleware } from "./security-consistency.js";

/** A middleware body's three-way behavioral signal. 401-family blesses alone; a
 *  403 blesses only inside a credential-guarded reject; a bare/uncorroborated 403,
 *  a 404/500, or a 200 write is neither reject nor opaque (keeps the hedge
 *  meaningful). Mirrors the Python `BodySignal`. */
export type GoBodySignal = "reject" | "none" | "opaque";
/** Precedence outcome over `GoBodySignal`. `unsure` is not-authed INTERNALLY (it
 *  never sets hasAuth) — it only records the middleware name so a renderer can
 *  hedge. NEVER-FALSE-BLESS: every ambiguous/opaque/unreadable branch resolves to
 *  `not-auth` or `unsure`, never `auth`. */
export type GoAuthOutcome = "auth" | "not-auth" | "unsure";

// Verbs a Gin/Echo/chi verb-selector call may register, keyed by the exact
// field-name spelling each framework uses: Gin and Echo use ALL-CAPS
// (`r.GET`, `e.POST`), chi and fiber use Capitalized-only (`r.Get`,
// `r.Post`). Both casings map to the same canonical uppercase verb. A fully
// lowercase field (`api.post(...)`) matches NEITHER key and is a different,
// unrecognized selector, not the same call spelled differently (mirrors
// HEAD/OPTIONS staying out of scope below rather than being silently
// normalized in).
const VERB_FIELDS = new Map([
  ["GET", "GET"], ["Get", "GET"],
  ["POST", "POST"], ["Post", "POST"],
  ["PUT", "PUT"], ["Put", "PUT"],
  ["PATCH", "PATCH"], ["Patch", "PATCH"],
  ["DELETE", "DELETE"], ["Delete", "DELETE"],
]);
// `Any` (Gin/Echo: register the path for every method) resolves to the same
// "ALL" sentinel Express's `.all()` uses, so it participates in the mutating
// vote alongside a real mutating verb.
const ANY_FIELDS = new Set(["Any"]);
// Verb-first registration fields: the FIRST positional argument IS the verb
// literal (chi's `r.Method(method, path, h)` / `r.MethodFunc(...)`, Echo's
// `e.Add(method, path, h)`). "Handle" is deliberately absent from this set:
// Gin's verb-first `r.Handle(method, path, h)` and Gorilla/chi/stdlib's
// path-first `r.Handle(path, h)` share the SAME field name, so "Handle" is
// disambiguated per call site by inspecting arg0 (see the walk below), never
// by static field-set membership.
const VERB_FIRST_FIELDS = new Set(["Method", "MethodFunc", "Add"]);
// Path-first Handle/HandleFunc: Gorilla (`router.Handle`/`HandleFunc(path,
// h)`), chi's any-method form, and stdlib net/http (both the package-level
// `http.Handle`/`HandleFunc` and a constructed `*ServeMux`). The method is
// resolved separately per call — an embedded Go 1.22 verb in the path
// string, a chained `.Methods(...)`, or absent -> "ALL" — never from the
// field name itself.
const HANDLE_FIELDS = new Set(["Handle", "HandleFunc"]);
// Real HTTP verb tokens this module can read out of source TEXT: a
// `.Methods("...")` string argument, a verb-first call's leading argument
// (`r.Method("PATCH", ...)`, `r.Handle("POST", ...)`), or the embedded verb
// in a Go 1.22 ServeMux pattern (`"POST /orders"`). Mirrors the Python
// module's own `HTTP_VERBS` exactly (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS).
// HEAD and OPTIONS ARE members here (recognized TEXT) even though neither is
// ever emitted as a route's method: every resolution path below filters them
// back out before a route is pushed. Recognized-but-excluded is what lets a
// real HEAD/OPTIONS registration (must SKIP) be told apart from a fully
// unrecognized verb like "MKCOL" (resolves GET; see mkcol parity below).
// "ALL" is never a member here: it is purely a resolved OUTPUT sentinel,
// never literal source text.
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
// Verbs a RESOLVED route.method may carry once emitted: VERB_FIELDS' values,
// plus the ALL sentinel every unresolvable/wildcard/Any form resolves to.
// Used to pick the first MUTATING verb out of a resolved, HEAD/OPTION-free
// verb list, in argument order. HEAD and OPTIONS are deliberately absent:
// neither is ever mutating, and (per the HTTP_VERBS comment above) neither
// ever reaches this set anyway, having already been filtered to a skip.
const MUTATING_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL"]);

// Receivers that plausibly register routes, by naming convention alone
// (structural resolution via GO_ROUTER_CONSTRUCTORS below is checked first;
// this is the fallback for the dominant real-world layout where the router
// is built in a different file, e.g. main.go, and only passed into this one
// as a function parameter with no in-file constructor call to key off of).
// ASCII only, whole-name match: a unicode or unconventional receiver name is
// a recognition miss, never a bless.
const GO_ROUTER_RECEIVER =
  /^(?:r|router|e|g|grp|group|app|application|server|srv|engine|api|mux|v\d+|[a-zA-Z][a-zA-Z0-9]*(?:Router|Group|Mux|Engine))$/;
// Structural receiver resolution: an identifier assigned in-file from one of
// these constructors is a route receiver regardless of spelling (`zzz :=
// gin.New()` makes `zzz.POST` extractable even though "zzz" fails
// GO_ROUTER_RECEIVER by convention), matching the shipped Python module's
// Blueprint()/APIRouter() structural resolution. Keyed as "pkg.Ctor" against
// the literal package-qualifier text used at the call site: an import
// aliased away from the framework's usual package name (`gorillamux
// "github.com/gorilla/mux"` instead of the default `mux` alias) will not
// match here, a measured recall gap (see PINNED RECALL GAPS above; that gap
// is moot for Gorilla specifically since mux.NewRouter is not itself in this
// set, Gorilla method-chain semantics being out of scope until a later
// task).
const GO_ROUTER_CONSTRUCTORS = new Set(["gin.Default", "gin.New", "echo.New", "chi.NewRouter"]);
// Field name for a scoped-group derivation (`api := r.Group("/api")`): the
// receiver on the left becomes a router in its own right.
const GROUP_FIELD = "Group";
// Field name for a Gorilla-style subrouter derivation
// (`s := r.PathPrefix("/api").Subrouter()`): same idea as GROUP_FIELD, one
// call_expression deeper (PathPrefix(...) sits where GROUP_FIELD's operand
// normally would).
const SUBROUTER_FIELD = "Subrouter";
// Field names whose LAST positional func_literal argument introduces a new
// router-scoped identifier via its own parameter (chi's `r.Route("/admin",
// func(sub chi.Router) { ... })`): "sub" is a router inside that closure's
// body, gate-only (name-level) in this task; middleware-scope use of the
// closure BODY node itself is Task 4.
const CLOSURE_ROUTE_FIELDS = new Set(["Route"]);

export const SECURITY_AST_GO = {
  VERB_FIELDS, ANY_FIELDS, VERB_FIRST_FIELDS, HANDLE_FIELDS, HTTP_VERBS, MUTATING_VERBS,
  GO_ROUTER_RECEIVER, GO_ROUTER_CONSTRUCTORS,
  GROUP_FIELD, SUBROUTER_FIELD, CLOSURE_ROUTE_FIELDS,
};

/** Path/verb text of a Go string literal. BOTH literal kinds include their
 *  single-character delimiters in .text and this grammar generation has NO
 *  *_content named children, so slice(1, -1) is correct for both. Escapes stay
 *  raw (never unescaped): the path is only used for equality/exclusion.
 *  Anything else (identifier, binary_expression, call) returns null:
 *  statically unresolvable, the route is skipped (a miss is safe, a guessed
 *  path is not). */
function goStringText(node: SyntaxNode): string | null {
  if (node.type !== "interpreted_string_literal" && node.type !== "raw_string_literal") return null;
  return node.text.slice(1, -1);
}

/** Receiver name of X.METHOD(...): identifier text for a plain receiver, the
 *  chain's LAST field name for struct-field receivers (s.router.POST gates on
 *  "router"), and the With-chain's own receiver for chi
 *  r.With(auth).Post(...) (call_expression operand). Anything else is null:
 *  no gate pass, no route (never a bless). */
function goReceiverName(operand: SyntaxNode | null): string | null {
  if (!operand) return null;
  if (operand.type === "identifier") return operand.text;
  if (operand.type === "selector_expression") {
    return operand.childForFieldName("field")?.text ?? null;
  }
  if (operand.type === "call_expression") {
    const fn = operand.childForFieldName("function");
    if (fn?.type === "selector_expression" && fn.childForFieldName("field")?.text === "With") {
      return goReceiverName(fn.childForFieldName("operand"));
    }
  }
  return null;
}

/** True when node or any ancestor BELOW source_file carries a parse error.
 *  Probe-verified hazard: error recovery swallows a later, syntactically valid
 *  registration into a broken call's argument_list as a clean-looking nested
 *  call_expression; extracting from that garbage context could attribute the
 *  route to the wrong receiver/scope. The walk stops below source_file so a
 *  file-level error in a SIBLING function does not suppress clean functions
 *  (per-construct surgical skip; the whole-file dispatch gate is separate). */
function inErroredContext(node: SyntaxNode): boolean {
  let cur: SyntaxNode | null = node;
  while (cur && cur.type !== "source_file") {
    if (cur.hasError) return true;
    cur = cur.parent;
  }
  return false;
}

/** Identifiers assigned in-file from a router constructor (gin.Default(),
 *  chi.NewRouter(), ...) or derived via X.Group(...) / X.PathPrefix().Subrouter()
 *  on an already-resolved base, across ALL THREE declaration forms. TRAP: both
 *  sides of := and = are expression_list WRAPPERS (unlike Python assignment);
 *  var_spec exposes name/value directly. Derived names resolve to a bounded
 *  fixpoint so r -> api -> v1 chains work and pathological chains terminate. */
function collectGoRouterNames(root: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const bindings: Array<{ name: string; rhs: SyntaxNode }> = [];

  const record = (nameNode: SyntaxNode | null, valueNode: SyntaxNode | null) => {
    if (!nameNode || nameNode.type !== "identifier" || !valueNode) return;
    if (valueNode.type !== "call_expression") return;
    bindings.push({ name: nameNode.text, rhs: valueNode });
  };
  for (const decl of root.descendantsOfType(["short_var_declaration", "assignment_statement"])) {
    if (!decl) continue;
    const left = decl.childForFieldName("left");
    const right = decl.childForFieldName("right");
    if (left?.type !== "expression_list" || right?.type !== "expression_list") continue;
    const lc = left.namedChildren.filter((n): n is SyntaxNode => n !== null);
    const rc = right.namedChildren.filter((n): n is SyntaxNode => n !== null);
    // Positional pairing covers a, b := x, y; r, err := f() records nothing useful.
    for (let i = 0; i < lc.length && i < rc.length; i++) record(lc[i], rc[i]);
  }
  for (const spec of root.descendantsOfType("var_spec")) {
    if (!spec) continue;
    const value = spec.childForFieldName("value"); // expression_list
    record(spec.childForFieldName("name"), value?.namedChild(0) ?? null);
  }

  /** "pkg.Ctor" for a constructor call, or null. */
  const ctorKey = (call: SyntaxNode): string | null => {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return null;
    const pkg = fn.childForFieldName("operand");
    const field = fn.childForFieldName("field");
    if (pkg?.type !== "identifier" || !field) return null;
    return `${pkg.text}.${field.text}`;
  };
  /** Base receiver of X.Group(...) or X.PathPrefix(...).Subrouter(), or null. */
  const derivedBase = (call: SyntaxNode): string | null => {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") return null;
    const field = fn.childForFieldName("field")?.text;
    if (field === GROUP_FIELD) return goReceiverName(fn.childForFieldName("operand"));
    if (field === SUBROUTER_FIELD) {
      const inner = fn.childForFieldName("operand"); // the PathPrefix(...) call
      if (inner?.type !== "call_expression") return null;
      const innerFn = inner.childForFieldName("function");
      if (innerFn?.type !== "selector_expression") return null;
      return goReceiverName(innerFn.childForFieldName("operand"));
    }
    return null;
  };

  for (const b of bindings) {
    const key = ctorKey(b.rhs);
    if (key && GO_ROUTER_CONSTRUCTORS.has(key)) names.add(b.name);
  }
  // Derivations resolve against constructor-assigned AND convention-gated bases,
  // to a bounded fixpoint (chained groups; cap terminates pathological input).
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const b of bindings) {
      if (names.has(b.name)) continue;
      const base = derivedBase(b.rhs);
      if (base !== null && (names.has(base) || GO_ROUTER_RECEIVER.test(base))) {
        names.add(b.name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  // chi closure params: r.Route("/x", func(sub chi.Router) { ... }) makes sub a
  // router inside the closure. Name-level add is gate-only over-approximation;
  // middleware scoping (Task 4) keys on the closure body node, not the name.
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") continue;
    if (!CLOSURE_ROUTE_FIELDS.has(fn.childForFieldName("field")?.text ?? "")) continue;
    const base = goReceiverName(fn.childForFieldName("operand"));
    if (base === null || !(names.has(base) || GO_ROUTER_RECEIVER.test(base))) continue;
    const lit = call.childForFieldName("arguments")?.namedChildren
      .find((n) => n?.type === "func_literal");
    const param = lit?.childForFieldName("parameters")?.descendantsOfType("parameter_declaration")[0];
    const pname = param?.childForFieldName("name");
    if (pname?.type === "identifier") names.add(pname.text);
  }
  return names;
}

interface GoRoute {
  method: string;
  path: string;
  call: SyntaxNode;    // the route-ANCHOR call (line + arg scanning)
  receiver: string;
}

/** Chained `.Methods(...)` recovery, walking UP from the route-ANCHOR call
 *  (probe-verified against the pinned tree-sitter-go grammar: the OUTER node
 *  of `router.HandleFunc(x).Methods("POST")` is the `Methods` call, and
 *  `descendantsOfType`'s pre-order visits it FIRST; the anchor is the INNER
 *  `HandleFunc` call, so route recognition never double-processes a chain —
 *  "Methods" is not itself a recognized route-registration field, so the
 *  outer call is simply skipped when the walk reaches it on its own). Walks
 *  THROUGH intermediate links (`.Name()`, `.Host()`, `.Schemes()`, in either
 *  order relative to `.Methods()`); hop-capped so a pathological chain
 *  terminates rather than looping. Returns null when there is no attached
 *  `.Methods(...)` at all (a bare anchor, or a chain carried through a
 *  variable across two statements — `route := r.HandleFunc(...)` breaks the
 *  parent-is-selector-expression link immediately). */
function chainedMethodVerbs(anchor: SyntaxNode): { verbs: string[]; unresolvable: boolean } | null {
  let current: SyntaxNode = anchor;
  for (let hops = 0; hops < 8; hops++) {
    const parent = current.parent;
    if (!parent || parent.type !== "selector_expression") return null;
    if (!(parent.childForFieldName("operand")?.equals(current) ?? false)) return null;
    const grand = parent.parent;
    if (!grand || grand.type !== "call_expression") return null;
    if (!(grand.childForFieldName("function")?.equals(parent) ?? false)) return null;
    if (parent.childForFieldName("field")?.text === "Methods") {
      const named = grand.childForFieldName("arguments")?.namedChildren
        .filter((n): n is SyntaxNode => n !== null) ?? [];
      const raw = named.map((n) => goStringText(n));
      if (raw.length === 0 || raw.some((v) => v === null)) {
        // .Methods() empty, or a non-literal arg (an identifier, a `verbs...`
        // spread): statically unresolvable, the route must STAY in the
        // mutating vote ("ALL"), never default toward GET.
        return { verbs: [], unresolvable: true };
      }
      return {
        verbs: raw.map((v) => (v as string).toUpperCase()).filter((v) => HTTP_VERBS.has(v)),
        unresolvable: false,
      };
    }
    current = grand; // not Methods: keep climbing through this chain link
  }
  return null;
}

/** Method for a Handle/HandleFunc anchor with no embedded Go 1.22 verb, or
 *  null to SKIP the route. Absent chain resolves "ALL" (MUTATING_VERBS
 *  membership keeps it voted; never a silent GET-drop, mirroring Python's own
 *  `methods=` divergence). HEAD/OPTIONS are filtered BEFORE the
 *  first-mutating pick; a chain whose recognized verbs are ONLY HEAD/OPTIONS
 *  skips the route entirely (parity with VERB_FIELDS never emitting either
 *  verb). Fully-literal-but-unrecognized verbs (`.Methods("MKCOL")`, zero
 *  recognized of ANY kind) resolve GET: fully visible is not ambiguity (mkcol
 *  parity, the same rule Python's `methodFromLiteral` applies). */
function resolveAnyFieldMethod(anchor: SyntaxNode): string | null {
  const chain = chainedMethodVerbs(anchor);
  if (chain === null || chain.unresolvable) return "ALL";
  const verbs = chain.verbs.filter((v) => v !== "HEAD" && v !== "OPTIONS");
  if (verbs.length === 0) {
    // Recognized verbs were exclusively HEAD/OPTIONS: skip. None recognized
    // at all (MKCOL): GET.
    return chain.verbs.length > 0 ? null : "GET";
  }
  return verbs.find((v) => MUTATING_VERBS.has(v)) ?? verbs[0];
}

/** Method for a verb-first call (chi's Method/MethodFunc, Echo's Add, Gin's
 *  verb-first Handle): arg0 IS the verb. A non-literal arg0 (a bare variable)
 *  is statically unresolvable and stays "ALL", never a silent GET. A literal
 *  HEAD or OPTIONS SKIPS the route (null) on this path too, the same
 *  exclusion the chain and Go 1.22 paths apply. A literal but unrecognized
 *  verb resolves GET, the same fully-visible-is-not-ambiguity rule
 *  `resolveAnyFieldMethod` applies to `.Methods("MKCOL")`. */
function resolveVerbFirstMethod(arg0: SyntaxNode): string | null {
  const raw = goStringText(arg0);
  if (raw === null) return "ALL"; // variable/expression verb: unresolvable, stays mutating
  const upper = raw.toUpperCase();
  if (upper === "HEAD" || upper === "OPTIONS") return null;
  return HTTP_VERBS.has(upper) ? upper : "GET";
}

/** Go 1.22 `net/http` ServeMux patterns embed the verb in the path string
 *  (`"POST /items"`), not in the call's field name. Accept only an exact
 *  uppercase HTTP verb, whitespace, then a leading-slash remainder; a host
 *  pattern (`"example.com/route"`) and a lowercase verb (`"post /x"`) skip
 *  entirely (a miss is safe, a guessed method is not). HEAD/OPTIONS patterns
 *  skip too, so a route never reaches the walk carrying either verb. A plain
 *  path with no embedded verb returns `method: null` so the caller resolves
 *  it through its own chain/Any logic instead. */
function splitServeMuxPattern(raw: string): { method: string | null; path: string } | null {
  if (raw.startsWith("/")) return { method: null, path: raw };
  const m = raw.match(/^([A-Z]+)\s+(\/.*)$/);
  if (!m || !HTTP_VERBS.has(m[1])) return null;
  if (m[1] === "HEAD" || m[1] === "OPTIONS") return null;
  return { method: m[1], path: m[2] };
}

// ─── Body-first auth classification (Task 3) ─────────────────────────────────
//
// Classifies a MIDDLEWARE/wrapper argument by what its BODY does, not what its
// name suggests. `bodyAuthSignatureGo` walks the effective body (plus ONE hop
// into a same-file helper) and returns "reject" | "none" | "opaque";
// `classifyGoMiddlewareAuth` layers the LOCKED five-rule precedence on top and
// produces the THREE-WAY "auth" | "not-auth" | "unsure".
//
// LOCKED OWNER DECISION: blessing REQUIRES a verifiable reject in a READABLE
// in-file body (rule 2). There is NO name-only bless — an opaque body (rule 4)
// and an unreadable/imported body (rule 5) resolve `goNameIsFlavored ? "unsure"
// : "not-auth"`, NEVER "auth". A veto segment (rule 1) beats even a real body
// reject. So a package-qualified selector (middleware.AuthMiddleware) is used
// ONLY to RESOLVE an in-file def's body; unresolved -> opaque/name-tier.
//
// NEVER-FALSE-BLESS: every ambiguous/opaque/unreadable case resolves to
// not-auth or unsure. Scope of body-first: it upgrades MIDDLEWARE positions
// (per-route middle args, With links, wrap callees) — never a route's own
// handler target. Wrap recursion is single-argument only (arity >= 2 is Go DI,
// never classified), depth-capped, and descends ONLY through a
// recursion-transparent observability outer (logRequests / metricsWrap) or an
// UNNAMED outer; a SUBSUMING-veto outer (optionalAuth / SkipAuth /
// DisableAuthInDev / parseJWT) HALTS recursion so it cannot bless an inner CORE
// name. This restriction closes the chi jwtauth.Verifier / config-object /
// arity-1-DI false-bless exposures the pre-LOCKED name-only plan carried.

const GO_STATUS_CONSTS = new Map<string, "401" | "403" | "404" | "500">([
  ["StatusUnauthorized", "401"], ["StatusForbidden", "403"],
  ["StatusNotFound", "404"], ["StatusInternalServerError", "500"],
]);
// Auth-DISABLING / non-enforcing name segments that CANCEL a flavor and, at
// rule 1, resolve not-auth even over a real body reject (blessing a disabler
// inverts reality). Whole-segment matched. "logged" is NOT "log" (EnsureLoggedIn
// stays flavored). "login" vetoes the login-endpoint handler idiom (authLogin).
const GO_AUTH_VETO_SEGMENTS = new Set([
  "skip", "bypass", "mock", "disable", "disabled", "optional", "noop", "fake",
  "stub", "dummy", "test", "dev", "insecure", "parse", "handler", "login",
  "log", "logger", "logging", "metrics", "stats",
]);
// The subset of vetoes that INVERT the auth they wrap: they HALT wrap recursion
// (optionalAuth(requireAuth) must not bless on the inner name).
const GO_SUBSUMING_VETO_SEGMENTS = new Set([
  "skip", "bypass", "mock", "disable", "disabled", "optional", "noop", "fake",
  "stub", "dummy", "insecure", "parse",
]);
// Observability wrappers we recurse THROUGH to find a real inner auth wrap
// (logRequests(requireAuth(h)) — observability does not subsume auth).
const GO_TRANSPARENT_WRAP_SEGMENTS = new Set([
  "log", "logger", "logging", "metrics", "stats", "audit", "trace", "timing", "recover",
]);
// Flavored segments: drive UNSURE-vs-NOT-AUTH for opaque/unreadable bodies (never
// a bless). "auth2" catches OAuth2 (which segments to [o, auth2, ...]).
const GO_AUTH_SEGMENTS = new Set([
  "auth", "auth2", "authenticate", "authenticated", "authentication",
  "authorize", "authorization", "jwt", "oauth", "oauth2", "bearer",
  "session", "token", "user", "users", "credential", "credentials",
  "principal", "identity",
]);
// Adjacent-segment flavored pairs (enforce verb + subject), for names whose
// individual segments are boring but whose pair reads as auth.
const GO_AUTH_PAIRS = new Set([
  "logged in", "require auth", "require login", "require user", "require role",
  "require session", "ensure user", "ensure auth", "ensure session",
  "verify token", "verify user", "verify session", "token required",
  "check auth", "check session", "is authenticated", "validate token",
]);
// Segments that make an UNRESOLVABLE callee opaque-hint (auth-flavored enough
// that "we cannot see what it does" resolves opaque, never a bless).
const GO_OPAQUE_HINT_SEGMENTS = new Set([
  ...GO_AUTH_SEGMENTS, "check", "confirm", "guard", "verify", "require",
  "ensure", "protect", "restrict",
]);
// Credential-surface read shapes. GetHeader/Cookie match on ANY receiver; a bare
// `Get` only when its operand is one of these receivers (excludes Query().Get,
// cache.Get, store.Get). The string key must hit GO_CREDENTIAL_KEY_SEGMENTS and
// NOT GO_CREDENTIAL_KEY_VETO (csrf/xsrf/agent — X-CSRF-Token contains "token").
const GO_CRED_READ_FIELDS = new Set(["GetHeader", "Cookie"]);
const GO_CRED_GET_RECEIVERS = new Set(["session", "ctx", "c", "g"]);
const GO_CREDENTIAL_KEY_SEGMENTS = new Set([
  "user", "uid", "token", "jwt", "auth", "authorization", "login",
  "credentials", "session", "bearer", "cookie", "sid",
]);
const GO_CREDENTIAL_KEY_VETO = new Set(["csrf", "xsrf", "agent"]);
// Gin write methods whose arg0 is a status code (bless only WITH corroboration).
const GO_WRITE_STATUS_FIELDS = new Set([
  "JSON", "String", "XML", "Data", "IndentedJSON", "HTML", "YAML", "ProtoBuf",
  "SecureJSON", "AsciiJSON", "PureJSON",
]);
// Validation / rate-limit lane segments (whole-segment; no veto set — the
// discipline exists to stop substring smuggling, not optionality).
const GO_VAL_SEGMENTS = new Set(["validate", "validator", "validation", "sanitize", "schema"]);
const GO_RATE_SEGMENTS = new Set(["ratelimit", "ratelimiter", "limiter", "throttle", "throttler"]);
const GO_RATE_PAIRS = new Set(["rate limit", "rate limiter", "rate limiting"]);

const CALL_EXPR_T = new Set(["call_expression"]);
const RETURN_T = new Set(["return_statement"]);
const IF_T = new Set(["if_statement"]);

/** Non-null named children of a node. */
function goNamed(n: SyntaxNode | null | undefined): SyntaxNode[] {
  return n ? n.namedChildren.filter((c): c is SyntaxNode => c !== null) : [];
}

/** Lowercase segments of an identifier, split on non-alphanumeric AND CamelCase
 *  boundaries. Copied VERBATIM from security-ast-python.ts:628 (whole-segment
 *  matching makes substring blessing structurally impossible). */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0);
}

/** "401"|"403"|"404"|"500"|"other"|null. An int_literal OR the http.StatusXxx
 *  selector; NEVER guesses a bare local const (returns null so the caller treats
 *  it as unreadable/opaque). */
function goRejectStatus(n: SyntaxNode | null): "401" | "403" | "404" | "500" | "other" | null {
  if (!n) return null;
  if (n.type === "int_literal") {
    const t = n.text;
    return t === "401" || t === "403" || t === "404" || t === "500" ? t : "other";
  }
  if (n.type === "selector_expression") {
    const op = n.childForFieldName("operand");
    const field = n.childForFieldName("field")?.text;
    if (op?.type === "identifier" && op.text === "http" && field) {
      return GO_STATUS_CONSTS.get(field) ?? "other";
    }
  }
  return null;
}

/** Descendants of `node` of one of `types`, NOT descending into nested
 *  `func_literal` subtrees (a reject in a goroutine/defer/callback closure is not
 *  executed inline). Pre-order; the root is never yielded. Mirror of
 *  security-ast-python.ts:813 prunedDescendants. */
function goPrunedDescendants(node: SyntaxNode, types: Set<string>): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode) => {
    for (const child of n.namedChildren) {
      if (!child || child.type === "func_literal") continue;
      if (types.has(child.type)) out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

/** True when a string key reads as a credential (segment hit, veto cancels). */
function goCredKeyIsCredential(key: string): boolean {
  const segs = nameSegments(key);
  if (segs.some((s) => GO_CREDENTIAL_KEY_VETO.has(s))) return false;
  return segs.some((s) => GO_CREDENTIAL_KEY_SEGMENTS.has(s));
}

/** True when a call structurally reads a credential surface: a GetHeader/Cookie
 *  call (any receiver) or a bare `Get` on a session/ctx/c/g receiver, whose arg0
 *  string key is credential-flavored and NOT csrf/xsrf/agent. */
function goIsCredentialReadCall(call: SyntaxNode): boolean {
  const fn = call.childForFieldName("function");
  if (!fn || fn.type !== "selector_expression") return false;
  const field = fn.childForFieldName("field")?.text ?? "";
  const arg0 = call.childForFieldName("arguments")?.namedChild(0) ?? null;
  const key = arg0 ? goStringText(arg0) : null;
  if (key === null) return false;
  if (GO_CRED_READ_FIELDS.has(field)) return goCredKeyIsCredential(key);
  if (field === "Get") {
    const op = fn.childForFieldName("operand");
    if (op?.type === "identifier" && GO_CRED_GET_RECEIVERS.has(op.text)) {
      return goCredKeyIsCredential(key);
    }
  }
  return false;
}

/** True when an unresolvable callee name is auth-flavored enough to be opaque. */
function goNameHasHint(name: string): boolean {
  return nameSegments(name).some((s) => GO_OPAQUE_HINT_SEGMENTS.has(s));
}

/** True when a write-status call (c.JSON(401,...), http.Error(...,401),
 *  w.WriteHeader(401)) is corroborated by a following return / Abort sibling in
 *  the same block — a non-self-aborting 401 write that keeps calling next is NOT
 *  a reject (never-false-bless). */
function goCallCorroborated(call: SyntaxNode): boolean {
  let stmt: SyntaxNode = call;
  while (stmt.parent && stmt.parent.type !== "block") stmt = stmt.parent;
  const block = stmt.parent;
  if (!block) return false;
  const sibs = goNamed(block);
  const idx = sibs.findIndex((s) => s.equals(stmt));
  if (idx < 0) return false;
  for (let i = idx + 1; i < sibs.length; i++) {
    const s = sibs[i];
    if (s.type === "return_statement") return true;
    if (s.type === "expression_statement") {
      const inner = s.namedChild(0);
      const f = inner?.type === "call_expression" ? inner.childForFieldName("function") : null;
      if (f?.type === "selector_expression" && (f.childForFieldName("field")?.text ?? "").startsWith("Abort")) {
        return true;
      }
    }
  }
  return false;
}

/** True when a composite_literal is an echo.HTTPError{Code: 401}. */
function goCompositeIs401Error(composite: SyntaxNode): boolean {
  let typeText = "";
  let lv: SyntaxNode | null = null;
  for (const c of composite.namedChildren) {
    if (!c) continue;
    if (c.type === "literal_value") lv = c;
    else typeText = c.text;
  }
  if (!/HTTPError$/.test(typeText) || !lv) return false;
  for (const ke of goNamed(lv)) {
    if (ke.type !== "keyed_element") continue;
    const key = ke.namedChild(0);
    const valEl = ke.namedChild(1);
    if ((key?.text ?? "") === "Code" && goRejectStatus(valEl?.namedChild(0) ?? valEl ?? null) === "401") {
      return true;
    }
  }
  return false;
}

/** True when a subtree contains a 403 self-aborting reject. */
function goSubtreeHas403Reject(node: SyntaxNode): boolean {
  for (const call of goPrunedDescendants(node, CALL_EXPR_T)) {
    if (call.hasError) continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") continue;
    const field = fn.childForFieldName("field")?.text ?? "";
    if (field === "AbortWithStatus" || field === "AbortWithStatusJSON") {
      if (goRejectStatus(call.childForFieldName("arguments")?.namedChild(0) ?? null) === "403") return true;
    }
  }
  return false;
}

/** Local names bound to a structural credential read (`tok := c.GetHeader(...)`),
 *  pruned of nested closures. Lets `tok == ""` count as a credential guard. */
function goCredentialBoundLocals(body: SyntaxNode): Set<string> {
  const bound = new Set<string>();
  for (const decl of goPrunedDescendants(body, new Set(["short_var_declaration", "assignment_statement"]))) {
    if (decl.hasError) continue;
    const left = decl.childForFieldName("left");
    const right = decl.childForFieldName("right");
    if (left?.type !== "expression_list" || right?.type !== "expression_list") continue;
    const lc = goNamed(left);
    const rc = goNamed(right);
    for (let i = 0; i < lc.length && i < rc.length; i++) {
      if (lc[i].type === "identifier" && rc[i].type === "call_expression" && goIsCredentialReadCall(rc[i])) {
        bound.add(lc[i].text);
      }
    }
  }
  return bound;
}

/** STRICT credential read for the guarded-403 BLESS gate: the if-INITIALIZER (Go
 *  `if _, err := v(c.GetHeader(...)); ...` idiom) or CONDITION must structurally
 *  read a credential surface, or reference a credential-bound local. A vetoed key
 *  (X-CSRF-Token) never qualifies. */
function goGuardHasCredentialRead(
  init: SyntaxNode | null, cond: SyntaxNode | null, boundLocals: Set<string>,
): boolean {
  for (const root of [init, cond]) {
    if (!root) continue;
    const calls = goPrunedDescendants(root, CALL_EXPR_T);
    if (root.type === "call_expression") calls.unshift(root);
    if (calls.some((c) => !c.hasError && goIsCredentialReadCall(c))) return true;
    if (boundLocals.size > 0) {
      const ids = goPrunedDescendants(root, new Set(["identifier"]));
      if (root.type === "identifier") ids.unshift(root);
      if (ids.some((id) => boundLocals.has(id.text))) return true;
    }
  }
  return false;
}

interface GoBodySignals {
  reject401: boolean;
  reject403Guarded: boolean;
  opaqueHint: boolean;
  credentialRead: boolean;
}

/** One EFFECTIVE body's direct signals; `hop` = whether a same-file bare-callee
 *  helper may be followed once. reject401 blesses ALONE; reject403Guarded blesses
 *  only WITH a credential-guarded 403. Nested func_literals are pruned throughout
 *  (a reject in a non-returned closure never blesses). */
function scanGoBody(body: SyntaxNode, defs: Map<string, SyntaxNode | null>, hop: boolean): GoBodySignals {
  const out: GoBodySignals = { reject401: false, reject403Guarded: false, opaqueHint: false, credentialRead: false };
  const merge = (s: GoBodySignals) => {
    out.reject401 ||= s.reject401;
    out.reject403Guarded ||= s.reject403Guarded;
    out.opaqueHint ||= s.opaqueHint;
    out.credentialRead ||= s.credentialRead;
  };

  for (const call of goPrunedDescendants(body, CALL_EXPR_T)) {
    if (call.hasError) continue;
    const fn = call.childForFieldName("function");
    const args = call.childForFieldName("arguments");
    if (!out.credentialRead && goIsCredentialReadCall(call)) out.credentialRead = true;
    if (fn?.type === "selector_expression") {
      const field = fn.childForFieldName("field")?.text ?? "";
      if (field === "AbortWithStatus" || field === "AbortWithStatusJSON") {
        const st = goRejectStatus(args?.namedChild(0) ?? null);
        if (st === "401") out.reject401 = true;
        else if (st === null || st === "other") out.opaqueHint = true; // variable / unknown status
        continue; // 403 via the guarded-if walk; 404/500 contribute nothing
      }
      if (GO_WRITE_STATUS_FIELDS.has(field)) {
        if (goRejectStatus(args?.namedChild(0) ?? null) === "401" && goCallCorroborated(call)) out.reject401 = true;
        continue;
      }
      if (field === "Error" && fn.childForFieldName("operand")?.text === "http") {
        const named = goNamed(args);
        if (goRejectStatus(named[named.length - 1] ?? null) === "401" && goCallCorroborated(call)) out.reject401 = true;
        continue;
      }
      if (field === "WriteHeader") {
        if (goRejectStatus(args?.namedChild(0) ?? null) === "401" && goCallCorroborated(call)) out.reject401 = true;
        continue;
      }
      continue; // GetHeader/Cookie handled above; Next/ServeHTTP = pass path
    }
    if (fn?.type === "identifier") {
      const name = fn.text;
      if (defs.has(name)) {
        const def = defs.get(name) ?? null;
        if (def && hop) {
          const hopBody = resolveEffectiveBody(def, defs);
          if (hopBody) merge(scanGoBody(hopBody, defs, false));
        } else if (!def && goNameHasHint(name)) {
          out.opaqueHint = true; // duplicate same-name def: unresolvable + flavored
        }
        continue; // resolvable at hop=false = cycle guard, contribute nothing
      }
      if (goNameHasHint(name)) out.opaqueHint = true; // unresolvable flavored callee
    }
  }

  // Returned rejects: return echo.NewHTTPError(401) / c.NoContent(401) /
  // &echo.HTTPError{Code:401} / echo.HTTPError{Code:401}.
  for (const ret of goPrunedDescendants(body, RETURN_T)) {
    if (ret.hasError) continue;
    const exprList = ret.namedChild(0);
    if (exprList?.type !== "expression_list") continue;
    const val = exprList.namedChild(0);
    if (!val) continue;
    if (val.type === "call_expression") {
      if (goRejectStatus(val.childForFieldName("arguments")?.namedChild(0) ?? null) === "401") out.reject401 = true;
      continue;
    }
    const composite = val.type === "unary_expression" ? val.namedChild(0) : val;
    if (composite?.type === "composite_literal" && goCompositeIs401Error(composite)) out.reject401 = true;
  }

  // Guarded 403: an `if <credential-condition>: ... <403 reject> ...`.
  const boundLocals = goCredentialBoundLocals(body);
  for (const ifs of goPrunedDescendants(body, IF_T)) {
    if (ifs.hasError) continue;
    const init = ifs.childForFieldName("initializer");
    const cond = ifs.childForFieldName("condition");
    const cons = ifs.childForFieldName("consequence");
    if (cons && (init || cond) && goGuardHasCredentialRead(init, cond, boundLocals) && goSubtreeHas403Reject(cons)) {
      out.reject403Guarded = true;
    }
  }

  return out;
}

/** A middleware body's three-way behavioral signal. */
export function bodyAuthSignatureGo(body: SyntaxNode, defs: Map<string, SyntaxNode | null>): GoBodySignal {
  const s = scanGoBody(body, defs, true);
  if (s.reject401 || s.reject403Guarded) return "reject";
  if (s.opaqueHint || s.credentialRead) return "opaque";
  return "none";
}

/** File-wide map of top-level function/method definitions by name; a name seen
 *  more than once maps to null (duplicate: follow NEITHER). */
export function collectGoFunctionDefs(root: SyntaxNode): Map<string, SyntaxNode | null> {
  const defs = new Map<string, SyntaxNode | null>();
  for (const def of root.descendantsOfType(["function_declaration", "method_declaration"])) {
    if (!def || def.hasError) continue;
    const name = def.childForFieldName("name")?.text; // identifier OR field_identifier
    if (!name) continue;
    defs.set(name, defs.has(name) ? null : def);
  }
  return defs;
}

/** The RESOLVED EFFECTIVE body of a function/method: through a single
 *  return-of-closure (factory `func F() gin.HandlerFunc { return func(c){...} }`,
 *  `return http.HandlerFunc(func(w,r){...})`) or a one-hop returned bare
 *  identifier. NEVER prunes the returned handler closure (else mass false
 *  not-auth); scanGoBody prunes FURTHER-nested closures inside it. */
function resolveEffectiveBody(fnNode: SyntaxNode, defs: Map<string, SyntaxNode | null>): SyntaxNode | null {
  const body = fnNode.childForFieldName("body");
  if (!body) return null;
  const stmts = goNamed(body);
  if (stmts.length === 1 && stmts[0].type === "return_statement") {
    const exprList = stmts[0].namedChild(0);
    const val = exprList?.type === "expression_list" ? exprList.namedChild(0) : null;
    if (val) {
      if (val.type === "func_literal") return val.childForFieldName("body") ?? body;
      if (val.type === "call_expression") {
        const cargs = goNamed(val.childForFieldName("arguments"));
        if (cargs.length === 1 && cargs[0].type === "func_literal") {
          return cargs[0].childForFieldName("body") ?? body;
        }
      }
      if (val.type === "identifier") {
        const def = defs.get(val.text) ?? null;
        if (def) return def.childForFieldName("body") ?? body; // one-hop
      }
    }
  }
  return body;
}

/** True when a name is auth-FLAVORED (drives unsure-vs-not-auth for opaque /
 *  unreadable bodies — NEVER a bless). A veto segment cancels. */
function goNameIsFlavored(name: string): boolean {
  const segs = nameSegments(name);
  if (segs.some((s) => GO_AUTH_VETO_SEGMENTS.has(s))) return false;
  if (segs.some((s) => GO_AUTH_SEGMENTS.has(s))) return true;
  for (let i = 0; i < segs.length - 1; i++) {
    if (GO_AUTH_PAIRS.has(`${segs[i]} ${segs[i + 1]}`)) return true;
  }
  return false;
}

/** The LOCKED five-rule precedence. `body` is the RESOLVED EFFECTIVE body (or
 *  null when imported/unresolvable). Rules 4/5 NEVER return "auth". */
export function classifyGoMiddlewareAuth(
  name: string, body: SyntaxNode | null, defs: Map<string, SyntaxNode | null>,
): GoAuthOutcome {
  const segs = nameSegments(name);
  if (segs.some((s) => GO_AUTH_VETO_SEGMENTS.has(s))) return "not-auth"; // rule 1
  if (body) {
    const sig = bodyAuthSignatureGo(body, defs);
    if (sig === "reject") return "auth"; // rule 2: a verified reject blesses even a boring name
    if (sig === "none") return "not-auth"; // rule 3: a visible non-enforcing body, name never rescues
    return goNameIsFlavored(name) ? "unsure" : "not-auth"; // rule 4: opaque never blesses on name
  }
  return goNameIsFlavored(name) ? "unsure" : "not-auth"; // rule 5: unreadable never blesses on name
}

/** True when a node is a PURE selector chain (identifiers + field selections
 *  only, no call/index anywhere in the operand chain). Only a pure chain's .text
 *  is a NAME — an impure chain would smuggle ARGUMENT text into the resolved
 *  name. Mirror of the shipped Python discipline. */
function isPureSelectorChain(node: SyntaxNode): boolean {
  if (node.type === "identifier") return true;
  if (node.type !== "selector_expression") return false;
  const op = node.childForFieldName("operand");
  return op !== null && isPureSelectorChain(op);
}

/** The NAME a middleware-position argument resolves to: identifier text, a PURE
 *  dotted-selector text, or a call's OWN callee text when that callee is an
 *  identifier or pure selector chain. Never its arguments, never an impure chain.
 *  Unresolvable -> null (never a bless). */
function goMiddlewareName(arg: SyntaxNode): string | null {
  if (arg.type === "identifier") return arg.text;
  if (arg.type === "selector_expression") return isPureSelectorChain(arg) ? arg.text : null;
  if (arg.type === "call_expression") {
    const fn = arg.childForFieldName("function");
    if (fn && isPureSelectorChain(fn)) return fn.text;
  }
  return null;
}

function goNameHasSubsumingVeto(name: string): boolean {
  return nameSegments(name).some((s) => GO_SUBSUMING_VETO_SEGMENTS.has(s));
}
function goNameIsTransparentWrap(name: string): boolean {
  return nameSegments(name).some((s) => GO_TRANSPARENT_WRAP_SEGMENTS.has(s));
}
/** Whole-segment lane verdict (validation / rate-limit). */
function goNameHasSegment(name: string, segments: Set<string>, pairs?: Set<string>): boolean {
  const segs = nameSegments(name);
  if (segs.some((s) => segments.has(s))) return true;
  if (pairs) {
    for (let i = 0; i < segs.length - 1; i++) {
      if (pairs.has(`${segs[i]} ${segs[i + 1]}`)) return true;
    }
  }
  return false;
}
const goNameIsVal = (n: string) => goNameHasSegment(n, GO_VAL_SEGMENTS);
const goNameIsRate = (n: string) => goNameHasSegment(n, GO_RATE_SEGMENTS, GO_RATE_PAIRS);

/** BODY-FIRST classification of a middleware-position argument: resolve the NAME,
 *  resolve its in-file EFFECTIVE body (null when imported/opaque), classify via
 *  classifyGoMiddlewareAuth. Wrap recursion is single-argument only (arity >= 2 is
 *  Go DI, never classified), depth-capped, and only THROUGH a
 *  recursion-transparent observability outer or an UNNAMED outer; a subsuming-veto
 *  outer HALTS. Returns the outcome + the resolved name (for authUnsureHook). */
function classifyGoMiddlewareArg(
  arg: SyntaxNode, defs: Map<string, SyntaxNode | null>, depth = 0,
): { outcome: GoAuthOutcome; name: string | null } {
  if (depth > 5) return { outcome: "not-auth", name: null };
  const name = goMiddlewareName(arg);
  if (name !== null) {
    // v1 resolves only a BARE-IDENTIFIER target to an in-file def (r.Use(mw) or
    // r.Use(mwFactory())); a selector/method target stays null -> name-tier.
    const calleeId =
      arg.type === "identifier"
        ? arg
        : arg.type === "call_expression" && arg.childForFieldName("function")?.type === "identifier"
          ? arg.childForFieldName("function")
          : null;
    const def = calleeId ? defs.get(calleeId.text) ?? null : null;
    const body = def ? resolveEffectiveBody(def, defs) : null;
    const outcome = classifyGoMiddlewareAuth(name, body, defs);
    if (outcome !== "not-auth") return { outcome, name };
    if (goNameHasSubsumingVeto(name)) return { outcome: "not-auth", name };
  }
  // Wrap recursion: single-arg call, through a transparent/unnamed outer only.
  if (arg.type === "call_expression" && (name === null || goNameIsTransparentWrap(name))) {
    const inner = goNamed(arg.childForFieldName("arguments"));
    if (inner.length === 1) return classifyGoMiddlewareArg(inner[0], defs, depth + 1);
  }
  return { outcome: "not-auth", name };
}

/** Every argument of every `With(...)` link while unwinding a chi route's operand
 *  chain (`r.With(a).With(b).Post(...)` harvests BOTH links). */
function collectWithArgs(operand: SyntaxNode | null): SyntaxNode[] {
  const args: SyntaxNode[] = [];
  let cur: SyntaxNode | null = operand;
  for (let hops = 0; cur && cur.type === "call_expression" && hops < 16; hops++) {
    const fn = cur.childForFieldName("function");
    if (fn?.type !== "selector_expression") break;
    if (fn.childForFieldName("field")?.text === "With") args.push(...goNamed(cur.childForFieldName("arguments")));
    cur = fn.childForFieldName("operand");
  }
  return args;
}

/** Per-route auth / validation / rate-limit verdicts + the unsure-hook name, from
 *  the middleware-position args (With links + strictly-between-path-and-handler
 *  args) plus, for Handle/HandleFunc forms, the wrap-callee handler arg. */
function goRouteMiddleware(
  named: SyntaxNode[], pathIdx: number, wrapCallee: SyntaxNode | null,
  fnOperand: SyntaxNode | null, defs: Map<string, SyntaxNode | null>,
): { hasAuth: boolean; hasValidation: boolean; hasRateLimit: boolean; unsureHook: string | undefined } {
  const withArgs = fnOperand ? collectWithArgs(fnOperand) : [];
  const middleArgs: SyntaxNode[] = [];
  for (let i = pathIdx + 1; i < named.length - 1; i++) middleArgs.push(named[i]);
  const mwArgs = [...withArgs, ...middleArgs];

  let hasAuth = false;
  let unsureHook: string | undefined;
  const consider = (a: SyntaxNode) => {
    const { outcome, name } = classifyGoMiddlewareArg(a, defs);
    if (outcome === "auth") hasAuth = true;
    else if (outcome === "unsure" && unsureHook === undefined && name !== null) unsureHook = name;
  };
  for (const a of mwArgs) consider(a);
  if (wrapCallee && wrapCallee.type === "call_expression") consider(wrapCallee);
  if (hasAuth) unsureHook = undefined; // a blessed route never hedges

  // Lanes stay NAME-based and middleware-arg-scoped (auth-lane only reads bodies).
  const laneNames = mwArgs.map(goMiddlewareName).filter((n): n is string => n !== null);
  return {
    hasAuth,
    hasValidation: laneNames.some(goNameIsVal),
    hasRateLimit: laneNames.some(goNameIsRate),
    unsureHook,
  };
}

export function extractGoRoutesAst(tree: Tree, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const routerNames = collectGoRouterNames(tree.rootNode);
  const defs = collectGoFunctionDefs(tree.rootNode);
  const gated = (r: string | null): r is string =>
    r !== null && (routerNames.has(r) || GO_ROUTER_RECEIVER.test(r));

  const emit = (
    method: string, path: string, call: SyntaxNode,
    mw: { hasAuth: boolean; hasValidation: boolean; hasRateLimit: boolean; unsureHook: string | undefined },
  ) => {
    routes.push({
      method,
      path,
      file: filePath,
      // 1-based, the registration call's OWN first row (= the chain start for
      // fluent forms, i.e. the anchor, never a chained .Methods() call's own
      // row): the @vibedrift-public suppression binding depends on it.
      line: call.startPosition.row + 1,
      // Per-route body-first auth (Task 3); scope inheritance is Task 4.
      hasAuth: mw.hasAuth,
      hasValidation: mw.hasValidation,
      hasRateLimit: mw.hasRateLimit,
      hasErrorHandler: false, // write-only field; JS and Python AST hard-code false
      // authUnsureHook only on a NON-blessed, auth-flavored-opaque route; the key
      // is ABSENT otherwise so every other Go route serializes byte-identically.
      ...(mw.unsureHook !== undefined ? { authUnsureHook: mw.unsureHook } : {}),
    });
  };

  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    if (!call || inErroredContext(call)) continue;
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "selector_expression") continue;
    const field = fn.childForFieldName("field")?.text ?? "";
    const fnOperand = fn.childForFieldName("operand");
    const receiver = goReceiverName(fnOperand);
    const args = call.childForFieldName("arguments");
    const named = args?.namedChildren.filter((n): n is SyntaxNode => n !== null) ?? [];
    const arg0Raw = named.length > 0 ? goStringText(named[0]) : null;

    // Gin/Echo/chi verb-selector calls (Task 1, unchanged): the field name
    // itself IS the verb.
    const directVerb = VERB_FIELDS.get(field);
    if (directVerb !== undefined) {
      if (!gated(receiver)) continue;
      if (arg0Raw === null || !arg0Raw.startsWith("/")) continue; // leading-slash gate
      // Middleware are the args strictly between the path (arg0) and the handler
      // (last); the last arg is the handler and is NEVER classified.
      emit(directVerb, arg0Raw, call, goRouteMiddleware(named, 0, null, fnOperand, defs));
      continue;
    }

    // Gin/Echo Any(...): always the ALL sentinel, arg0 is the path directly
    // (no Go 1.22 pattern parsing: Any never carries an embedded verb).
    if (ANY_FIELDS.has(field)) {
      if (!gated(receiver)) continue;
      if (arg0Raw === null || !arg0Raw.startsWith("/")) continue;
      emit("ALL", arg0Raw, call, goRouteMiddleware(named, 0, null, fnOperand, defs));
      continue;
    }

    // "http" is a valid receiver ONLY for the two stdlib registration fields
    // (net/http's package-level Handle/HandleFunc); every other field here
    // (verb-first below, HANDLE_FIELDS below) requires a real router receiver.
    const httpBypass = receiver === "http" && (field === "Handle" || field === "HandleFunc");

    // Verb-first: chi's Method/MethodFunc, Echo's Add, or Gin's verb-first
    // Handle(method, path, h) — disambiguated from Gorilla/chi/stdlib's
    // path-first Handle(path, h) by inspecting arg0: a recognized uppercase
    // HTTP-verb literal means verb-first; anything else falls through to the
    // HANDLE_FIELDS branch below.
    const isVerbFirstHandle = field === "Handle" && arg0Raw !== null && HTTP_VERBS.has(arg0Raw.toUpperCase());
    if (VERB_FIRST_FIELDS.has(field) || isVerbFirstHandle) {
      if (!(gated(receiver) || httpBypass)) continue;
      if (named.length < 2) continue;
      const method = resolveVerbFirstMethod(named[0]);
      if (method === null) continue; // literal HEAD/OPTIONS
      const path = goStringText(named[1]);
      if (path === null || !path.startsWith("/")) continue;
      // Verb-first: verb=arg0, path=arg1, so the middleware window starts after
      // arg1; the handler (last arg) is never classified.
      emit(method, path, call, goRouteMiddleware(named, 1, null, fnOperand, defs));
      continue;
    }

    // Path-first Handle/HandleFunc: Gorilla, chi's any-method form, and
    // stdlib net/http, Go 1.22 verb-in-pattern aware.
    if (HANDLE_FIELDS.has(field)) {
      if (!(gated(receiver) || httpBypass)) continue;
      if (arg0Raw === null) continue;
      const split = splitServeMuxPattern(arg0Raw);
      if (split === null) continue; // host pattern / lowercase verb / verb-alone / HEAD|OPTIONS embedded
      const method = split.method ?? resolveAnyFieldMethod(call); // embedded verb wins over the chain
      if (method === null) continue; // chain narrowed to HEAD/OPTIONS only
      // The handler is the arg right after the path (arg1); for these forms it
      // may be a WRAP callee (auth(handler)) — the only body-first position here.
      const wrapCallee = named.length > 1 ? named[1] : null;
      emit(method, split.path, call, goRouteMiddleware(named, 0, wrapCallee, fnOperand, defs));
      continue;
    }
  }
  return routes;
}
