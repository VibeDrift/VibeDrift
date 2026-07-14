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

export const SECURITY_AST_PY = {
  ROUTE_METHODS, HTTP_VERBS, MUTATING_VERBS, ROUTER_RECEIVER, ROUTER_CONSTRUCTORS,
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

function resolveMethod(attr: string, _args: SyntaxNode): string {
  if (attr !== "route" && attr !== "api_route") return attr.toUpperCase();
  return "GET"; // Flask default; the methods= kwarg lands in Task 2
}

export function extractPythonRoutesAst(tree: Tree, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const routerNames = collectRouterNames(tree.rootNode);
  for (const dd of tree.rootNode.descendantsOfType("decorated_definition")) {
    // Error recovery can merge adjacent handlers' decorators into one dd;
    // blessing (or even extracting) across that boundary is forbidden.
    if (!dd || dd.hasError) continue;
    const definition = dd.childForFieldName("definition");
    if (!definition || definition.type !== "function_definition") continue; // @dataclass wraps class_definition
    const decorators = dd.namedChildren.filter(
      (n): n is SyntaxNode => n !== null && n.type === "decorator",
    );
    // Per-route signals land in Task 3; receiver-scoped middleware inheritance
    // lands in Task 4. Task 1 emits structurally-correct routes with the
    // never-false-bless default.
    const perAuth = false;
    const perVal = false;
    const perRate = false;
    for (const dec of decorators) {
      const route = asRouteDecorator(dec, routerNames);
      if (!route) continue;
      routes.push({
        method: route.method,
        path: route.path,
        file: filePath,
        // 1-based, the route decorator's OWN line (not the dd's first decorator,
        // not the def line): regex parity, and the @vibedrift-public suppression
        // binding depends on it.
        line: dec.startPosition.row + 1,
        hasAuth: perAuth,
        hasValidation: perVal,
        hasRateLimit: perRate,
        hasErrorHandler: false, // write-only field; JS AST extractor hard-codes false too
      });
    }
  }
  return routes;
}
