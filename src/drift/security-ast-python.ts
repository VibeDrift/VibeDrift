/**
 * AST-based route extraction for Python (Flask, FastAPI), used by
 * security-consistency.ts in place of the regex line-window extractor
 * whenever a parsed tree is available and clean. Mirrors the shipped JS/TS
 * design in src/drift/security-ast.ts.
 *
 * A find-replace port from that file fails silently on four Python grammar
 * traps:
 *   1. Node names differ: a Python call is `call`, not `call_expression`;
 *      a Python member access is `attribute`, not `member_expression`.
 *      Both JS names are simply absent from the Python grammar.
 *   2. The member-name field on `attribute` is called `attribute`, not
 *      `property`.
 *   3. String prefixes (`f"`, `r"`, `"""`) live in the `string_start` token,
 *      not a fixed one-character slice; `text.slice(1, -1)` corrupts
 *      f-strings, raw strings, and triple-quoted strings.
 *   4. `typed_parameter` (an `Annotated[...]` parameter) has NO `name`
 *      field; the name is `namedChild(0)`.
 *
 * INVARIANT SCOPE: the never-false-bless guarantee (never mark an unauthed
 * route as authed) holds on THIS AST path only. A file with a parse error
 * anywhere (`tree.rootNode.hasError`) is routed whole to the existing regex
 * extractor, which keeps its legacy over-blesses (the 30-line token/
 * permission window and the file-level login_required bless) unchanged.
 *
 * OPEN QUESTION FOR SIGN-OFF: `resolveMethod`'s handling of a Flask `methods=`
 * kwarg that is not a statically readable list/tuple/set of string literals
 * deliberately diverges from the regex extractor. The regex silently defaults
 * such a route to GET, which excludes it from the mutating vote. This AST
 * path instead resolves it to "ALL", which keeps the route IN the mutating
 * vote (matching how an Express `.all()` route is treated). This is a real,
 * user-visible behavior change from today's regex path, not a bug fix; it is
 * called out here for explicit sign-off rather than shipped silently.
 *
 * UPGRADE 2 (Task 3) partially resolves this divergence: `methods=VAR` now
 * reads through VAR's value when, and ONLY when, VAR is written EXACTLY ONCE,
 * at module top level, to a literal list/tuple/set of string verbs
 * (`collectMethodsVars`, mirroring `collectRouterNames`'s same flat, no-scope
 * census). That resolved literal is reduced by the SAME `methodFromLiteral`
 * helper the inline `methods=[...]` path already used, so a same-file
 * `ALLOWED = ["GET", "POST"]` behaves identically to an inline
 * `methods=["GET", "POST"]`. Every other shape of `methods=VAR` still resolves
 * "ALL", never a silent GET: an identifier with no same-file assignment
 * (imported, or an alias chain `B = A` — the census refuses to chase an
 * identifier RHS), a computed value (`BASE + EXTRA`, a `binary_operator`, or a
 * call), a `**kwargs` splat, a `*splat` with no visible literal verb, a
 * variable written more than once at top level, a variable written inside a
 * conditional or a function body (not an UNCONDITIONAL same-file literal), or
 * a variable written through any poisoned form the census cannot safely read
 * through: an augmented assignment (`X += ...`), a mutating attribute call
 * (`X.append(...)`), a `global X` statement, a walrus write, a for-loop
 * target, a subscript/slice-target assignment (`X[:] = ...`, `X[0] = ...`),
 * or a `with ... as X:` binding. When in doubt, the census leaves the name
 * out of its map and `resolveMethod` falls through to "ALL" — the
 * false-negative direction (never GET-dropping a route out of the mutating
 * vote) always wins over precision.
 *
 * `asApiViewDecorator` follows the SAME ALL-on-unresolvable convention for its
 * own unresolvable forms, but is DELIBERATELY NOT extended by Upgrade 2: an
 * `@api_view([METHOD])` / `@api_view([*BASE])` / `@api_view(METHODS)` list
 * whose only verbs are hidden behind a variable resolves to "ALL", not GET,
 * even when that variable has a same-file literal assignment. Upgrade 2 names
 * the Flask `methods=` kwarg only; widening it to api_view's positional list
 * argument is a separate, unapproved change.
 *
 * DJANGO REST SCOPE (best-effort, function views only): `@api_view(["POST"])`
 * routes are recognized; the URL lives in `urls.py` and cross-file resolution
 * is an explicit non-goal, so the path is synthesized as `"/" + handler name`.
 * Class-based `APIView`/`ViewSet` and `urls.py` `path(...)` registrations emit
 * ZERO routes in Sub-Phase A. DRF settings-level default permissions are
 * unknowable statically and never bless.
 */

import type { Tree, SyntaxNode } from "../core/types.js";
import type { RouteInfo, FileMiddleware } from "./security-consistency.js";
import type { CrossFileIndex } from "./security-xfile-index.js";
import { resolvePyHookBody } from "./security-xfile-index.js";

/** Three-way verdict for a before_request-style hook. `unsure` never blesses
 *  (hasAuth stays false); it only hedges the finding copy so the user is told
 *  exactly which hook to double-check. */
export type HookAuthOutcome = "auth" | "not-auth" | "unsure";
/** Behavior a hook BODY exhibits: a verified auth rejection (`reject`), a fully
 *  visible non-enforcing body (`none`), or auth-flavored behavior we cannot
 *  statically verify (`opaque`). */
export type BodySignal = "reject" | "none" | "opaque";

// Route-registration attribute names on a router-like receiver.
const ROUTE_METHODS = new Set(["route", "get", "post", "put", "patch", "delete", "api_route"]);
// Verbs a methods=[...] kwarg may contribute (same set the regex extractor accepts).
const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const MUTATING_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Receivers that plausibly register routes. Python conventions differ from JS:
// Flask blueprints are *_bp / *_blueprint, FastAPI routers *_router, versioned
// registrars v1 / api_v1. ASCII only (a unicode receiver is a recognition miss,
// never a bless). This is the NAME-CONVENTION FALLBACK only: receivers are first
// resolved STRUCTURALLY via ROUTER_CONSTRUCTORS below, so bare-name blueprints
// (main, auth, admin: the flasky layout) extract whenever their constructor is
// visible in the file.
const ROUTER_RECEIVER =
  /^(?:app|application|server|router|api|bp|blueprint|v\d+|api_v\d+|[a-z][a-z0-9_]*_(?:bp|blueprint|router|api))$/;
// Structural receiver resolution: any identifier assigned from one of these
// constructors ANYWHERE in the file is a route receiver regardless of spelling
// (main = Blueprint("main", __name__) makes @main.route extractable, matching the
// shipped regex's recall on bare names). Imported receivers whose name also misses
// ROUTER_RECEIVER remain a documented recall gap, measured in Task 7 (S0) and
// whole-phase gate item 7.
const ROUTER_CONSTRUCTORS = new Set(["Blueprint", "APIRouter", "Flask", "FastAPI"]);
// Auth decorators, matched by EXACT final name segment (never substring, so
// @author_stats can never match). Flask-Login, flask-jwt-extended, flask-httpauth,
// Django, DRF, and common custom names. Bare "requires" is deliberately NOT here:
// it is a generic English verb whose final-segment match collides with
// feature-flag / DI / marker decorators (@feature.requires("new_ui"),
// @pytest.mark.requires). The bare-identifier call form @requires("admin") is
// special-cased in isAuthDecorator; @anything.requires never matches.
const AUTH_DECORATORS = new Set([
  "login_required", "fresh_login_required", "jwt_required", "token_required",
  "auth_required", "requires_auth", "require_auth", "permission_required",
  "roles_required", "roles_accepted", "admin_required", "staff_required",
  "superuser_required", "verify_token", "authenticated",
]);
// FastAPI Depends(...)/Security(...) auth recognition is SEGMENT-based, applied to
// the dependency's RESOLVED NAME only (identifier, dotted attribute, or a class
// dependency's callee: Depends(JWTBearer())), never to raw expression text. The
// name is split on underscore AND CamelCase boundaries (nameSegments), lowercased,
// then:
//   hit  = any single segment in DEPENDS_AUTH_SEGMENTS, or any ADJACENT segment
//          pair in DEPENDS_AUTH_PAIRS. Whole segments make substring blessing
//          structurally impossible: get_author_stats is [get, author, stats] and
//          "author" is not "auth"; JWTBearer is [jwt, bearer] and hits.
//   veto = any segment in DEPENDS_VETO_SEGMENTS cancels a hit and resolves FALSE:
//          optional-auth dependencies (get_current_user_optional,
//          get_current_user_or_none) admit anonymous requests, and settings /
//          config / stats / url dependencies (get_jwt_settings,
//          get_api_key_usage_stats) are not auth enforcement. Ambiguity resolves
//          to false, per the invariant.
const DEPENDS_AUTH_SEGMENTS = new Set([
  "auth", "authenticate", "authenticated", "jwt", "oauth", "oauth2", "bearer",
]);
const DEPENDS_AUTH_PAIRS = new Set([
  "current user", "active user", "api key", "verify token", "validate token",
  "require auth", "requires auth", "require admin", "require user", "require login",
  "auth required", "check auth", "logged in",
]);
const DEPENDS_VETO_SEGMENTS = new Set([
  "optional", "maybe", "anonymous", "none", "settings", "setting", "config",
  "params", "options", "url", "urls", "stats", "metrics", "usage",
]);
const VAL_NAMES = /(?:pydantic|validate|validator|schema|serializer|marshmallow)/i;
const RATE_NAMES = /(?:rate_?limit|throttle|limiter|slowapi|slowdown)/i;

