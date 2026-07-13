/**
 * Shared route-auth classifier for the in-loop `validate_change` security check.
 *
 * It deliberately reuses the SAME AST route extractor the batch security
 * detector uses (`extractJsRoutesAst`), so its verdict can never contradict the
 * batch detector for the same body. Given a single proposed function body, it
 * reports whether that body registers a mutating route (POST/PUT/PATCH/DELETE
 * and Express `.all()`) and whether EVERY such route carries a visible
 * per-route auth guard.
 *
 * Router-scope middleware (`router.use(requireAuth)`) is intentionally NOT
 * consulted here: a single proposed body cannot see its router's setup, so we
 * pass `undefined` for the file-middleware arg. That invisibility is exactly why
 * the consumer hedges to low confidence and never states "this route is
 * unauthed" as fact.
 *
 * JS/TS only: the AST route extractor is JS/TS. Any other language returns null.
 */
import { parseFile } from "../utils/ast.js";
import { extractJsRoutesAst, SECURITY_AST } from "./security-ast.js";
import type { SourceFile, SupportedLanguage } from "../core/types.js";

// Only JS/TS extensions map to a language here; everything else yields null and
// the classifier bails (the AST route extractor is JS/TS-specific).
const JS_TS_EXT: Record<string, SupportedLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
};

export interface RouteAuthClassification {
  /** At least one route in the body uses a mutating method (POST/PUT/PATCH/DELETE
   *  and Express `.all()`). */
  isMutatingRoute: boolean;
  /** EVERY mutating route in the body carries a visible per-route auth guard.
   *  Conservative: a single unguarded mutating route makes this false. */
  hasVisibleAuth: boolean;
}

/**
 * Classify a proposed body's route-auth posture, or null when there is nothing
 * to judge (unsupported language, unparseable body, or no route at all).
 */
export async function classifyRouteAuth(
  body: string,
  relTarget: string,
): Promise<RouteAuthClassification | null> {
  const ext = relTarget.split(".").pop()?.toLowerCase() ?? "";
  const language = JS_TS_EXT[ext];
  if (!language) return null; // JS/TS only: the AST route extractor is JS/TS.

  const file: SourceFile = {
    path: relTarget,
    relativePath: relTarget,
    language,
    content: body,
    lineCount: body.split("\n").length,
  };
  const tree = await parseFile(file);
  if (!tree) return null;

  // No file-middleware arg: router-scope `router.use()` auth is deliberately not
  // visible from a single proposed body, so it must not silence the check.
  const routes = extractJsRoutesAst(tree, relTarget, undefined);
  if (routes.length === 0) return null; // not a route body → nothing to compare.

  // RouteInfo.method is upper-cased by the extractor; SECURITY_AST.MUTATING is
  // lower-case. Normalize before the membership test.
  const mutating = routes.filter((r) => SECURITY_AST.MUTATING.has(r.method.toLowerCase()));
  return {
    isMutatingRoute: mutating.length > 0,
    // `.every` over an empty set is vacuously true; that only matters when there
    // is no mutating route, in which case the consumer ignores this field.
    hasVisibleAuth: mutating.every((r) => r.hasAuth === true),
  };
}
