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
 * (a variable, `**kwargs`, or a `*splat` with no visible literal verb)
 * deliberately diverges from the regex extractor. The regex silently defaults
 * such a route to GET, which excludes it from the mutating vote. This AST
 * path instead resolves it to "ALL", which keeps the route IN the mutating
 * vote (matching how an Express `.all()` route is treated). This is a real,
 * user-visible behavior change from today's regex path, not a bug fix; it is
 * called out here for explicit sign-off rather than shipped silently.
 * `asApiViewDecorator` follows the SAME ALL-on-unresolvable convention: an
 * `@api_view([METHOD])` / `@api_view([*BASE])` list whose only verbs are hidden
 * behind a variable resolves to "ALL", not GET. Same open question, same
 * pending sign-off.
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
// names (see nameHasAuthToken). Deliberately stricter than the file-level regex,
// which blesses ANY before_request. tier 1: a CORE segment alone (an unambiguous
// authn word). tier 2: an ENFORCEMENT verb segment AND a SUBJECT segment anywhere
// in the name. A lone SUBJECT (login / token / user) or a lone ENFORCE verb never
// blesses: track_login_metrics, verify_content_type, and set_csrf_token are real
// hooks that do not authenticate. Whole-segment matching makes substring blessing
// structurally impossible.
const AUTH_CORE_SEGMENTS = new Set(["auth", "authenticate", "authenticated"]);
// KNOWN FALSE-BLESS EXPOSURE (owner decision required): the ENFORCE+SUBJECT
// two-tier match blesses attributive non-auth hook names such as
// verify_user_email (email-confirmation flow) and protect_user_data (data
// scrubbing): ENFORCE verb + SUBJECT noun both match even though the hook
// does not authenticate. This shape exists in the plan's pinned sets as well
// (verify + user), so it is inherent to the two-tier design, not only to the
// additions. Resolution options for the owner: narrow the ENFORCE x SUBJECT
// cross-product, add attributive vetoes (subject followed by an object noun
// like email/data/profile), or accept as documented risk. Blessing suppresses
// findings, so this is the false-bless direction, never a safe over-flag.
// Also note: verify_token in AUTH_DECORATORS matches flask-httpauth's
// @auth.verify_token registration decorator, which is not a route wrapper;
// if stacked on a route handler it would leak-bless (non-idiomatic, low
// risk). The closest non-auth neighbors are pinned FALSE by boundary tests
// (restricted_zone_redirect, track_user_metrics, role_labels, protect_branch)
// to keep the surface explicit. The sets are left UNCHANGED here; any
// narrowing waits on the owner's lexicon decision.
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
// an authenticated request. Deliberately narrow: AllowAny never requires auth;
// IsAuthenticatedOrReadOnly and DjangoModelPermissionsOrAnonReadOnly only require
// auth for unsafe (write) methods, which is a per-method condition this
// route-level check cannot statically resolve, so they are NOT here; any other
// built-in or custom permission class is unrecognized. Per the never-false-bless
// invariant, ambiguity and the unrecognized case both resolve to false.
const PERMISSION_AUTH = new Set(["IsAuthenticated"]);