// Two-tier segment lexicon for before_request / before_app_request HOOK HANDLER
// names (see nameHasAuthToken). tier 1: a CORE segment alone (an unambiguous
// authn word). tier 2: an ENFORCEMENT verb segment AND a SUBJECT segment anywhere
// in the name. A lone SUBJECT (login / token / user) or a lone ENFORCE verb is
// never a token: track_login_metrics, verify_content_type, and set_csrf_token are
// real hooks that do not authenticate. Whole-segment matching makes substring
// blessing structurally impossible.
//
// BODY-FIRST (addendum): the hook path no longer blesses on NAME alone.
// classifyHookAuth classifies by BODY behavior first; a name token only ever acts
// as a SECOND tier, and only when the body is UNRESOLVABLE (opaque). A CORE token
// (auth/authenticate, or an AUTH_DECORATORS name) with an opaque body blesses; an
// ENFORCE+SUBJECT token (verify_user_email, protect_user_data, enforce_session)
// with an opaque/absent body resolves UNSURE (a hedge, never a bless), and with a
// VISIBLE non-enforcing body resolves flat not-auth. So the old ENFORCE+SUBJECT
// attributive false-bless is closed: those names can hedge, never bless, and a
// visible email/scrub body is plainly not-auth. (verify_token also appears in
// AUTH_DECORATORS as a ROUTE decorator, unaffected here.)
const AUTH_CORE_SEGMENTS = new Set(["auth", "authenticate", "authenticated"]);
const AUTH_ENFORCE_SEGMENTS = new Set([
  "require", "required", "requires", "verify", "verified", "ensure",
  "protect", "protected", "restrict", "restricted",
]);
const AUTH_SUBJECT_SEGMENTS = new Set([
  "login", "token", "user", "users", "session", "jwt", "permission",
  "permissions", "role", "roles", "admin", "credentials",
]);
// Optionality-flavored veto, the subset of DEPENDS_VETO_SEGMENTS that signals an
// auth check which ADMITS unauthenticated requests. Applied to before_request
// HOOK names (nameHasAuthToken) and add_middleware CLASS names so an
// optional_authenticate hook or an OptionalAuthMiddleware never blesses, exactly
// as Depends(optional_auth) already does not. Only the optionality members are
// carried here: the settings/config/stats/url vetoes are Depends-argument-shape
// specific and do not generalize to hook/middleware names.
const OPTIONAL_AUTH_VETO = new Set(["optional", "maybe", "anonymous", "none"]);
// Middleware CLASS-NAME auth segments for app.add_middleware(X). Matched by WHOLE
// CamelCase/underscore segment on the class name ONLY (never the whole arg text):
// AuthMiddleware and AuthenticationMiddleware bless, AuthorTrackingMiddleware does
// not (the segment "author" is not "auth"). Same discipline as the decorators and
// Depends targets.
const MIDDLEWARE_AUTH_SEGMENTS = new Set([
  "auth", "authentication", "authenticate", "authenticated", "jwt", "oauth", "oauth2", "bearer",
]);
// DRF @permission_classes([...]) EXACT class names that unconditionally require
// an authenticated request: IsAuthenticated, and IsAdminUser (requires
// request.user.is_staff, which implies an authenticated user — admin is a
// strict subset of authed, so recognizing it carries zero false-bless risk).
// Deliberately narrow otherwise: AllowAny never requires auth;
// IsAuthenticatedOrReadOnly and DjangoModelPermissionsOrAnonReadOnly only require
// auth for unsafe (write) methods, which is a per-method condition this
// route-level check cannot statically resolve, so they are NOT here; any other
// built-in or custom permission class is unrecognized. Per the never-false-bless
// invariant, ambiguity and the unrecognized case both resolve to false.
const PERMISSION_AUTH = new Set(["IsAuthenticated", "IsAdminUser"]);

// ─── Body-signature lexicons (addendum: hook body classification) ────────────
// Rejection statuses that mean "request denied for identity reasons".
// ASYMMETRIC by status (never-false-bless): 401 Unauthorized is specifically an
// AUTHENTICATION denial and reject-blesses ALONE. 403 Forbidden is routinely
// raised for NON-authentication reasons (CSRF token failure, IP allowlist,
// maintenance/feature gate, generic authorization policy), so a bare
// abort(403)/HTTPException(403) blesses ONLY inside a reject whose GUARD CONDITION
// structurally reads a credential surface (`if "user_id" not in session:
// abort(403)`), via guardConditionHasCredentialRead. A lone or otherwise-guarded
// 403 contributes NOTHING to the signal set (not reject, not opaqueHint): the body
// resolves "none" -> flat not-auth for a boring name, so csrf_protect /
// maintenance_gate neither bless (a false-bless the name-only path never had) nor
// pollute the hedge with obvious non-auth hooks. The 401/403 asymmetry is enforced
// directly in scanBody (abort/HTTPException/return branches), not via a lookup set.
const REJECT_STATUSES = new Set(["401", "403"]);
// raise <X> auth-exception matching: an ALONE segment (unauthorized/forbidden),
// or a TOPIC segment paired anywhere with a KIND segment (AuthenticationError,
// PermissionDenied). raise ValueError / KeyError / NotFound never match.
const AUTH_EXCEPTION_ALONE = new Set(["unauthorized", "forbidden"]);
const AUTH_EXCEPTION_TOPIC = new Set(["auth", "authentication", "permission", "credentials"]);
const AUTH_EXCEPTION_KIND = new Set(["error", "exception", "denied", "failed", "required"]);
// Login-flavored redirect target segments; only these bless a redirect reject.
const LOGIN_REDIRECT_SEGMENTS = new Set(["login", "signin", "signon", "auth"]);
// Calls that enforce auth by raising internally; bless with no visible reject,
// but ONLY with an EMPTY argument_list. A non-empty form
// (verify_jwt_in_request(optional=True), which ADMITS anonymous requests) is
// treated as an opaque-hint call, never a reject (mirrors the decorator twin
// @jwt_required(optional=True)).
const KNOWN_AUTH_PRIMITIVES = new Set(["verify_jwt_in_request"]);
// Segments that make an UNRESOLVABLE callee auth-flavored enough that "we cannot
// see what this call does" resolves UNSURE, not confident not-auth. CORE +
// SUBJECT + ENFORCE, plus check/confirm/guard. Widening this set can only widen
// UNSURE (hedged copy), never a bless.
const OPAQUE_AUTH_HINT_SEGMENTS = new Set([
  ...AUTH_CORE_SEGMENTS, ...AUTH_SUBJECT_SEGMENTS, ...AUTH_ENFORCE_SEGMENTS,
  "check", "confirm", "guard",
]);
// Keys/attributes whose read marks a credential surface (gates the session/
// cookie/header read shapes so session.get("locale") stays boring).
const CREDENTIAL_KEY_SEGMENTS = new Set([
  "user", "uid", "token", "jwt", "auth", "authorization", "login", "credentials",
]);

export const SECURITY_AST_PY = {
  ROUTE_METHODS, HTTP_VERBS, MUTATING_VERBS, ROUTER_RECEIVER, ROUTER_CONSTRUCTORS,
  AUTH_DECORATORS, DEPENDS_AUTH_SEGMENTS, DEPENDS_AUTH_PAIRS, DEPENDS_VETO_SEGMENTS,
  VAL_NAMES, RATE_NAMES, AUTH_CORE_SEGMENTS, AUTH_ENFORCE_SEGMENTS,
  AUTH_SUBJECT_SEGMENTS, OPTIONAL_AUTH_VETO, MIDDLEWARE_AUTH_SEGMENTS, PERMISSION_AUTH,
  REJECT_STATUSES, AUTH_EXCEPTION_ALONE, AUTH_EXCEPTION_TOPIC,
  AUTH_EXCEPTION_KIND, LOGIN_REDIRECT_SEGMENTS, KNOWN_AUTH_PRIMITIVES,
  OPAQUE_AUTH_HINT_SEGMENTS, CREDENTIAL_KEY_SEGMENTS,
};

/** Value of a Python string-ish path argument with quotes AND prefixes stripped.
 *  - string: node.text minus string_start/string_end token lengths (handles plain,
 *    raw, f-strings, triple quotes). Interpolation braces survive in .text, so an
 *    f-string whose FIRST piece is dynamic yields a value starting "{" and fails
 *    the caller's leading-slash gate naturally.
 *  - concatenated_string ("/api" "/x"): joined values of its string children.
 *  - anything else (binary_operator, identifier): null (statically unresolvable;
 *    the route is skipped: a miss is safe, a guessed path is not). */
function pyStringText(node: SyntaxNode): string | null {
  if (node.type === "concatenated_string") {
    const parts = node.namedChildren
      .filter((n): n is SyntaxNode => n !== null && n.type === "string")
      .map(pyStringText);
    if (parts.length === 0 || parts.some((p) => p === null)) return null;
    return parts.join("");
  }
  if (node.type !== "string") return null;
  const named = node.namedChildren.filter((n): n is SyntaxNode => n !== null);
  const start = named.find((n) => n.type === "string_start");
  const end = named.find((n) => n.type === "string_end");
  if (!start || !end) return null;
  return node.text.slice(start.text.length, node.text.length - end.text.length);
}

/** Receiver identifier of `X.method(...)`: "app" for app.route, and the NEAREST
 *  attribute name for nested receivers (self.app.route resolves to "app"),
 *  mirroring the JS receiverName. */
function receiverName(objNode: SyntaxNode | null): string | null {
  if (!objNode) return null;
  if (objNode.type === "identifier") return objNode.text;
  if (objNode.type === "attribute") return objNode.childForFieldName("attribute")?.text ?? null;
  return null;
}

/** Path from the first positional string arg, or the path= kwarg when no positional
 *  string leads (FastAPI allows @router.post(path="/items")). */
function routePath(argList: SyntaxNode): string | null {
  const named = argList.namedChildren.filter((n): n is SyntaxNode => n !== null);
  const first = named[0];
  if (first && (first.type === "string" || first.type === "concatenated_string")) {
    return pyStringText(first);
  }
  const pathKw = named.find(
    (n) => n.type === "keyword_argument" && n.childForFieldName("name")?.text === "path",
  );
  const value = pathKw?.childForFieldName("value");
  return value && (value.type === "string" || value.type === "concatenated_string")
    ? pyStringText(value)
    : null;
}

interface PyRoute { method: string; path: string; call: SyntaxNode; receiver: string; }

/** Identifiers assigned (anywhere in the file) from a router constructor:
 *  main = Blueprint("main", __name__), router = APIRouter(), app = Flask(__name__).
 *  Structural resolution first, spelling-convention fallback second: bare-name
 *  blueprints (main/auth/admin, the flasky layout the shipped regex extracts)
 *  must not silently drop out of the vote because their name misses
 *  ROUTER_RECEIVER. */
function collectRouterNames(root: SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (const asn of root.descendantsOfType("assignment")) {
    if (!asn) continue;
    const left = asn.childForFieldName("left");
    const right = asn.childForFieldName("right");
    if (!left || left.type !== "identifier" || !right || right.type !== "call") continue;
    const fn = right.childForFieldName("function");
    if (fn && fn.type === "identifier" && ROUTER_CONSTRUCTORS.has(fn.text)) names.add(left.text);
  }
  return names;
}

/** Reduces a `list`/`tuple`/`set` literal node to its resolved method: the
 *  mutating verb when one is present, else the first recognized verb, else
 *  GET for a fully visible literal (including an empty one — Flask's own
 *  default), or "ALL" when a non-string element (`*splat`, a bare variable
 *  entry) hides a possible verb. Shared by `resolveMethod`'s `methods=` kwarg
 *  (inline literal AND same-file-resolved variable) and
 *  `asApiViewDecorator`'s `@api_view([...])` list: same literal shape, same
 *  reduction rules, one implementation. */
