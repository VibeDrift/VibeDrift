/**
 * AST-based route extraction for Go (Gin, Echo, chi), used by
 * security-consistency.ts in place of the regex line-window extractor
 * whenever a parsed tree is available and clean. Mirrors the shipped JS/TS
 * design in src/drift/security-ast.ts and the Python port in
 * src/drift/security-ast-python.ts.
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
 *      surfaces BOTH nodes. This is harmless here because `With` is never in
 *      `VERB_FIELDS`, but a Gorilla-style builder chain
 *      (`r.Methods("POST").Path("/x").HandlerFunc(h)`, out of scope for this
 *      task) has THREE nested `call_expression`s under one statement; whoever
 *      wires that chain up in a later task must resolve it from the
 *      OUTERMOST call only, or the same registration double-counts.
 *   5. Go 1.22's `net/http` added verb-prefixed pattern strings
 *      (`http.HandleFunc("POST /orders", h)`, `mux.HandleFunc("GET /x", h)`):
 *      the method lives INSIDE the path string, not in the call's field name.
 *      None of this module's forms parse a leading verb out of a path string;
 *      that is entirely separate machinery, deliberately not built here.
 *
 * INVARIANT SCOPE: the never-false-bless guarantee (never mark an unauthed
 * route as authed) holds on THIS AST path only. A file with a parse error
 * anywhere (`tree.rootNode.hasError`) is routed whole to the existing regex
 * extractor, which keeps its own legacy behavior unchanged. Even on a clean
 * tree, this module never emits `hasAuth: true` in this task: auth
 * recognition is Task 3, so every route below carries `hasAuth: false`
 * unconditionally, which can only under-report auth, never over-report it.
 *
 * KNOWN FALSE-BLESS EXPOSURE (carried forward from the Integration contract,
 * not yet reachable from this module since `hasAuth` is hard-coded false
 * here): once Task 3 lands per-route auth recognition, a handful of
 * recognized-but-non-enforcing names are expected to remain a residual
 * exposure by design (matching the Python module's own documented
 * exposures): a custom type or middleware literally named `AuthContext`
 * that carries identity without enforcing it, an `apiKeyRotator` helper
 * that manages keys without gating a request, and single-argument DI
 * constructors whose one parameter happens to read as auth-flavored
 * without the constructor itself checking anything. None of these can
 * fire in Task 1: they are named here so the eventual auth pass documents
 * the same exposure the Python module already accepted, rather than
 * silently reintroducing it.
 *
 * PINNED RECALL GAPS (measured, never a false-bless; each is a route this
 * module will not find rather than one it misclassifies):
 *   - Gorilla mux route-builder chains (`r.Methods("POST").Path("/x").
 *     HandlerFunc(h)`): no verb-selector field, out of scope until a later
 *     task builds the chain-resolution machinery noted in grammar trap 4.
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
 * OPEN QUESTIONS FOR SIGN-OFF (deliberate divergences the eventual full
 * module will carry; most are not reachable from Task 1's code, since this
 * task only recognizes routes and never resolves methods, auth, or
 * middleware scope; named here as a preview so each lands as an explicit,
 * reviewed decision rather than an implicit one when its owning task ships):
 *   - ALL-on-unresolvable methods (Task 2): a Go 1.22 pattern string or a
 *     `Handle`/`HandleFunc` call whose method cannot be read statically
 *     resolves to "ALL" rather than defaulting to GET, mirroring the
 *     Python module's `methods=` divergence, so the route stays in the
 *     mutating vote instead of silently dropping out of it.
 *   - HEAD/OPTIONS exclusion (this task, and carried through chain,
 *     verb-first, and Go 1.22 forms in later tasks): neither verb is ever
 *     mutating, so omitting them from `VERB_FIELDS` is bless-safe by
 *     construction, mirroring Phase A's exclusion of `@router.websocket`.
 *   - Dropped in-body validation scanning, position-aware `Use` resolution,
 *     conditional-`Use` skip, config-not-vetoed, and an extended veto set
 *     (Task 4 middleware scope): none of this module's Task-1 code reads
 *     middleware at all yet.
 *   - Arity-1 wrap recursion and pure-selector name resolution for auth
 *     helpers (Task 3): out of scope; `hasAuth` is unconditionally false.
 *   - Segment-matched validation/rate-limit lanes (Task 4): out of scope;
 *     `hasValidation`/`hasRateLimit` are unconditionally false.
 *
 * Route-registration scope for THIS task: Gin/Echo/chi verb-selector calls
 * (`GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`Any`) on a structurally- or
 * conventionally-resolved receiver, plus chi's `With(...)` chain receiver
 * (auth recognition on the `With` argument is Task 3) and `Route(...)`
 * closure-parameter routers. `Handle`/`HandleFunc`, Gorilla `Methods()`
 * chains, and Go 1.22 verb-in-string patterns are Task 2.
 */

import type { Tree, SyntaxNode } from "../core/types.js";
import type { RouteInfo, FileMiddleware } from "./security-consistency.js";

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
// Verbs a resolved route may carry (VERB_FIELDS' values, plus the ALL
// sentinel ANY_FIELDS resolves to). HEAD and OPTIONS are deliberately absent:
// neither is ever mutating, so their exclusion can only under-report, never
// bless (see the OPEN QUESTIONS block above).
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"]);
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
  VERB_FIELDS, ANY_FIELDS, HTTP_VERBS, MUTATING_VERBS,
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

export function extractGoRoutesAst(tree: Tree, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const routerNames = collectGoRouterNames(tree.rootNode);
  const gated = (r: string | null): r is string =>
    r !== null && (routerNames.has(r) || GO_ROUTER_RECEIVER.test(r));

  for (const call of tree.rootNode.descendantsOfType("call_expression")) {
    if (!call || inErroredContext(call)) continue;
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "selector_expression") continue;
    const field = fn.childForFieldName("field")?.text ?? "";
    const verb = VERB_FIELDS.get(field) ?? (ANY_FIELDS.has(field) ? "ALL" : null);
    if (verb === null) continue;
    const receiver = goReceiverName(fn.childForFieldName("operand"));
    if (!gated(receiver)) continue;
    const args = call.childForFieldName("arguments");
    if (!args) continue;
    const named = args.namedChildren.filter((n): n is SyntaxNode => n !== null);
    const path = named.length > 0 ? goStringText(named[0]) : null;
    if (path === null || !path.startsWith("/")) continue; // leading-slash gate
    routes.push({
      method: verb,
      path,
      file: filePath,
      // 1-based, the registration call's OWN first row (= the chain start for
      // fluent forms): the @vibedrift-public suppression binding depends on it.
      line: call.startPosition.row + 1,
      hasAuth: false,        // Task 3 (per-route) + Task 4 (scope inheritance)
      hasValidation: false,
      hasRateLimit: false,
      hasErrorHandler: false, // write-only field; JS and Python AST hard-code false
    });
  }
  return routes;
}
