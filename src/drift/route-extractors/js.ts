/**
 * JavaScript / TypeScript route extractor — Express / Hono / Fastify / Koa.
 * Registered under both the `javascript` and `typescript` dispatch keys.
 *
 * AST when a parsed tree is available (delegated to security-ast), regex
 * fallback otherwise.
 */

import type { DriftFile } from "../types.js";
import { extractJsRoutesAst } from "../security-ast.js";
import type { RouteInfo, FileMiddleware, RouteExtractor } from "./types.js";
import {
  C_STYLE_COMMENT_MARKERS,
  isCommentLine,
  inheritedAuth,
  inheritedValidation,
  inheritedRateLimit,
} from "./shared.js";
import {
  JS_ROUTE,
  JS_METHOD,
  JS_AUTH,
  JS_VALIDATION,
  JS_RATE_LIMIT,
  JS_ERROR_HANDLER,
} from "./patterns.js";

function extractJsRoutesRegex(file: DriftFile, fileMiddleware: FileMiddleware | undefined): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const lines = file.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    // Skip comment lines — prevents phantom routes from commented-out code.
    if (isCommentLine(lines[i], C_STYLE_COMMENT_MARKERS)) continue;
    const match = lines[i].match(JS_ROUTE);
    if (!match) continue;
    const path = match[1];
    const method = match[0].match(JS_METHOD)?.[1]?.toUpperCase() ?? "ANY";
    const context = lines.slice(Math.max(0, i - 5), i + 20).join("\n");

    const perAuth = JS_AUTH.test(context);
    const perVal = JS_VALIDATION.test(context);
    const perRate = JS_RATE_LIMIT.test(context);

    routes.push({
      method, path, file: file.relativePath, line: i + 1,
      hasAuth: inheritedAuth(perAuth, fileMiddleware),
      hasValidation: inheritedValidation(perVal, fileMiddleware),
      hasRateLimit: inheritedRateLimit(perRate, fileMiddleware),
      hasErrorHandler: JS_ERROR_HANDLER.test(context),
    });
  }
  return routes;
}

export const jsRouteExtractor: RouteExtractor = {
  extract(file, deps) {
    const fileMiddleware = deps.fileMw.get(file.relativePath);
    if (file.tree) {
      return extractJsRoutesAst(file.tree, file.relativePath, fileMiddleware);
    }
    return extractJsRoutesRegex(file, fileMiddleware);
  },
};