function methodFromLiteral(value: SyntaxNode): string {
  const children = value.namedChildren.filter((n): n is SyntaxNode => n !== null);
  const verbs = children
    .filter((n) => n.type === "string")
    .map((s) => (pyStringText(s) ?? "").toUpperCase())
    .filter((v) => HTTP_VERBS.has(v));
  const hidden = children.some((n) => n.type !== "string");
  if (verbs.length === 0) return hidden ? "ALL" : "GET"; // [*BASE] vs literal []
  return verbs.find((v) => MUTATING_VERBS.has(v)) ?? verbs[0];
}

/** `node` itself when it IS an `identifier`, else every `identifier`
 *  descendant — covers pattern-unpack targets (`x, ALLOWED = pair`,
 *  `for a, ALLOWED in pairs:`) without needing to special-case
 *  `pattern_list`/`tuple_pattern` shapes individually. */
function identifiersIn(node: SyntaxNode): SyntaxNode[] {
  if (node.type === "identifier") return [node];
  return node.descendantsOfType("identifier").filter((n): n is SyntaxNode => n !== null);
}

/** True when `asn` (an `assignment` node) is a direct module-level statement:
 *  its parent (`expression_statement`) is itself a direct child of `root`. A
 *  write nested inside an `if`/`for`/`while`/`try`/`with`/function/class body
 *  is NOT an unconditional same-file literal — resolving it could pick a
 *  value that only sometimes runs (the conditional case) or a value scoped to
 *  a function that never reaches the module binding at all (the def-local
 *  case) — so it must never become a resolvable methods= candidate. */
function isTopLevelAssignment(asn: SyntaxNode, root: SyntaxNode): boolean {
  const stmt = asn.parent;
  return stmt !== null && stmt.parent !== null && stmt.parent.id === root.id;
}

/** True when `node` sits inside a `function_definition` / `lambda` body anywhere
 *  up to `root`. A variable local to a function is a DIFFERENT binding from the
 *  module-level name, so a def-local write must not count toward the module
 *  name's write census (preserving def-local precision). A write merely nested in
 *  a module-scope `if`/`try`/`with`/`for` is NOT excluded — it rebinds the same
 *  module name and so DOES count. */
function isInsideFunctionBody(node: SyntaxNode, root: SyntaxNode): boolean {
  let p = node.parent;
  while (p !== null && p.id !== root.id) {
    if (p.type === "function_definition" || p.type === "lambda") return true;
    p = p.parent;
  }
  return false;
}

/** Names written through a form the census cannot safely read a single value
 *  through, ANYWHERE in the file (no scope analysis, mirroring
 *  collectRouterNames's flat census): an augmented assignment (`X += ...`), a
 *  subscript/slice-target assignment (`X[:] = ...`, `X[0] = ...`), a
 *  tuple/pattern-unpack assignment target (`x, X = pair`), a `global X`
 *  statement, a walrus write (`X := ...`), a for-loop target (`for X in
 *  ...:`), a `with ... as X:` binding, or a mutating attribute call on the
 *  identifier (`X.append(...)`, `X.<anything>(...)`). A name in this set can
 *  never resolve through collectMethodsVars, however many literal assignments
 *  it also has — a write ANYWHERE in the file only ever ADDS poisoning, never
 *  removes it, so this can only over-poison (stay "ALL"), never under-poison
 *  into a false GET-drop. */
function collectPoisonedMethodsNames(root: SyntaxNode): Set<string> {
  const poisoned = new Set<string>();
  const add = (n: SyntaxNode | null) => {
    if (n && n.type === "identifier") poisoned.add(n.text);
  };
  for (const asn of root.descendantsOfType("augmented_assignment")) {
    if (!asn) continue;
    const left = asn.childForFieldName("left");
    if (left) identifiersIn(left).forEach(add);
  }
  for (const asn of root.descendantsOfType("assignment")) {
    if (!asn) continue;
    const left = asn.childForFieldName("left");
    if (!left) continue;
    if (left.type === "subscript") {
      add(left.childForFieldName("value")); // ALLOWED[:] = ... / ALLOWED[0] = ...
    } else if (left.type !== "identifier") {
      identifiersIn(left).forEach(add); // pattern_list unpack: x, ALLOWED = pair
    }
  }
  for (const gs of root.descendantsOfType("global_statement")) {
    if (!gs) continue;
    gs.namedChildren.forEach(add);
  }
  for (const ne of root.descendantsOfType("named_expression")) {
    if (!ne) continue;
    add(ne.childForFieldName("name")); // walrus: (ALLOWED := ...)
  }
  for (const fs of root.descendantsOfType("for_statement")) {
    if (!fs) continue;
    const left = fs.childForFieldName("left");
    if (left) identifiersIn(left).forEach(add);
  }
  for (const wi of root.descendantsOfType("with_item")) {
    if (!wi) continue;
    const value = wi.childForFieldName("value");
    if (value && value.type === "as_pattern") {
      const alias = value.childForFieldName("alias"); // with ... as ALLOWED:
      if (alias) identifiersIn(alias).forEach(add);
    }
  }
  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (fn && fn.type === "attribute") add(fn.childForFieldName("object")); // ALLOWED.append(...)
  }
  return poisoned;
}

/** Identifiers assigned, at MODULE TOP LEVEL, to a single unambiguous
 *  `list`/`tuple`/`set` literal of string verbs — the value a Flask
 *  `methods=` kwarg may safely resolve through (Upgrade 2). Mirrors
 *  collectRouterNames's flat census: MULTIPLE module-scope writes to the same
 *  name make its value ambiguous, where a write is counted at ANY module-scope
 *  DEPTH (a top-level assignment AND a nested `if F: ALLOWED = [...]` / try-block
 *  rebind both count — any RHS shape, not only a literal), so a nested reassign
 *  poisons rather than silently vanishing. Only a def-local write (a different
 *  binding) is excluded from the count. Any poisoned write form
 *  (collectPoisonedMethodsNames) disqualifies the name regardless of how many
 *  literal assignments exist; the single RECORDED literal must still be
 *  top-level. A name that is imported, computed, an identifier alias (`B = A`:
 *  the census refuses to chase an identifier RHS), written more than once at
 *  module scope, written only conditionally/def-locally, or poisoned is simply
 *  ABSENT from the returned map — `resolveMethod` then falls through to "ALL",
 *  never a silent GET. */
function collectMethodsVars(root: SyntaxNode): Map<string, SyntaxNode> {
  const writeCounts = new Map<string, number>();
  const literalByName = new Map<string, SyntaxNode>();
  for (const asn of root.descendantsOfType("assignment")) {
    if (!asn) continue;
    const left = asn.childForFieldName("left");
    if (!left || left.type !== "identifier") continue; // subscript/pattern_list: no plain-name write
    if (isInsideFunctionBody(asn, root)) continue; // def-local: a different binding
    const name = left.text;
    // Count identifier-left writes at ANY module-scope depth: a nested reassign
    // (`if F: ALLOWED = [...]`, a try-block rebind) is a SECOND write that
    // POISONS the name (writeCounts > 1 -> unresolvable -> ALL), never an
    // invisible one that silently GET-drops the route. A nested write MUST NOT be
    // skipped before it is counted (the original bug).
    writeCounts.set(name, (writeCounts.get(name) ?? 0) + 1);
    const right = asn.childForFieldName("right");
    // Only a TOP-LEVEL literal is a safe single value to read through; a nested
    // literal only sometimes runs, so it is never the RECORDED value even though
    // the write above still counts toward poisoning.
    if (isTopLevelAssignment(asn, root) && right && ["list", "tuple", "set"].includes(right.type)) {
      literalByName.set(name, right);
    }
  }
  const poisoned = collectPoisonedMethodsNames(root);
  const resolved = new Map<string, SyntaxNode>();
  for (const [name, node] of literalByName) {
    if (writeCounts.get(name) === 1 && !poisoned.has(name)) resolved.set(name, node);
  }
  return resolved;
}

function asRouteDecorator(
  dec: SyntaxNode,
  routerNames: Set<string>,
  methodsVars: Map<string, SyntaxNode>,
): PyRoute | null {
  const expr = dec.namedChild(0);
  if (!expr || expr.type !== "call") return null;
  const fn = expr.childForFieldName("function");
  const args = expr.childForFieldName("arguments");
  // Identifier callees (@api_view) get their own branch in Task 5; the receiver
  // gate below applies only to app/router-style attribute callees.
  if (!fn || !args || fn.type !== "attribute") return null;
  const attr = fn.childForFieldName("attribute")?.text ?? "";
  if (!ROUTE_METHODS.has(attr)) return null;
  const receiver = receiverName(fn.childForFieldName("object"));
  if (!receiver || !(routerNames.has(receiver) || ROUTER_RECEIVER.test(receiver))) return null;
  const path = routePath(args);
  if (path === null || !path.startsWith("/")) return null; // leading-slash gate, same as JS
  return { method: resolveMethod(attr, args, methodsVars), path, call: expr, receiver };
}

/** Resolves the HTTP method(s) a route decorator registers.
 *
 *  Verb-shorthand decorators (`@app.post`, `@app.delete`, ...) are unambiguous:
 *  the attribute name IS the method. Only `route`/`api_route` need a `methods=`
 *  kwarg read.
 *
 *  DELIBERATE DIVERGENCE from the regex extractor: the regex silently defaults
 *  to GET whenever `methods=` isn't a literal list it can pattern-match (a
 *  variable, a set, a splat), which quietly excludes that route from the
 *  mutating vote. This AST path instead emits "ALL" for every statically
 *  unresolvable form (**kwargs splat, a *splat with no visible literal verb,
 *  or a methods= variable that Upgrade 2's same-file census cannot safely
 *  resolve — see `collectMethodsVars`), so the route STAYS in the mutating
 *  vote ("ALL" is a member of both MUTATION_METHODS and BODY_METHODS), the
 *  same way Express's `.all()` is treated. This is a real behavior change
 *  from the regex path and is flagged as an open question for sign-off, not a
 *  silent fix.
 *
 *  A fully visible, empty `methods=[]` is NOT ambiguous: Flask's own default is
 *  GET, so an empty literal resolves to GET rather than ALL. */
function resolveMethod(attr: string, args: SyntaxNode, methodsVars: Map<string, SyntaxNode>): string {
  if (attr !== "route" && attr !== "api_route") return attr.toUpperCase();
  const named = args.namedChildren.filter((n): n is SyntaxNode => n !== null);
  const kw = named.find(
    (n) => n.type === "keyword_argument" && n.childForFieldName("name")?.text === "methods",
  );
  if (!kw) {
    // No methods kwarg. A **splat may hide one: statically unresolvable, so the
    // route must STAY in the mutating vote ("ALL" is in MUTATION_METHODS and
    // BODY_METHODS). Silently defaulting GET would drop an unknown-verb route
    // out of the auth vote, which is the bless-adjacent direction the
    // never-false-bless invariant forbids.
    const hasSplat = named.some((n) => n.type.endsWith("splat"));
    return hasSplat ? "ALL" : "GET";
  }
  const value = kw.childForFieldName("value");
  if (!value || !["list", "tuple", "set"].includes(value.type)) {
    // methods=VARIABLE: resolve through a same-file single-literal assignment
    // (Upgrade 2) when one exists; every other shape (computed, imported,
    // reassigned, mutated, an identifier alias chain — refuse to chase) stays
    // "ALL", never a silent GET.
    if (value?.type === "identifier") {
      const literal = methodsVars.get(value.text);
      if (literal) return methodFromLiteral(literal);
    }
    return "ALL"; // methods=VARIABLE, computed, imported, reassigned, or mutated
  }
  return methodFromLiteral(value);
}

