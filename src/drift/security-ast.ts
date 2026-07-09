/**
 * AST-based route + per-route middleware extraction for JS/TS, used by
 * security-consistency.ts in place of the regex proximity-window extractor
 * whenever a parsed tree is available (see extractJsRoutes there).
 *
 * Why AST over regex: the regex path matches ANY `.get(` / `.post(` call
 * followed by a quoted string, which over-captures non-router receivers —
 * cache.get("user:1"), c.get("session") (Hono context), req.headers.get(...),
 * config.get("PORT"), axios.get(url). Those aren't route registrations.
 *
 * The fix is two gates, both applied structurally instead of textually:
 *   1. Receiver whitelist — the object the method is called on must look like
 *      a router/app identifier (ROUTER_RECEIVER below).
 *   2. Leading-slash path gate — the first call argument must be a string
 *      literal starting with "/". A real Express-style route path always is;
 *      cache keys, header names, and env var names generally aren't.
 * Per-route middleware is read from the actual argument list (everything
 * between the path and the final handler arg) rather than a fixed line
 * window, so it can't accidentally pick up an unrelated `requireAuth` call
 * that happens to sit within N lines of the route registration.
 */

import type { Tree, SyntaxNode } from "../core/types.js";
import type { RouteInfo, FileMiddleware } from "./security-consistency.js";

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all"]);
const MUTATING = new Set(["post", "put", "patch", "delete"]);

// Receiver identifiers that plausibly register routes. Combined with the
// "first arg is a string path starting with /" gate below, this excludes the
// real over-capture seen in the corpus: cache.get / c.get / headers.get /
// config.get / axios.get (none of which pass BOTH the receiver name and the
// leading-slash path check).
const ROUTER_RECEIVER = /^(?:app|application|server|router|api|route|v\d+|[a-z]*[Rr]outer)$/;

const AUTH_MW = /(?:requireAuth|isAuthenticated|passport|authenticate|verifyToken|jwt|authMiddleware|ensureAuth|withAuth|checkAuth|authorize|requireLogin)/i;
const VAL_MW = /(?:validate|validator|joi|zod|yup|celebrate|schema|checkSchema)/i;
const RATE_MW = /(?:rateLimit|ratelimit|throttle|limiter|slowDown)/i;

export const SECURITY_AST = { ROUTE_METHODS, MUTATING, ROUTER_RECEIVER, AUTH_MW, VAL_MW, RATE_MW };

/** Text of a string / template_string node with the quotes/backticks stripped. */
function stringValue(node: SyntaxNode): string | null {
  if (node.type === "string" || node.type === "template_string") {
    const raw = node.text;
    return raw.length >= 2 ? raw.slice(1, -1) : "";
  }
  return null;
}

/** The receiver identifier name of a `X.method(...)` call, or null. Handles a
 *  bare identifier (`router`) and a trailing member (`this.router`, `app.route`
 *  chains resolve to the nearest identifier). */
function receiverName(objNode: SyntaxNode): string | null {
  if (objNode.type === "identifier") return objNode.text;
  if (objNode.type === "member_expression") {
    const prop = objNode.childForFieldName("property");
    return prop ? prop.text : null;
  }
  return null;
}

/** Names referenced by a middleware argument: a bare identifier (`requireAuth`)
 *  or the callee of a call (`passport.authenticate(...)` -> "passport.authenticate"). */
function middlewareNames(arg: SyntaxNode): string[] {
  if (arg.type === "identifier") return [arg.text];
  if (arg.type === "call_expression") {
    const fn = arg.childForFieldName("function");
    if (fn) return [fn.text];
  }
  if (arg.type === "member_expression") return [arg.text];
  if (arg.type === "array") {
    return arg.namedChildren.filter((n): n is SyntaxNode => n !== null).flatMap(middlewareNames);
  }
  return [];
}

export function extractJsRoutesAst(
  tree: Tree,
  filePath: string,
  fileMw: FileMiddleware | undefined,
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const calls = tree.rootNode.descendantsOfType("call_expression");
  for (const call of calls) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") continue;
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property");
    if (!obj || !prop) continue;
    const method = prop.text.toLowerCase();
    if (!SECURITY_AST.ROUTE_METHODS.has(method)) continue;
    const receiver = receiverName(obj);
    if (!receiver || !SECURITY_AST.ROUTER_RECEIVER.test(receiver)) continue;

    const args = call.childForFieldName("arguments");
    if (!args) continue;
    const named = args.namedChildren.filter((n): n is SyntaxNode => n !== null);
    if (named.length === 0) continue;
    const path = stringValue(named[0]);
    // A real Express route path is a string literal starting with "/". This is
    // the second half of the over-capture guard (cache.get("key") etc. fail).
    if (path === null || !path.startsWith("/")) continue;

    // Middleware = every arg between the path and the handler (the last arg).
    const mwArgs = named.length >= 3 ? named.slice(1, -1) : [];
    const names = mwArgs.flatMap(middlewareNames);
    const perAuth = names.some((n) => SECURITY_AST.AUTH_MW.test(n));
    const perVal = names.some((n) => SECURITY_AST.VAL_MW.test(n));
    const perRate = names.some((n) => SECURITY_AST.RATE_MW.test(n));

    routes.push({
      method: method.toUpperCase(),
      path,
      file: filePath,
      line: call.startPosition.row + 1,
      hasAuth: perAuth || (fileMw?.hasAuth ?? false),
      hasValidation: perVal || (fileMw?.hasValidation ?? false),
      hasRateLimit: perRate || (fileMw?.hasRateLimit ?? false),
      hasErrorHandler: false,
    });
  }
  return routes;
}

/**
 * Router/app-level middleware registered via `router.use(...)` / `app.use(...)`
 * (Express/Hono/Fastify/Koa). This is the AST counterpart of the jsAuth /
 * jsRateLimit / jsValidation regexes in security-consistency.ts's
 * buildFileMiddlewareIndex, gated the same way extractJsRoutesAst is: the
 * receiver must look like a router/app identifier (ROUTER_RECEIVER), so
 * unrelated `.use()` calls (an EventEmitter, an express `app.use` for static
 * assets with no middleware keyword, etc.) don't get picked up.
 */
export function extractFileMiddlewareAst(tree: Tree): FileMiddleware {
  let hasAuth = false;
  let hasValidation = false;
  let hasRateLimit = false;
  const calls = tree.rootNode.descendantsOfType("call_expression");
  for (const call of calls) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") continue;
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property");
    if (!obj || !prop || prop.text !== "use") continue;
    const receiver = receiverName(obj);
    if (!receiver || !SECURITY_AST.ROUTER_RECEIVER.test(receiver)) continue;

    const argText = call.childForFieldName("arguments")?.text ?? "";
    if (SECURITY_AST.AUTH_MW.test(argText)) hasAuth = true;
    if (SECURITY_AST.VAL_MW.test(argText)) hasValidation = true;
    if (SECURITY_AST.RATE_MW.test(argText)) hasRateLimit = true;
  }
  return { hasAuth, hasValidation, hasRateLimit };
}
