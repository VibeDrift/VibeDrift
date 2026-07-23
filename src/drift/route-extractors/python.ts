/**
 * Python route extractor — Flask / FastAPI.
 *
 * AST on a CLEAN parse (delegated to security-ast-python), regex fallback
 * otherwise. `balancedDecoratorArgs` is Python-specific and lives here.
 */

import type { DriftFile } from "../types.js";
import { extractPythonRoutesAst } from "../security-ast-python.js";
import type { RouteInfo, FileMiddleware, RouteExtractor } from "./types.js";
import {
  MUTATION_METHODS,
  PYTHON_COMMENT_MARKERS,
  isCommentLine,
  inheritedAuth,
  inheritedValidation,
  inheritedRateLimit,
} from "./shared.js";
import {
  PY_ROUTE,
  PY_DECORATOR_VERB,
  PY_METHODS_KWARG,
  PY_METHODS_VERBS,
  PY_AUTH,
  PY_VALIDATION,
  PY_RATE_LIMIT,
  PY_ERROR_HANDLER,
} from "./patterns.js";

/** Text inside a Python route decorator's parentheses: from the first "(" on
 *  line `start` to its matching ")", spanning continuation lines. Bounded by
 *  paren depth so `methods=` is read from THIS decorator only and can never
 *  bleed into an adjacent route's decorator. Parens inside string literals
 *  (e.g. a route path like "/weird(path") are skipped, so an unbalanced literal
 *  paren cannot throw off the depth count and leak into the next route. */
function balancedDecoratorArgs(lines: string[], start: number): string {
  let depth = 0;
  let started = false;
  let out = "";
  let quote: string | null = null; // active string-literal quote char, or null
  for (let j = start; j < lines.length; j++) {
    const line = lines[j];
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (quote) {
        // Inside a string literal: only a matching unescaped quote ends it;
        // parens here are path/text, not structure.
        if (ch === "\\") {
          if (started) out += ch + (line[k + 1] ?? "");
          k++; // skip the escaped char
          continue;
        }
        if (ch === quote) quote = null;
        if (started) out += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        if (started) out += ch;
        continue;
      }
      if (ch === "(") {
        depth++;
        started = true;
      } else if (ch === ")") {
        depth--;
      }
      if (started) out += ch;
      if (started && depth === 0) return out;
    }
    out += " ";
    if (j - start > 6) return out; // defensive cap for a malformed decorator
  }
  return out;
}

function extractPythonRoutesRegex(file: DriftFile, fileMiddleware: FileMiddleware | undefined): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const lines = file.content.split("\n");

  let inDocstring = false;
  for (let i = 0; i < lines.length; i++) {
    // Track triple-quoted docstring blocks: a route-shaped line inside a
    // docstring is documentation, not a real registration. An odd count of
    // triple-quotes on a line toggles the block state.
    const tripleQuotes = (lines[i].match(/"""|'''/g) ?? []).length;
    if (inDocstring) {
      if (tripleQuotes % 2 === 1) inDocstring = false;
      continue;
    }
    if (tripleQuotes % 2 === 1) { inDocstring = true; continue; }
    // Skip comment lines — Python uses '#'. Prevents phantom routes from
    // commented-out code.
    if (isCommentLine(lines[i], PYTHON_COMMENT_MARKERS)) continue;
    const match = lines[i].match(PY_ROUTE);
    if (!match) continue;
    const path = match[1];
    // Flask's @app.route defaults to GET when no methods= kwarg is present, NOT an
    // unknown "ANY". Decorator-verb style (@app.post) resolves directly; the
    // methods=[...] kwarg (Flask/others) is parsed so a mutating verb classifies
    // the route as mutating. The kwarg is read from the route's own decorator
    // via balanced paren scanning, so it can never bleed into an adjacent
    // route's decorator even when routes sit right next to each other.
    const decoratorVerb = lines[i].match(PY_DECORATOR_VERB)?.[1]?.toUpperCase();
    let method = decoratorVerb ?? "GET";
    const decoratorArgs = balancedDecoratorArgs(lines, i);
    const methodsKw = decoratorArgs.match(PY_METHODS_KWARG);
    if (methodsKw) {
      const verbs = (methodsKw[1].match(PY_METHODS_VERBS) ?? [])
        .map((v) => v.replace(/["']/g, "").toUpperCase());
      const mutating = verbs.find((v) => MUTATION_METHODS.includes(v));
      method = mutating ?? verbs[0] ?? method;
    }
    const context = lines.slice(i, Math.min(lines.length, i + 30)).join("\n");

    const perAuth = PY_AUTH.test(context);
    const perVal = PY_VALIDATION.test(context);
    const perRate = PY_RATE_LIMIT.test(context);

    routes.push({
      method, path, file: file.relativePath, line: i + 1,
      hasAuth: inheritedAuth(perAuth, fileMiddleware),
      hasValidation: inheritedValidation(perVal, fileMiddleware),
      hasRateLimit: inheritedRateLimit(perRate, fileMiddleware),
      hasErrorHandler: PY_ERROR_HANDLER.test(context),
    });
  }
  return routes;
}

export const pythonRouteExtractor: RouteExtractor = {
  extract(file, deps) {
    // AST only on a CLEAN parse: tree-sitter always returns a tree for broken
    // Python (with ERROR nodes), and error recovery can erase the whole file's
    // decorator structure or merge adjacent handlers' decorators into one
    // decorated_definition (a cross-bless hazard). Any parse error routes the
    // whole file to the regex, byte-identical to today's behavior INCLUDING the
    // regex path's known over-blesses (see the pinned-legacy test).
    if (file.tree && !file.tree.rootNode.hasError) {
      return extractPythonRoutesAst(file.tree, file.relativePath, deps.xfile);
    }
    return extractPythonRoutesRegex(file, deps.fileMw.get(file.relativePath));
  },
};