/** Django REST function views: @api_view(["POST"]). Identifier callee, NOT an
 *  attribute, so the router-receiver gate does not apply here. Path is
 *  synthesized from the handler name (urls.py resolution is a non-goal). */
function asApiViewDecorator(dec: SyntaxNode, definition: SyntaxNode): PyRoute | null {
  const expr = dec.namedChild(0);
  if (!expr || expr.type !== "call") return null;
  const fn = expr.childForFieldName("function");
  if (!fn || fn.type !== "identifier" || fn.text !== "api_view") return null;
  const fnName = definition.childForFieldName("name")?.text;
  if (!fnName) return null;
  const list = expr.childForFieldName("arguments")?.namedChild(0);
  let method = "GET"; // DRF default when @api_view() has no args
  if (list && ["list", "tuple", "set"].includes(list.type)) {
    // Reduced by the SAME methodFromLiteral helper resolveMethod's methods=
    // kwarg uses: a non-string element (a variable verb: @api_view([METHOD])
    // or @api_view([*BASE])) is statically unresolvable and resolves ALL so
    // the route STAYS in the mutating vote rather than silently defaulting
    // GET; a visible literal still resolves it normally.
    method = methodFromLiteral(list);
  } else if (list) {
    // verbs behind a bare variable (@api_view(METHODS)): stays ALL. Unlike
    // resolveMethod's methods= kwarg, this is NOT extended by Upgrade 2 even
    // when METHODS has a same-file literal assignment — a deliberate boundary
    // (see the header OPEN QUESTION): the approved upgrade names methods=
    // only, not api_view's positional list argument.
    method = "ALL";
  }
  // No receiver: DRF function views register via urls.py, not on a router
  // variable. The empty string matches no byReceiver scope, so only global
  // (app-scoped) middleware can ever inherit onto these routes.
  return { method, path: `/${fnName}`, call: expr, receiver: "" };
}

/** @permission_classes([IsAuthenticated]) as a POSITIONAL auth decorator.
 *  AllowAny, an empty list, or an unrecognized class resolves false. Position
 *  matters (DRF: it must sit BELOW @api_view or it is never enforced), so this is
 *  a per-decorator predicate feeding the same authDecoratorRows mechanism as the
 *  Flask auth decorators. */
function isAuthPermissionClasses(dec: SyntaxNode): boolean {
  const expr = dec.namedChild(0);
  if (!expr || expr.type !== "call") return false;
  const fn = expr.childForFieldName("function");
  if (!fn || fn.type !== "identifier" || fn.text !== "permission_classes") return false;
  const list = expr.childForFieldName("arguments")?.namedChild(0);
  if (!list) return false;
  const names = list.namedChildren
    .filter((n): n is SyntaxNode => n !== null)
    .map((n) => (n.type === "attribute" ? (n.childForFieldName("attribute")?.text ?? "") : n.text));
  return names.some((n) => PERMISSION_AUTH.has(n));
}

/** Final name segment of a decorator expression: "login_required" for
 *  @login_required, @auth.login_required, @flask_login.login_required. */
function decoratorName(expr: SyntaxNode): string | null {
  if (expr.type === "identifier") return expr.text;
  if (expr.type === "attribute") return expr.childForFieldName("attribute")?.text ?? null;
  return null;
}

/** Lowercase segments of an identifier, split on underscore/non-alphanumeric AND
 *  CamelCase boundaries (digits stay attached to their run):
 *  "get_author_stats" -> [get, author, stats]; "JWTBearer" -> [jwt, bearer];
 *  "OAuth2PasswordBearer" -> [o, auth2, password, bearer]. Whole-segment matching
 *  makes substring blessing structurally impossible. */
function nameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0);
}

/** Two-tier segment auth check for hook handler names (see the constants block):
 *  tier 1 = a CORE segment alone (check_auth, authenticate); tier 2 = an
 *  ENFORCEMENT verb segment plus a SUBJECT segment anywhere in the name
 *  (require_login, login_required, verify_token, ensure_user). Standalone
 *  login/token/verify segments stay FALSE: track_login_metrics,
 *  verify_content_type, and set_csrf_token are real hooks that do not
 *  authenticate. Substring blessing is structurally impossible (segments). */
function nameHasAuthToken(name: string): boolean {
  const segs = nameSegments(name);
  // Optional-auth veto first: optional_authenticate / maybe_require_login admit
  // anonymous requests, so they never bless (mirrors the Depends path).
  if (segs.some((s) => OPTIONAL_AUTH_VETO.has(s))) return false;
  if (segs.some((s) => AUTH_CORE_SEGMENTS.has(s))) return true;
  return (
    segs.some((s) => AUTH_ENFORCE_SEGMENTS.has(s)) &&
    segs.some((s) => AUTH_SUBJECT_SEGMENTS.has(s))
  );
}

// ─── Body-signature analyzer (addendum) ──────────────────────────────────────
//
// Classifies a before_request-style hook by what its BODY does, not what its
// name suggests. `bodyAuthSignature` walks the body (plus ONE hop into a
// same-file helper) and returns "reject" | "none" | "opaque"; `classifyHookAuth`
// layers name precedence on top and produces the THREE-WAY outcome
// "auth" | "not-auth" | "unsure" (an optionality-veto name always wins; otherwise
// behavior beats a name — a verified reject blesses even a boring name, a visible
// non-enforcing body is not-auth whatever the name; an opaque body hedges as
// "unsure" unless the name is an unambiguous CORE token). Wired into the hook path
// (collectPyMiddleware) for both the decorator and call-registration forms.
//
// INVARIANT AMENDMENT: "unsure" is not-authed INTERNALLY — it never sets a hasAuth
// lane, never reaches the FileMiddleware OR, and never blesses a route (hasAuth
// stays false). It only records the hook's name (RouteInfo.authUnsureHook) so a
// renderer can hedge the copy. NEVER-FALSE-BLESS holds: every ambiguous branch
// resolves toward not-authed.
//
// TWO SAFE-DIRECTION TIGHTENINGS (this addendum): (1) the body scan prunes nested
// def/lambda subtrees, so a reject that is not executed inline never counts; (2) a
// 403 blesses only inside a reject driven by a credential-referencing guard
// condition, never on body-wide co-occurrence with an unrelated credential read.
// Both move strictly toward never-false-bless.
//
// MEASURED reject-catalog recall gaps (SAFE, over-flag direction — a later pass
// may widen deliberately): reject via a Response/make_response object
// (abort(make_response(..., 401)) / abort(Response(status=401)), arg0 a call not
// an integer); Flask-Login `return login_manager.unauthorized()` (an attribute
// call outside KNOWN_AUTH_PRIMITIVES); custom auth exceptions outside the lexicon
// (raise Http401, raise NotAuthenticated); and a credential-guarded 403 reached
// only via an `elif` branch (the guard walk reads the `if` condition + its
// consequence, not the alternative). All resolve opaque/unsure or not-auth today,
// never a false-bless.

// Calls whose reject/target semantics are read in the raise/return walks (or are
// merely nested), so the generic call walk must not re-interpret them.
const CALL_HANDLED_ELSEWHERE = new Set([
  "redirect", "RedirectResponse", "url_for", "jsonify", "HTTPException",
]);

/** Final callee/exception name of a node: an identifier's text, an attribute's
 *  `attribute` field text, or (recursively) a call's function name. */
function finalName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "attribute") return node.childForFieldName("attribute")?.text ?? null;
  if (node.type === "call") return finalName(node.childForFieldName("function"));
  return null;
}

/** "401" | "403" only when `n` is exactly that integer literal; null otherwise. */
function rejectStatusKind(n: SyntaxNode | null): "401" | "403" | null {
  if (!n || n.type !== "integer") return null;
  return REJECT_STATUSES.has(n.text) ? (n.text as "401" | "403") : null;
}

/** True when an argument_list has zero named children (a bare `f()`). */
function isEmptyArgList(args: SyntaxNode | null): boolean {
  return args !== null && args.namedChildren.filter((c) => c !== null).length === 0;
}

/** True when any whole segment of `name` is an OPAQUE_AUTH_HINT_SEGMENTS member. */
function hintHit(name: string): boolean {
  return nameSegments(name).some((s) => OPAQUE_AUTH_HINT_SEGMENTS.has(s));
}

/** Auth-exception name match (raise matching): an ALONE segment, or a TOPIC
 *  segment paired anywhere in the name with a KIND segment. Whole-segment. */
function isAuthExceptionName(name: string): boolean {
  const segs = nameSegments(name);
  if (segs.some((s) => AUTH_EXCEPTION_ALONE.has(s))) return true;
  return (
    segs.some((s) => AUTH_EXCEPTION_TOPIC.has(s)) &&
    segs.some((s) => AUTH_EXCEPTION_KIND.has(s))
  );
}

/** True when a stripped string key carries a credential segment. */
function keyIsCredential(key: string | null): boolean {
  return key !== null && nameSegments(key).some((s) => CREDENTIAL_KEY_SEGMENTS.has(s));
}

/** Status a raised HTTPException declares: "401"/"403"; "unreadable" (status_code
 *  set to an opaque identifier such as CODE); or null (no 401/403 signal, e.g. a
 *  404 or a detail-only raise). */
function httpExceptionStatus(call: SyntaxNode): "401" | "403" | "unreadable" | null {
  const args = call.childForFieldName("arguments");
  if (!args) return null;
  const named = args.namedChildren.filter((n): n is SyntaxNode => n !== null);
  const kw = named.find(
    (n) => n.type === "keyword_argument" && n.childForFieldName("name")?.text === "status_code",
  );
  if (kw) {
    const val = kw.childForFieldName("value");
    if (!val) return null;
    if (val.type === "integer") {
      return REJECT_STATUSES.has(val.text) ? (val.text as "401" | "403") : null;
    }
    if (val.type === "attribute") {
      const m = (val.childForFieldName("attribute")?.text ?? "").match(/^HTTP_(401|403)_/);
      return m ? (m[1] as "401" | "403") : null;
    }
    if (val.type === "identifier") {
      const m = val.text.match(/^HTTP_(401|403)_/);
      return m ? (m[1] as "401" | "403") : "unreadable"; // bare CODE identifier
    }
    return null;
  }
  const pos = named.find((n) => n.type !== "keyword_argument") ?? null;
  return rejectStatusKind(pos);
}