export const SECURITY_AST_PY = {
  ROUTE_METHODS, HTTP_VERBS, MUTATING_VERBS, ROUTER_RECEIVER, ROUTER_CONSTRUCTORS,
  AUTH_DECORATORS, DEPENDS_AUTH_SEGMENTS, DEPENDS_AUTH_PAIRS, DEPENDS_VETO_SEGMENTS,
  VAL_NAMES, RATE_NAMES, AUTH_CORE_SEGMENTS, AUTH_ENFORCE_SEGMENTS,
  AUTH_SUBJECT_SEGMENTS, OPTIONAL_AUTH_VETO, MIDDLEWARE_AUTH_SEGMENTS, PERMISSION_AUTH,
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

function asRouteDecorator(dec: SyntaxNode, routerNames: Set<string>): PyRoute | null {
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
  return { method: resolveMethod(attr, args), path, call: expr, receiver };
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
 *  unresolvable form (variable value, **kwargs splat, a *splat with no visible
 *  literal verb), so the route STAYS in the mutating vote ("ALL" is a member of
 *  both MUTATION_METHODS and BODY_METHODS), the same way Express's `.all()` is
 *  treated. This is a real behavior change from the regex path and is flagged
 *  as an open question for sign-off, not a silent fix.
 *
 *  A fully visible, empty `methods=[]` is NOT ambiguous: Flask's own default is
 *  GET, so an empty literal resolves to GET rather than ALL. */
function resolveMethod(attr: string, args: SyntaxNode): string {
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
  if (!value || !["list", "tuple", "set"].includes(value.type)) return "ALL"; // methods=VARIABLE
  const children = value.namedChildren.filter((n): n is SyntaxNode => n !== null);
  const verbs = children
    .filter((n) => n.type === "string")
    .map((s) => (pyStringText(s) ?? "").toUpperCase())
    .filter((v) => HTTP_VERBS.has(v));
  const hidden = children.some((n) => n.type !== "string");
  if (verbs.length === 0) return hidden ? "ALL" : "GET"; // [*BASE] vs literal []
  return verbs.find((v) => MUTATING_VERBS.has(v)) ?? verbs[0];
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
    const children = list.namedChildren.filter((n): n is SyntaxNode => n !== null);
    const verbs = children
      .filter((n) => n.type === "string")
      .map((s) => (pyStringText(s) ?? "").toUpperCase())
      .filter((v) => HTTP_VERBS.has(v));
    // A non-string element (a variable verb: @api_view([METHOD]) or
    // @api_view([*BASE])) is statically unresolvable. Following the module's
    // ALL-on-unresolvable convention (resolveMethod, pending the owner sign-off
    // in the header OPEN QUESTION), an unresolvable list with no visible literal
    // verb resolves ALL so the route STAYS in the mutating vote rather than
    // silently defaulting GET; a visible literal still resolves it normally.
    const hidden = children.some((n) => n.type !== "string");
    method =
      verbs.length === 0
        ? hidden
          ? "ALL"
          : "GET"
        : (verbs.find((v) => MUTATING_VERBS.has(v)) ?? verbs[0]);
  } else if (list) {
    method = "ALL"; // verbs behind a variable: keep the route in the mutating vote
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

/** Any Depends(...)/Security(...) call under `scope` whose RESOLVED dependency
 *  name matches the segment lexicon. Bare Depends(), an unresolvable target, or a
 *  vetoed name resolves false. */
function callsWithAuthDependency(scope: SyntaxNode): boolean {
  for (const call of scope.descendantsOfType("call")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "identifier") continue;
    if (fn.text !== "Depends" && fn.text !== "Security") continue;
    const target = call.childForFieldName("arguments")?.namedChild(0);
    const name = target ? dependencyTargetName(target) : null;
    if (name !== null && dependsNameIsAuth(name)) return true;
  }
  return false;
}

/** FastAPI parameter dependencies: one descendant-call walk over the parameters
 *  node covers plain defaults (default_parameter), typed defaults
 *  (typed_default_parameter), and Annotated[T, Depends(...)] (typed_parameter,
 *  where the call nests under the TYPE field's generic_type). */
function paramsHaveAuthDependency(definition: SyntaxNode): boolean {
  const params = definition.childForFieldName("parameters");
  return params ? callsWithAuthDependency(params) : false;
}

/** Route-decorator-level dependencies kwarg:
 *  @router.post("/x", dependencies=[Depends(verify_token)]). */
function routeCallHasAuthDependency(call: SyntaxNode): boolean {
  const args = call.childForFieldName("arguments");
  if (!args) return false;
  const kw = args.namedChildren.find(
    (n) =>
      n !== null &&
      n.type === "keyword_argument" &&
      n.childForFieldName("name")?.text === "dependencies",
  );
  const value = kw?.childForFieldName("value");
  return value ? callsWithAuthDependency(value) : false;
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
}

const APP_SCOPED_RECEIVER = /^(?:app|application)$/;

function collectPyMiddleware(tree: Tree): PyMiddlewareScopes {
  const scopes: PyMiddlewareScopes = {
    global: { hasAuth: false, hasValidation: false, hasRateLimit: false },
    byReceiver: new Map(),
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
      if (nameHasAuthToken(fnName)) mark(receiver, appWide, "hasAuth");
      if (RATE_NAMES.test(fnName)) mark(receiver, appWide, "hasRateLimit");
      if (VAL_NAMES.test(fnName)) mark(receiver, appWide, "hasValidation");
    }
  }

  for (const call of tree.rootNode.descendantsOfType("call")) {
    if (!call || call.hasError) continue;
    const fn = call.childForFieldName("function");
    if (!fn) continue;
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
    if (value && callsWithAuthDependency(value)) mark(left.text, false, "hasAuth");
  }
  return scopes;
}

/** File-level OR of every scope: the seam-2 index entry (public FileMiddleware
 *  shape, unchanged) and the regex fallback's inheritance input. Route-level
 *  inheritance on the AST path does NOT read this OR; extractPythonRoutesAst
 *  consumes collectPyMiddleware directly (receiver-scoped). */
export function extractPythonFileMiddlewareAst(tree: Tree): FileMiddleware {
  const scopes = collectPyMiddleware(tree);
  const all = [scopes.global, ...scopes.byReceiver.values()];
  return {
    hasAuth: all.some((s) => s.hasAuth),
    hasValidation: all.some((s) => s.hasValidation),
    hasRateLimit: all.some((s) => s.hasRateLimit),
  };
}

export function extractPythonRoutesAst(tree: Tree, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const routerNames = collectRouterNames(tree.rootNode);
  const scopes = collectPyMiddleware(tree);
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
    const paramAuth = paramsHaveAuthDependency(definition);
    // Validation / rate-limit lanes match NON-ROUTE decorator CALLEE NAMES only
    // (@limiter.limit -> "limiter.limit", @validate_schema -> "validate_schema"),
    // never argument or path text: @app.post("/validate") is a path, not
    // validation middleware, and must not bless its lane.
    const laneNames = decorators
      .filter((d) => asRouteDecorator(d, routerNames) === null)
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
      const routeFromDecorator = asRouteDecorator(dec, routerNames);
      // asApiViewDecorator is only consulted when the decorator is not already a
      // router/app route, so the api_view-only permission_classes bless below can
      // key off apiViewRoute !== null.
      const apiViewRoute = routeFromDecorator ? null : asApiViewDecorator(dec, definition);
      const route = routeFromDecorator ?? apiViewRoute;
      if (!route) continue;
      const fromApiView = apiViewRoute !== null;
      routes.push({
        method: route.method,
        path: route.path,
        file: filePath,
        // 1-based, the route decorator's OWN line (not the dd's first decorator,
        // not the def line): regex parity, and the @vibedrift-public suppression
        // binding depends on it.
        line: dec.startPosition.row + 1,
        hasAuth:
          authDecoratorRows.some((row) => row > dec.startPosition.row) ||
          (fromApiView &&
            permissionClassRows.some((row) => row > dec.startPosition.row)) ||
          paramAuth ||
          routeCallHasAuthDependency(route.call) ||
          scopes.global.hasAuth ||
          (scopes.byReceiver.get(route.receiver)?.hasAuth ?? false),
        hasValidation:
          perVal ||
          scopes.global.hasValidation ||
          (scopes.byReceiver.get(route.receiver)?.hasValidation ?? false),
        hasRateLimit:
          perRate ||
          scopes.global.hasRateLimit ||
          (scopes.byReceiver.get(route.receiver)?.hasRateLimit ?? false),
        hasErrorHandler: false, // write-only field; JS AST extractor hard-codes false too
      });
    }
  }
  return routes;
}