/** Resolved redirect target string, or null when statically unreadable. */
function redirectTargetString(call: SyntaxNode): string | null {
  const arg0 = call.childForFieldName("arguments")?.namedChild(0) ?? null;
  if (!arg0) return null;
  if (arg0.type === "string") return pyStringText(arg0);
  if (arg0.type === "call" && finalName(arg0.childForFieldName("function")) === "url_for") {
    const inner = arg0.childForFieldName("arguments")?.namedChild(0) ?? null;
    return inner && inner.type === "string" ? pyStringText(inner) : null;
  }
  return null;
}

/** True when a resolved redirect target has a login-flavored segment. */
function redirectTargetIsLogin(target: string): boolean {
  return target
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0)
    .some((s) => LOGIN_REDIRECT_SEGMENTS.has(s));
}

/** True when a `.get(...)`-style call reads a credential key off a session /
 *  cookie / header surface (session.get, g.get, request.headers.get, ...). */
function isCredentialGetCall(call: SyntaxNode): boolean {
  const fn = call.childForFieldName("function");
  if (!fn || fn.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "get") {
    return false;
  }
  const obj = fn.childForFieldName("object");
  if (!obj) return false;
  const receiverOk =
    (obj.type === "identifier" && (obj.text === "session" || obj.text === "g")) ||
    (obj.type === "attribute" &&
      obj.childForFieldName("object")?.text === "request" &&
      ["headers", "cookies", "session"].includes(obj.childForFieldName("attribute")?.text ?? ""));
  if (!receiverOk) return false;
  const arg0 = call.childForFieldName("arguments")?.namedChild(0) ?? null;
  return arg0 !== null && arg0.type === "string" && keyIsCredential(pyStringText(arg0));
}

/** Descendants of `node` of one of `types`, NOT descending into nested
 *  `function_definition` / `lambda` subtrees. A reject signature inside a nested
 *  def is not executed inline, so it must not count as the hook rejecting; the
 *  hook's own try/if/for branches (and one-hop helper bodies, scanned
 *  separately) still count. Pre-order; the root `node` itself is never yielded. */
function prunedDescendants(node: SyntaxNode, types: Set<string>): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const visit = (n: SyntaxNode) => {
    for (const child of n.namedChildren) {
      if (!child) continue;
      if (child.type === "function_definition" || child.type === "lambda") continue;
      if (types.has(child.type)) out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}
const CALL_T = new Set(["call"]);
const COMPARISON_T = new Set(["comparison_operator"]);
const SUBSCRIPT_T = new Set(["subscript"]);

/** Like `prunedDescendants` but also yields `node` itself when it matches — an
 *  `if` condition often IS the comparison/call/subscript, which a
 *  descendants-only walk would miss. */
function prunedSelfAndDescendants(node: SyntaxNode, types: Set<string>): SyntaxNode[] {
  const out = prunedDescendants(node, types);
  if (types.has(node.type)) out.unshift(node);
  return out;
}

/** True when `sub` is a `session["<cred>"]` / `g["<cred>"]` subscript reading a
 *  credential key. Shared by the body-wide read and the strict guard gate. */
function isCredentialSubscript(sub: SyntaxNode): boolean {
  const value = sub.childForFieldName("value");
  if (!value || value.type !== "identifier" || !(value.text === "session" || value.text === "g")) {
    return false;
  }
  const idx = sub.childForFieldName("subscript");
  return idx !== null && idx.type === "string" && keyIsCredential(pyStringText(idx));
}

/** True when a node subtree reads a credential/session/auth surface, by a LOOSE
 *  reading of the recognized shapes: a session/cookie/header `.get("<cred>")`
 *  call; a `<cred> is None` comparison or a `"<cred>" in/not in <x>` comparison
 *  (against ANY container); or a `session["<cred>"]` / `g["<cred>"]` subscript.
 *
 *  Used ONLY for the body-wide `credentialRead` signal, which resolves at most to
 *  `opaque` (a hedge, never a bless), so its deliberate over-match on a bare
 *  credential-ish name merely widens the SAFE opaque bucket. The guarded-403 BLESS
 *  gate does NOT use this helper — it uses the stricter
 *  `guardConditionHasCredentialRead` below, so `request.user_agent is None` and
 *  `"login" in request.path` never drive a bless. */
function nodeHasCredentialRead(node: SyntaxNode): boolean {
  for (const call of prunedSelfAndDescendants(node, CALL_T)) {
    if (!call.hasError && isCredentialGetCall(call)) return true;
  }
  for (const cmp of prunedSelfAndDescendants(node, COMPARISON_T)) {
    if (cmp.hasError) continue;
    const ops = cmp.children
      .filter((c): c is SyntaxNode => c !== null && !c.isNamed)
      .map((c) => c.type);
    const named = cmp.namedChildren.filter((n): n is SyntaxNode => n !== null);
    if (ops.includes("is")) {
      const hasNone = named.some((n) => n.type === "none");
      const credOperand = named.some(
        (n) =>
          (n.type === "identifier" || n.type === "attribute") &&
          nameSegments(n.text).some((s) => CREDENTIAL_KEY_SEGMENTS.has(s)),
      );
      if (hasNone && credOperand) return true;
    }
    if (ops.includes("in") || ops.includes("not in")) {
      if (named.some((n) => n.type === "string" && keyIsCredential(pyStringText(n)))) return true;
    }
  }
  for (const sub of prunedSelfAndDescendants(node, SUBSCRIPT_T)) {
    if (!sub.hasError && isCredentialSubscript(sub)) return true;
  }
  return false;
}

/** Local names in `body` bound to a STRUCTURAL credential source (a session/
 *  request `.get(...)` call, or a `session`/`g` subscript), pruned of nested
 *  defs. Lets `user = session.get("user_id"); if user is None: abort(403)` count
 *  as a credential guard while a bare `request.user_agent` name never does. */
function credentialBoundLocals(body: SyntaxNode): Set<string> {
  const bound = new Set<string>();
  for (const asn of prunedDescendants(body, new Set(["assignment"]))) {
    if (asn.hasError) continue;
    const left = asn.childForFieldName("left");
    const right = asn.childForFieldName("right");
    if (!left || left.type !== "identifier" || !right) continue;
    const rhsIsCredential =
      (right.type === "call" && isCredentialGetCall(right)) ||
      (right.type === "subscript" && isCredentialSubscript(right));
    if (rhsIsCredential) bound.add(left.text);
  }
  return bound;
}

/** Containers a credential membership test (`"<cred>" in/not in X`) may read
 *  against: `session`/`g`, or `request.session`/`request.headers`/
 *  `request.cookies`. `request.path` is deliberately NOT one, so
 *  `"login" in request.path` is not a credential read. */
function isCredentialContainer(node: SyntaxNode): boolean {
  if (node.type === "identifier") return node.text === "session" || node.text === "g";
  if (node.type === "attribute") {
    return (
      node.childForFieldName("object")?.text === "request" &&
      ["session", "headers", "cookies"].includes(node.childForFieldName("attribute")?.text ?? "")
    );
  }
  return false;
}

/** True when an is-None operand is a KNOWN credential surface: a `g.<cred>` /
 *  `session.<cred>` attribute (never `request.<x>`, so `request.user_agent` is
 *  out), or a bare identifier bound to a credential source earlier in the body. */
function isCredentialNoneOperand(node: SyntaxNode, boundLocals: Set<string>): boolean {
  if (node.type === "identifier") return boundLocals.has(node.text);
  if (node.type === "attribute") {
    const obj = node.childForFieldName("object");
    const attr = node.childForFieldName("attribute")?.text ?? "";
    return (
      obj !== null &&
      obj.type === "identifier" &&
      (obj.text === "g" || obj.text === "session") &&
      nameSegments(attr).some((s) => CREDENTIAL_KEY_SEGMENTS.has(s))
    );
  }
  return false;
}

/** STRICTER credential read for the guarded-403 BLESS gate ONLY. A 403 guard
 *  qualifies solely via a STRUCTURAL read: a session/request `.get(...)` call, a
 *  `session`/`g` subscript, a credential membership against a credential
 *  container (isCredentialContainer), or an is-None test on a known credential
 *  surface (isCredentialNoneOperand). Never a bare credential-ish name against an
 *  arbitrary container, so `"login" in request.path` and `request.user_agent is
 *  None` never bless (they still resolve `opaque` -> unsure via the loose
 *  body-wide read, a hedge, never a bless). */
function guardConditionHasCredentialRead(cond: SyntaxNode, boundLocals: Set<string>): boolean {
  for (const call of prunedSelfAndDescendants(cond, CALL_T)) {
    if (!call.hasError && isCredentialGetCall(call)) return true;
  }
  for (const sub of prunedSelfAndDescendants(cond, SUBSCRIPT_T)) {
    if (!sub.hasError && isCredentialSubscript(sub)) return true;
  }
  for (const cmp of prunedSelfAndDescendants(cond, COMPARISON_T)) {
    if (cmp.hasError) continue;
    const ops = cmp.children
      .filter((c): c is SyntaxNode => c !== null && !c.isNamed)
      .map((c) => c.type);
    const named = cmp.namedChildren.filter((n): n is SyntaxNode => n !== null);
    if (ops.includes("in") || ops.includes("not in")) {
      const credString = named.some((n) => n.type === "string" && keyIsCredential(pyStringText(n)));
      const credContainer = named.some((n) => isCredentialContainer(n));
      if (credString && credContainer) return true;
    }
    if (ops.includes("is")) {
      const hasNone = named.some((n) => n.type === "none");
      const credOperand = named.some((n) => isCredentialNoneOperand(n, boundLocals));
      if (hasNone && credOperand) return true;
    }
  }
  return false;
}

/** True when a subtree contains a 403 reject: `abort(403)`, a raised
 *  `HTTPException` with status 403, or a `(expr, 403)` return tuple. Nested def
 *  subtrees are pruned (same inline-execution rule as the body scan). */
function subtreeHas403Reject(node: SyntaxNode): boolean {
  for (const call of prunedDescendants(node, CALL_T)) {
    if (call.hasError) continue;
    if (finalName(call.childForFieldName("function")) === "abort") {
      if (rejectStatusKind(call.childForFieldName("arguments")?.namedChild(0) ?? null) === "403") return true;
    }
  }
  for (const rs of prunedDescendants(node, new Set(["raise_statement"]))) {
    if (rs.hasError) continue;
    const raised = rs.namedChild(0);
    if (
      raised?.type === "call" &&
      finalName(raised.childForFieldName("function")) === "HTTPException" &&
      httpExceptionStatus(raised) === "403"
    ) {
      return true;
    }
  }
  for (const ret of prunedDescendants(node, new Set(["return_statement"]))) {
    if (ret.hasError) continue;
    const val = ret.namedChild(0);
    if (val?.type === "expression_list") {
      const kids = val.namedChildren.filter((n): n is SyntaxNode => n !== null);
      if (rejectStatusKind(kids[kids.length - 1] ?? null) === "403") return true;
    }
  }
  return false;
}

interface BodySignals {
  reject401: boolean;
  /** A 403 reject that sits inside an `if` whose CONDITION STRUCTURALLY reads a
   *  credential surface (guardConditionHasCredentialRead). A bare 403 anywhere no
   *  longer contributes (a lone 403 is routinely a CSRF / IP / maintenance gate),
   *  nor does a 403 guarded by a bare credential-ish name against an arbitrary
   *  container (`"login" in request.path`, `request.user_agent is None`). */
  reject403Guarded: boolean;
  opaqueHint: boolean;
  credentialRead: boolean;
}

/** One body's direct signals; `hop` = whether a same-file helper body may be
 *  followed (depth exactly 1). reject401 blesses ALONE; a 403 blesses only via
 *  reject403Guarded (inside an `if <credential-condition>:` branch), since a bare
 *  403 is routinely non-auth. Nested def/lambda subtrees are pruned throughout. */
function scanBody(
  body: SyntaxNode,
  defs: Map<string, SyntaxNode | null>,
  hop: boolean,
): BodySignals {
  const out: BodySignals = {
    reject401: false, reject403Guarded: false, opaqueHint: false, credentialRead: false,
  };
  const merge = (s: BodySignals) => {
    out.reject401 = out.reject401 || s.reject401;
    out.reject403Guarded = out.reject403Guarded || s.reject403Guarded;
    out.opaqueHint = out.opaqueHint || s.opaqueHint;
    out.credentialRead = out.credentialRead || s.credentialRead;
  };

  // Credential-surface reads (the three shapes: .get call, is-None / in-string
  // comparison, session/g subscript). Body-wide here; scoped to an if-condition
  // in the guarded-403 walk below via the same helper.
  if (nodeHasCredentialRead(body)) out.credentialRead = true;

  // Calls: aborts, auth primitives, one-hop helpers, opaque hints.
  // Nested def/lambda subtrees are pruned (a reject there is not executed inline).
  for (const call of prunedDescendants(body, CALL_T)) {
    if (call.hasError) continue;
    const fn = call.childForFieldName("function");
    const args = call.childForFieldName("arguments");
    const name = finalName(fn);
    if (name === "abort") {
      const arg0 = args?.namedChild(0) ?? null;
      // 401 blesses alone; a bare abort(403) contributes NOTHING (only a
      // credential-guarded 403 blesses, handled by the if-walk below).
      if (rejectStatusKind(arg0) === "401") out.reject401 = true;
      else if (arg0 !== null && arg0.type !== "integer") out.opaqueHint = true; // abort(code_var)
      continue;
    }
    if (name !== null && KNOWN_AUTH_PRIMITIVES.has(name) && isEmptyArgList(args)) {
      out.reject401 = true; // verify_jwt_in_request() raises internally
      continue;
    }
    if (name !== null && CALL_HANDLED_ELSEWHERE.has(name)) continue;
    if (fn?.type === "identifier" && name !== null && defs.has(name)) {
      const def = defs.get(name) ?? null;
      if (def && hop) {
        const hopBody = def.childForFieldName("body");
        if (hopBody) merge(scanBody(hopBody, defs, false));
      } else if (!def && hintHit(name)) {
        out.opaqueHint = true; // duplicate same-name def: unresolvable + flavored
      }
      // A resolvable def at hop=false is the cycle guard: contribute nothing.
      continue;
    }
    if (name !== null && hintHit(name)) out.opaqueHint = true; // unresolvable flavored callee
  }

  // Guarded 403: an `if <credential-condition>: ... <403 reject> ...`. A 403 is
  // routinely a non-auth denial (CSRF, IP allowlist, maintenance), so it blesses
  // ONLY when the reject is driven by a guard condition that STRUCTURALLY reads a
  // credential surface (guardConditionHasCredentialRead — stricter than the loose
  // body-wide read), never off a bare credential-ish name against an arbitrary
  // container, and never on body-wide co-occurrence with an unrelated read.
  const boundLocals = credentialBoundLocals(body);
  for (const ifs of prunedDescendants(body, new Set(["if_statement"]))) {
    if (ifs.hasError) continue;
    const cond = ifs.childForFieldName("condition");
    const cons = ifs.childForFieldName("consequence");
    if (cond && cons && guardConditionHasCredentialRead(cond, boundLocals) && subtreeHas403Reject(cons)) {
      out.reject403Guarded = true;
    }
  }

  // raise <exception>: HTTPException status, else the auth-exception lexicon.
  // A bare 403 HTTPException contributes nothing (same asymmetry as abort(403)).
  for (const rs of prunedDescendants(body, new Set(["raise_statement"]))) {
    if (rs.hasError) continue;
    const raised = rs.namedChild(0);
    if (!raised) continue;
    if (
      raised.type === "call" &&
      finalName(raised.childForFieldName("function")) === "HTTPException"
    ) {
      const st = httpExceptionStatus(raised);
      if (st === "401") out.reject401 = true;
      else if (st === "unreadable") out.opaqueHint = true;
      continue;
    }
    const rn = finalName(raised);
    if (rn !== null && isAuthExceptionName(rn)) out.reject401 = true;
  }

  // return: a login-flavored redirect, or an (expr, 401) tuple. A trailing 403
  // tuple contributes nothing here; a credential-guarded one is caught above.
  for (const ret of prunedDescendants(body, new Set(["return_statement"]))) {
    if (ret.hasError) continue;
    const val = ret.namedChild(0);
    if (!val) continue;
    if (val.type === "call") {
      const cn = finalName(val.childForFieldName("function"));
      if (cn === "redirect" || cn === "RedirectResponse") {
        const target = redirectTargetString(val);
        if (target === null) out.opaqueHint = true; // redirect(page_var): unreadable target
        else if (redirectTargetIsLogin(target)) out.reject401 = true;
      }
      continue;
    }
    if (val.type === "expression_list") {
      const kids = val.namedChildren.filter((n): n is SyntaxNode => n !== null);
      if (rejectStatusKind(kids[kids.length - 1] ?? null) === "401") out.reject401 = true;
    }
  }

  return out;
}

/** File-wide map of top-level and nested function definitions by name. A name
 *  seen more than once maps to null (duplicate: follow NEITHER definition). */
export function collectFunctionDefs(root: SyntaxNode): Map<string, SyntaxNode | null> {
  const defs = new Map<string, SyntaxNode | null>();
  for (const def of root.descendantsOfType("function_definition")) {
    if (!def || def.hasError) continue;
    const name = def.childForFieldName("name")?.text;
    if (!name) continue;
    defs.set(name, defs.has(name) ? null : def);
  }
  return defs;
}

/** A hook body's three-way auth signal. 401-family blesses alone; a 403 blesses
 *  only inside a reject driven by a credential-referencing guard condition
 *  (`if <credential>: abort(403)`); a bare/uncorroborated 403 is neither reject
 *  nor opaque (keeps the hedge meaningful). */
export function bodyAuthSignature(
  body: SyntaxNode,
  defs: Map<string, SyntaxNode | null>,
): BodySignal {
  const s = scanBody(body, defs, true);
  if (s.reject401 || s.reject403Guarded) return "reject";
  if (s.opaqueHint || s.credentialRead) return "opaque";
  return "none";
}

/** Precedence layer over `bodyAuthSignature`. `nameIsSimpleIdentifier` is false
 *  for attribute targets (AuthGate.check), which can hedge but never bless. */
export function classifyHookAuth(
  hookName: string,
  body: SyntaxNode | null,
  defs: Map<string, SyntaxNode | null>,
  nameIsSimpleIdentifier: boolean,
): HookAuthOutcome {
  const segs = nameSegments(hookName);
  if (segs.some((s) => OPTIONAL_AUTH_VETO.has(s))) return "not-auth"; // rule 1
  const isCore =
    nameIsSimpleIdentifier &&
    (segs.some((s) => AUTH_CORE_SEGMENTS.has(s)) || AUTH_DECORATORS.has(hookName));
  if (body) {
    const sig = bodyAuthSignature(body, defs);
    if (sig === "reject") return "auth"; // rule 2: behavior beats name
    if (sig === "none") return "not-auth"; // rule 3: a visible non-enforcing body, name never rescues
    return isCore ? "auth" : "unsure"; // rule 4: opaque -> CORE carve-out, else hedge
  }
  if (isCore) return "auth"; // rule 5: resolved simple CORE name
  const flavored = segs.some((s) => AUTH_CORE_SEGMENTS.has(s)) || nameHasAuthToken(hookName);
  return flavored ? "unsure" : "not-auth";
}

/** Segment-matched auth verdict for a resolved dependency name (see the constants
 *  block): hit on a single DEPENDS_AUTH_SEGMENTS segment or an adjacent
 *  DEPENDS_AUTH_PAIRS pair; ANY DEPENDS_VETO_SEGMENTS segment cancels the hit
 *  (optional / settings / stats flavored dependencies resolve false). */
function dependsNameIsAuth(name: string): boolean {
  const segs = nameSegments(name);
  if (segs.some((s) => DEPENDS_VETO_SEGMENTS.has(s))) return false;
  if (segs.some((s) => DEPENDS_AUTH_SEGMENTS.has(s))) return true;
  for (let i = 0; i < segs.length - 1; i++) {
    if (DEPENDS_AUTH_PAIRS.has(`${segs[i]} ${segs[i + 1]}`)) return true;
  }
  return false;
}

/** The NAME a Depends/Security argument resolves to: an identifier's text, an
 *  attribute's dotted text, or, for a class dependency Depends(JWTBearer()), the
 *  call's OWN callee name (never its arguments). Anything else (lambda, subscript,
 *  literal) resolves null: matching raw expression text would let a nested string
 *  or kwarg bless (Depends(make_client("oauth2_url")) must stay false). */
function dependencyTargetName(target: SyntaxNode): string | null {
  if (target.type === "identifier" || target.type === "attribute") return target.text;
  if (target.type === "call") {
    const fn = target.childForFieldName("function");
    if (fn && (fn.type === "identifier" || fn.type === "attribute")) return fn.text;
  }
  return null;
}

/** The value node of a `name=` kwarg on a call, or null when absent. */
function kwargValue(call: SyntaxNode, kwarg: string): SyntaxNode | null {
  const args = call.childForFieldName("arguments");
  if (!args) return null;
  for (const n of args.namedChildren) {
    if (
      n !== null &&
      n.type === "keyword_argument" &&
      n.childForFieldName("name")?.text === kwarg
    ) {
      return n.childForFieldName("value");
    }
  }
  return null;
}

function isAuthDecorator(dec: SyntaxNode): boolean {
  const expr = dec.namedChild(0);
  if (!expr) return false;
  if (expr.type === "identifier" || expr.type === "attribute") {
    const name = decoratorName(expr);
    return name !== null && AUTH_DECORATORS.has(name);
  }
  if (expr.type === "call") {
    const fn = expr.childForFieldName("function");
    if (!fn) return false;
    const name = decoratorName(fn);
    // Bare "requires" counts ONLY in its bare-identifier form @requires(...):
    // @feature.requires("new_ui") / @pytest.mark.requires are feature-flag and
    // marker decorators, not auth.
    const recognized =
      (name !== null && AUTH_DECORATORS.has(name)) ||
      (fn.type === "identifier" && fn.text === "requires");
    if (!recognized) return false;
    // flask-jwt-extended: @jwt_required(optional=True) admits anonymous requests.
    // ANY optional= value other than the literal False counts as optional
    // (optional=SOME_FLAG is statically unknowable; ambiguity resolves to false,
    // never toward a bless).
    const optional = kwargValue(expr, "optional");
    return optional === null || optional.text === "False";
  }
  return false;
}

/** Any Depends(...)/Security(...) call under `scope` whose RESOLVED dependency is
 *  auth enforcement. Resolution order (never-false-bless): (1) an optional /
 *  settings / stats-flavored VETO name never blesses, by name OR body; (2) a
 *  name-segment lexicon hit blesses; (3) additive — a boring name whose
 *  SAME-FILE def body raises a verified reject (Depends(load_actor) where
 *  load_actor 401s) blesses. Bare Depends() or an unresolvable target resolves
 *  false. */
function callsWithAuthDependency(
  scope: SyntaxNode,
  defs: Map<string, SyntaxNode | null>,
  importerRel?: string,
  index?: CrossFileIndex,
): boolean {
  for (const call of scope.descendantsOfType("call")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "identifier") continue;
    if (fn.text !== "Depends" && fn.text !== "Security") continue;
    const target = call.childForFieldName("arguments")?.namedChild(0);
    const name = target ? dependencyTargetName(target) : null;
    if (name === null) continue;
    // veto first: get_current_user_optional admits anonymous requests even if its
    // body raises 401, so neither the name hit nor the body branch may bless it.
    if (nameSegments(name).some((s) => DEPENDS_VETO_SEGMENTS.has(s))) continue;
    if (dependsNameIsAuth(name)) return true; // name-segment hit
    const def = defs.get(name); // same-file body reject (additive)
    if (def) {
      const body = def.childForFieldName("body");
      if (body && bodyAuthSignature(body, defs) === "reject") return true;
    } else if (!defs.has(name) && index && importerRel) {
      // Imported dependency (NOT an in-file `defs.get(name) === null` duplicate,
      // which the `!defs.has(name)` guard still refuses): resolve its in-repo
      // defining body cross-file. The optional/settings veto is re-run on the
      // RESOLVED ORIGINAL name (not the call-site alias), so an aliased optional
      // dependency (load_actor -> get_current_user_optional) can never rule-2
      // bless. The TARGET file's own defs (x.defs) back the body so its one-hop
      // helpers resolve in the target, not the importer. Blessing still requires
      // the resolved body to VERIFIABLY reject — no new bless path is introduced.
      const x = resolvePyHookBody(index, importerRel, name);
      if (
        x &&
        x.body &&
        !nameSegments(x.originalName).some((s) => DEPENDS_VETO_SEGMENTS.has(s)) &&
        bodyAuthSignature(x.body, x.defs) === "reject"
      ) {
        return true;
      }
    }
  }
  return false;
}

/** FastAPI parameter dependencies: one descendant-call walk over the parameters
 *  node covers plain defaults (default_parameter), typed defaults
 *  (typed_default_parameter), and Annotated[T, Depends(...)] (typed_parameter,
 *  where the call nests under the TYPE field's generic_type). */
function paramsHaveAuthDependency(
  definition: SyntaxNode,
  defs: Map<string, SyntaxNode | null>,
  importerRel?: string,
  index?: CrossFileIndex,
): boolean {
  const params = definition.childForFieldName("parameters");
  return params ? callsWithAuthDependency(params, defs, importerRel, index) : false;
}

/** Route-decorator-level dependencies kwarg:
 *  @router.post("/x", dependencies=[Depends(verify_token)]). */
function routeCallHasAuthDependency(
  call: SyntaxNode,
  defs: Map<string, SyntaxNode | null>,
  importerRel?: string,
  index?: CrossFileIndex,
): boolean {
  const args = call.childForFieldName("arguments");
  if (!args) return false;
  const kw = args.namedChildren.find(
    (n) =>
      n !== null &&
      n.type === "keyword_argument" &&
      n.childForFieldName("name")?.text === "dependencies",
  );
  const value = kw?.childForFieldName("value");
  return value ? callsWithAuthDependency(value, defs, importerRel, index) : false;
}

/** Middleware scopes for one python file. Python file-level middleware attaches
 *  to a RECEIVER (an app/blueprint/router variable), so inheritance must be
 *  receiver-scoped: `global` holds app-scoped middleware (receivers named
 *  app/application, plus before_app_request hooks, which Flask runs app-wide);
 *  `byReceiver` holds named blueprint/router scopes keyed by the exact
 *  receiver/variable name. A file-granular OR would bless a public blueprint
 *  co-located with a guarded admin blueprint: a false bless that also silences
 *  both vote layers for the file. */
interface PyMiddlewareScopes {
  global: FileMiddleware;
  byReceiver: Map<string, FileMiddleware>;
  /** First (document-order) unsure hook name at app scope, or null. An unsure
   *  hook NEVER sets a hasAuth lane; it only records the name a route inherits so
   *  a renderer can hedge. hasAuth stays false, so the FileMiddleware OR never
   *  launders an unsure hook into a bless. */
  globalUnsure: string | null;
  /** First (document-order) unsure hook name per named receiver. */
  unsureByReceiver: Map<string, string>;
}

const APP_SCOPED_RECEIVER = /^(?:app|application)$/;

function collectPyMiddleware(
  tree: Tree,
  defs: Map<string, SyntaxNode | null>,
  importerRel?: string,
  index?: CrossFileIndex,
): PyMiddlewareScopes {
  const scopes: PyMiddlewareScopes = {
    global: { hasAuth: false, hasValidation: false, hasRateLimit: false },
    byReceiver: new Map(),
    globalUnsure: null,
    unsureByReceiver: new Map(),
  };
  const mark = (receiver: string, appWide: boolean, lane: keyof FileMiddleware) => {
    if (appWide || APP_SCOPED_RECEIVER.test(receiver)) {
      scopes.global[lane] = true;
      return;
    }
    const entry =
      scopes.byReceiver.get(receiver) ??
      { hasAuth: false, hasValidation: false, hasRateLimit: false };
    entry[lane] = true;
    scopes.byReceiver.set(receiver, entry);
  };
  // First-wins: the earliest unsure hook on a scope is the one a route names.
  const markUnsure = (receiver: string, appWide: boolean, hookName: string) => {
    if (!hookName) return; // a lambda has no openable name; stay flat not-auth
    if (appWide || APP_SCOPED_RECEIVER.test(receiver)) {
      if (scopes.globalUnsure === null) scopes.globalUnsure = hookName;
      return;
    }
    if (!scopes.unsureByReceiver.has(receiver)) scopes.unsureByReceiver.set(receiver, hookName);
  };
  // Three-way hook classification -> lane / hedge marks on the receiver scope.
  const applyHookOutcome = (
    receiver: string,
    appWide: boolean,
    hookName: string,
    body: SyntaxNode | null,
    nameIsSimpleIdentifier: boolean,
    // The defs the body's own one-hop helper calls resolve against. Defaults to
    // THIS file's defs (the in-file path); a cross-file body MUST pass the TARGET
    // file's defs so its helpers resolve in the target, not the importer.
    defsForBody: Map<string, SyntaxNode | null> = defs,
  ) => {
    const outcome = classifyHookAuth(hookName, body, defsForBody, nameIsSimpleIdentifier);
    if (outcome === "auth") mark(receiver, appWide, "hasAuth");
    else if (outcome === "unsure") markUnsure(receiver, appWide, hookName);
    // Validation / rate-limit lanes stay NAME-based and independent of the body:
    // body analysis is the auth lane only.
    if (RATE_NAMES.test(hookName)) mark(receiver, appWide, "hasRateLimit");
    if (VAL_NAMES.test(hookName)) mark(receiver, appWide, "hasValidation");
  };
  const routerNames = collectRouterNames(tree.rootNode);
  const gated = (r: string | null): r is string =>
    r !== null && (routerNames.has(r) || ROUTER_RECEIVER.test(r));

  for (const dd of tree.rootNode.descendantsOfType("decorated_definition")) {
    if (!dd || dd.hasError) continue;
    const definition = dd.childForFieldName("definition");
    if (!definition || definition.type !== "function_definition") continue;
    const fnName = definition.childForFieldName("name")?.text ?? "";
    for (const dec of dd.namedChildren) {
      if (!dec || dec.type !== "decorator") continue;
      const expr = dec.namedChild(0);
      // @app.before_request is a bare attribute decorator; @app.before_request()
      // with parens is a call whose function is the attribute. Handle both.
      const attr =
        expr?.type === "attribute"
          ? expr
          : expr?.type === "call" && expr.childForFieldName("function")?.type === "attribute"
            ? expr.childForFieldName("function")
            : null;
      if (!attr) continue;
      const hook = attr.childForFieldName("attribute")?.text ?? "";
      if (hook !== "before_request" && hook !== "before_app_request") continue;
      const receiver = receiverName(attr.childForFieldName("object"));
      if (!gated(receiver)) continue;
      const appWide = hook === "before_app_request";
      // Body-first: a verified reject body blesses even under a boring name; a
      // visible non-enforcing body never blesses whatever the name (the
      // verify_user_email fix); an opaque body hedges as unsure unless the name
      // is an unambiguous CORE token. A decorated hook name is a simple identifier.
      applyHookOutcome(receiver, appWide, fnName, definition.childForFieldName("body"), true);
    }
  }

  for (const call of tree.rootNode.descendantsOfType("call")) {
    if (!call || call.hasError) continue;
    const fn = call.childForFieldName("function");
    if (!fn) continue;
    // Call-form hook registration: app.before_request(fn) / (lambda) / (Cls.method).
    // The decorator form @app.before_request() also parses to a call with an
    // attribute callee, but its argument_list is empty (the function is decorated
    // separately), so the arg0 gate below skips it (handled by the decorator loop).
    if (
      fn.type === "attribute" &&
      (fn.childForFieldName("attribute")?.text === "before_request" ||
        fn.childForFieldName("attribute")?.text === "before_app_request")
    ) {
      const receiver = receiverName(fn.childForFieldName("object"));
      if (!gated(receiver)) continue;
      const arg0 = call.childForFieldName("arguments")?.namedChild(0) ?? null;
      if (!arg0) continue; // decorator-form empty call, or before_request() with no target
      const appWide = fn.childForFieldName("attribute")?.text === "before_app_request";
      if (arg0.type === "identifier") {
        if (defs.has(arg0.text)) {
          // In-file def (or an in-file duplicate mapping to null) takes precedence:
          // classify its LOCAL body. A same-named cross-file def NEVER overrides a
          // local one, and this branch is byte-identical to today's behavior.
          const def = defs.get(arg0.text) ?? null;
          applyHookOutcome(receiver, appWide, arg0.text, def ? def.childForFieldName("body") : null, true);
        } else if (index && importerRel) {
          // Imported hook: resolve its in-repo body cross-file, then classify via
          // the SAME body-first classifier — no new bless path. The optional-auth
          // veto is re-run on the RESOLVED ORIGINAL name (not the call-site alias),
          // so an aliased optional hook (check -> get_current_user_optional) can
          // never rule-2 bless: on a veto we supply a null body (name-tier only).
          // The TARGET file's defs (x.defs) back the body so its one-hop helpers
          // resolve in the target file, not the importer.
          const x = resolvePyHookBody(index, importerRel, arg0.text);
          const vetoed =
            x !== null && nameSegments(x.originalName).some((s) => OPTIONAL_AUTH_VETO.has(s));
          const body = vetoed ? null : (x?.body ?? null);
          applyHookOutcome(receiver, appWide, arg0.text, body, true, vetoed ? undefined : x?.defs);
        } else {
          // Imported, no index: name-tier only (today's byte-identical behavior).
          applyHookOutcome(receiver, appWide, arg0.text, null, true);
        }
      } else if (arg0.type === "attribute") {
        applyHookOutcome(receiver, appWide, arg0.text, null, false); // Cls.method: hedge only
      } else if (arg0.type === "lambda") {
        applyHookOutcome(receiver, appWide, "", arg0, false); // scan the lambda body
      }
      // Any other arg0 shape is unresolvable: blesses nothing (never-false-bless).
      continue;
    }
    if (fn.type === "attribute" && fn.childForFieldName("attribute")?.text === "add_middleware") {
      const receiver = receiverName(fn.childForFieldName("object"));
      if (!gated(receiver)) continue;
      const first = call.childForFieldName("arguments")?.namedChild(0);
      const mwName =
        first && (first.type === "identifier" || first.type === "attribute") ? first.text : "";
      // Middleware CLASS NAME only (never the whole arg text), matched by WHOLE
      // CamelCase/underscore segment: AuthMiddleware and AuthenticationMiddleware
      // bless, AuthorTrackingMiddleware does not (the segment "author" is not
      // "auth"; same discipline as decorators and Depends targets). The
      // optional-auth veto cancels a hit: OptionalAuthMiddleware admits anonymous
      // requests, so it must not bless (mirrors the Depends path).
      const mwSegs = nameSegments(mwName);
      if (
        mwSegs.some((s) => MIDDLEWARE_AUTH_SEGMENTS.has(s)) &&
        !mwSegs.some((s) => OPTIONAL_AUTH_VETO.has(s))
      ) {
        mark(receiver, false, "hasAuth");
      }
      if (/[Ll]imit/.test(mwName) || RATE_NAMES.test(mwName)) mark(receiver, false, "hasRateLimit");
      if (/[Vv]alid/.test(mwName)) mark(receiver, false, "hasValidation");
    }
  }

  // Constructor dependencies scope to the ASSIGNED variable name
  // (admin_router = APIRouter(dependencies=[...])). An unassigned or destructured
  // constructor has no resolvable scope and blesses NOTHING (never-false-bless: a
  // miss is safe). app = FastAPI(dependencies=[...]) lands in the global scope via
  // APP_SCOPED_RECEIVER. Cross-receiver app.include_router() inheritance is a
  // documented recall gap (over-flag, never a bless).
  for (const asn of tree.rootNode.descendantsOfType("assignment")) {
    if (!asn || asn.hasError) continue;
    const left = asn.childForFieldName("left");
    const right = asn.childForFieldName("right");
    if (!left || left.type !== "identifier" || !right || right.type !== "call") continue;
    const fn = right.childForFieldName("function");
    if (!fn || fn.type !== "identifier") continue;
    if (fn.text !== "APIRouter" && fn.text !== "FastAPI") continue;
    const value = kwargValue(right, "dependencies");
    if (value && callsWithAuthDependency(value, defs, importerRel, index)) mark(left.text, false, "hasAuth");
  }
  return scopes;
}

/** File-level OR of every scope: the seam-2 index entry (public FileMiddleware
 *  shape, unchanged) and the regex fallback's inheritance input. Route-level
 *  inheritance on the AST path does NOT read this OR; extractPythonRoutesAst
 *  consumes collectPyMiddleware directly (receiver-scoped). */
export function extractPythonFileMiddlewareAst(tree: Tree): FileMiddleware {
  const scopes = collectPyMiddleware(tree, collectFunctionDefs(tree.rootNode));
  const all = [scopes.global, ...scopes.byReceiver.values()];
  return {
    hasAuth: all.some((s) => s.hasAuth),
    hasValidation: all.some((s) => s.hasValidation),
    hasRateLimit: all.some((s) => s.hasRateLimit),
  };
}

export function extractPythonRoutesAst(
  tree: Tree,
  filePath: string,
  index?: CrossFileIndex,
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const routerNames = collectRouterNames(tree.rootNode);
  const methodsVars = collectMethodsVars(tree.rootNode);
  const defs = collectFunctionDefs(tree.rootNode);
  // filePath IS the importer's relativePath. With `index` absent (the 2-arg
  // call), every cross-file branch below is skipped, so the whole path is
  // byte-identical to today's in-file-only behavior.
  const scopes = collectPyMiddleware(tree, defs, filePath, index);
  for (const dd of tree.rootNode.descendantsOfType("decorated_definition")) {
    // Error recovery can merge adjacent handlers' decorators into one dd;
    // blessing (or even extracting) across that boundary is forbidden.
    if (!dd || dd.hasError) continue;
    const definition = dd.childForFieldName("definition");
    if (!definition || definition.type !== "function_definition") continue; // @dataclass wraps class_definition
    const decorators = dd.namedChildren.filter(
      (n): n is SyntaxNode => n !== null && n.type === "decorator",
    );
    // Auth decorators bind POSITIONALLY. Python decorators apply bottom-up, so an
    // auth decorator protects a route only when it is applied BEFORE the route
    // decorator registers the handler, i.e. only when it sits BELOW that route
    // decorator (strictly greater start row). @login_required stacked ABOVE
    // @app.route leaves the url_map holding the unwrapped handler: genuinely
    // unauthed at runtime, so it must not bless.
    const authDecoratorRows = decorators
      .filter(isAuthDecorator)
      .map((d) => d.startPosition.row);
    // @permission_classes([IsAuthenticated]) is DRF-only and runtime-inert when
    // stacked under a Flask (@app.route) or FastAPI (@router.post) route
    // decorator, so its rows are collected SEPARATELY and may bless ONLY an
    // api_view-derived route (never a co-located @app/@router route in the same
    // decorated_definition). DRF's own positional rule still applies: a
    // permission_classes decorator counts only when it sits BELOW @api_view
    // (row > the api_view decorator's row), enforced by the same check below.
    const permissionClassRows = decorators
      .filter(isAuthPermissionClasses)
      .map((d) => d.startPosition.row);
    const paramAuth = paramsHaveAuthDependency(definition, defs, filePath, index);
    // Validation / rate-limit lanes match NON-ROUTE decorator CALLEE NAMES only
    // (@limiter.limit -> "limiter.limit", @validate_schema -> "validate_schema"),
    // never argument or path text: @app.post("/validate") is a path, not
    // validation middleware, and must not bless its lane.
    const laneNames = decorators
      .filter((d) => asRouteDecorator(d, routerNames, methodsVars) === null)
      .map((d) => {
        const expr = d.namedChild(0);
        if (!expr) return "";
        if (expr.type === "call") return expr.childForFieldName("function")?.text ?? "";
        return expr.text;
      })
      .filter((t) => t.length > 0);
    const perVal = laneNames.some((t) => VAL_NAMES.test(t));
    const perRate = laneNames.some((t) => RATE_NAMES.test(t));
    for (const dec of decorators) {
      const routeFromDecorator = asRouteDecorator(dec, routerNames, methodsVars);
      // asApiViewDecorator is only consulted when the decorator is not already a
      // router/app route, so the api_view-only permission_classes bless below can
      // key off apiViewRoute !== null.
      const apiViewRoute = routeFromDecorator ? null : asApiViewDecorator(dec, definition);
      const route = routeFromDecorator ?? apiViewRoute;
      if (!route) continue;
      const fromApiView = apiViewRoute !== null;
      const hasAuth =
        authDecoratorRows.some((row) => row > dec.startPosition.row) ||
        (fromApiView &&
          permissionClassRows.some((row) => row > dec.startPosition.row)) ||
        paramAuth ||
        routeCallHasAuthDependency(route.call, defs, filePath, index) ||
        scopes.global.hasAuth ||
        (scopes.byReceiver.get(route.receiver)?.hasAuth ?? false);
      // A route is hedged "unsure" ONLY when it is not otherwise authed AND an
      // unsure hook is in its scope. RECEIVER-FIRST is the shipped convention: a
      // route on a named blueprint/router attributes its OWN receiver's unsure
      // hook before falling back to an app-scoped one, because the receiver hook
      // is the more actionable one for that route to double-check. The field
      // implies hasAuth === false; a blessed route never carries it.
      const unsureHook = hasAuth
        ? undefined
        : (scopes.unsureByReceiver.get(route.receiver) ?? scopes.globalUnsure ?? undefined);
      routes.push({
        method: route.method,
        path: route.path,
        file: filePath,
        // 1-based, the route decorator's OWN line (not the dd's first decorator,
        // not the def line): regex parity, and the @vibedrift-public suppression
        // binding depends on it.
        line: dec.startPosition.row + 1,
        hasAuth,
        hasValidation:
          perVal ||
          scopes.global.hasValidation ||
          (scopes.byReceiver.get(route.receiver)?.hasValidation ?? false),
        hasRateLimit:
          perRate ||
          scopes.global.hasRateLimit ||
          (scopes.byReceiver.get(route.receiver)?.hasRateLimit ?? false),
        hasErrorHandler: false, // write-only field; JS AST extractor hard-codes false too
        ...(unsureHook !== undefined ? { authUnsureHook: unsureHook } : {}),
      });
    }
  }
  return routes;
}
