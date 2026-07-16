/**
 * Route-level security posture drift detector with router-scope middleware
 * tracing.
 *
 * Three phases:
 *
 *   Phase 1 — file-level middleware index.
 *     Per file, scan once for middleware applied at the router/app level:
 *       Express:  router.use(requireAuth)        → auth
 *                 app.use(rateLimiter)           → rate-limit
 *       Echo:     e.Use(authMiddleware)          → auth
 *                 e.Group(...).Use(...)          → auth on the group
 *       Flask:    @app.before_request def auth() → auth
 *                 @blueprint.before_request      → auth
 *       FastAPI:  app.add_middleware(AuthMW)     → auth
 *     Build fileLevelMiddleware: Map<filePath, {auth, validation, rateLimit}>
 *
 *   Phase 2 — inheritance resolution.
 *     For each route in file f, the route's effective protection is:
 *       perRouteMiddleware(r) UNION fileLevelMiddleware[f]
 *     This catches the common false-negative where `router.use(requireAuth)`
 *     at the top of a file protects every handler below it but a 10-line
 *     proximity check sees no auth on any of them.
 *
 *   Phase 3 — dominance vote (existing logic).
 *     For each property p in {auth, validation, rate-limit}: if ≥75% of
 *     routes have p (after inheritance), flag the minority that doesn't.
 *
 * Limitations: cross-file `app.use('/api', apiRouter)` mounting isn't
 * resolved here — the apiRouter file's middleware doesn't propagate to the
 * mount point. Resolving that would require a router import graph.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile } from "./types.js";
import { SECURITY_SUBCATEGORIES } from "./types.js";
import { pickIntentHint } from "./utils.js";
import { extractJsRoutesAst, extractFileMiddlewareAst, SECURITY_AST } from "./security-ast.js";
import { extractPythonRoutesAst, extractPythonFileMiddlewareAst } from "./security-ast-python.js";
import { extractGoRoutesAst, extractGoFileMiddlewareAst } from "./security-ast-go.js";
import { extractRustRoutesAst, extractRustFileMiddlewareAst } from "./security-ast-rust.js";
import { buildXFileIndex } from "./security-xfile-index.js";
import type { CrossFileIndex } from "./security-xfile-index.js";
import { applyRouteSuppressions, buildSuppressionAuditFinding } from "./security-suppression.js";

// Canonical mutating set (upper-cased), shared with the in-loop classifier via
// SECURITY_AST.MUTATING so batch and in-loop can never disagree. Includes ALL
// (Express .all() handles every verb) so an unauthed .all() route is not
// silently excluded from the auth vote.
const MUTATION_METHODS = [...SECURITY_AST.MUTATING].map((m) => m.toUpperCase());
// Body-bearing methods for the validation vote (DELETE usually has no body).
const BODY_METHODS = ["POST", "PUT", "PATCH", "ALL"];

// ─── Hedged copy for auth routes whose hook could not be verified ────────────
//
// A route only carries `authUnsureHook` on the Python, Go, or Rust AST path,
// and only when `hasAuth === false` (a blessed route never sets it). Task 4
// turns the flat "no auth" copy into a HEDGE that names the exact auth hook
// the user should verify. The route stays not-authed in every vote — this
// is copy only. JS/TS routes and the regex fallback never set the field, so
// they always take the flat arm and render byte-identically. No em-dash /
// double hyphen in the hedged strings (comma/colon/period only).

/** Per-deviator hedged pattern naming the unresolved hook, e.g.
 *  `POST /x: auth not confirmed, double check hook 'verify_session'`. */
function hedgedDeviatorPattern(r: RouteInfo): string {
  return `${r.method} ${r.path}: auth not confirmed, double check hook '${r.authUnsureHook}'`;
}

// Language-appropriate noun (with article) for the unverified auth mechanism the
// hedge names — a hedge only arises on the Python/Go/Rust AST paths. A finding
// whose hedged hooks span MORE than one language falls back to the neutral phrase.
const HOOK_PHRASE: Record<string, string> = {
  python: "a before_request hook",
  go: "a middleware",
  rust: "an extractor or layer",
};
const NEUTRAL_HOOK_PHRASE = "an auth hook";

/** Source language of a route's file, by extension. Null when unknown. */
function langOfFile(file: string): string | null {
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".rs")) return "rust";
  return null;
}

/** Sentence appended to an auth finding's recommendation when some deviators are
 *  unsure (their hook body could not be verified). Empty string when none are
 *  hedged, so a confident finding's recommendation is byte-identical. The noun is
 *  language-aware (a before_request hook / a middleware / an extractor or layer),
 *  falling back to the neutral "an auth hook" when the hedged hooks span multiple
 *  languages. `names` is the sorted distinct set of hook names. The terminal reads
 *  the noun + names back out of this sentence (noun-agnostic), so its shape —
 *  "could not be confirmed: <a|an> <noun> (<names>)" — must stay stable. */
function hedgeRecommendationSuffix(deviators: RouteInfo[]): string {
  const hedged = deviators.filter((r) => r.authUnsureHook);
  if (hedged.length === 0) return "";
  const names = [...new Set(hedged.map((r) => r.authUnsureHook!))].sort().join(", ");
  const langs = [...new Set(hedged.map((r) => langOfFile(r.file)))];
  const phrase = langs.length === 1 && langs[0] ? (HOOK_PHRASE[langs[0]] ?? NEUTRAL_HOOK_PHRASE) : NEUTRAL_HOOK_PHRASE;
  return ` ${hedged.length} of these could not be confirmed: ${phrase} (${names}) may authenticate them but its body could not be verified. Double check those hooks before treating the routes as unauthenticated.`;
}

// Does the codebase use auth machinery anywhere? If it does, a mutating route
// with no auth is drift ("you know how to auth — this route forgot"), not an
// intentionally-public API. Specific symbols only, to keep false positives low.
function repoHasAuthMachinery(files: DriftFile[]): boolean {
  const re = /\b(requireAuth|isAuthenticated|verifyToken|authMiddleware|ensureAuth|withAuth|jwt_required|login_required|AuthMiddleware|passport)\b/;
  return files.some((f) => !!f.language && re.test(f.content));
}

/**
 * Absolute baseline for the uniform-wrongness blind spot: the dominance vote
 * (analyzeSecurityProperty) goes SILENT when 0% of routes have auth (ratio=0
 * fails the ratio>0.75 gate), so an AI that wrote every mutating endpoint
 * without auth produced a clean grade. This fires on uniformly-unauthed
 * MUTATING routes — but only with a baseline reason: either the repo uses auth
 * elsewhere, or a CLAUDE.md/AGENTS.md hint declares auth required. With neither,
 * we stay silent (could be an intentionally-public API).
 */
function analyzeUniformAuthGap(
  routes: RouteInfo[],
  opts: { hasMachinery: boolean; hint: ReturnType<typeof pickIntentHint>; healthPaths: RegExp },
): DriftFinding | null {
  const mutating = routes.filter((r) => MUTATION_METHODS.includes(r.method) && !opts.healthPaths.test(r.path));
  const unauthed = mutating.filter((r) => !r.hasAuth);
  if (unauthed.length === 0) return null;
  if (!opts.hasMachinery && !opts.hint) return null; // no baseline → maybe intentionally public

  const declared = !!opts.hint;
  // Evidence-driven confidence: a declared rule is strong; "uses auth elsewhere"
  // is a softer signal.
  const confidence = declared ? 0.9 : 0.6;
  const have = mutating.length - unauthed.length;

  return {
    detector: "security_posture",
    subCategory: SECURITY_SUBCATEGORIES.auth,
    driftCategory: "security_posture",
    severity: unauthed.length > 2 ? "error" : "warning",
    confidence,
    finding: declared
      ? `${unauthed.length} mutating route(s) lack auth, but ${opts.hint!.source} declares authentication is required`
      : `${unauthed.length} mutating route(s) lack auth while the codebase uses auth elsewhere`,
    dominantPattern: declared ? `${opts.hint!.label}` : "auth on mutating routes",
    dominantCount: have,
    totalRelevantFiles: mutating.length,
    consistencyScore: mutating.length ? Math.round((have / mutating.length) * 100) : 0,
    deviatingFiles: unauthed.map((r) => ({
      path: r.file,
      detectedPattern: r.authUnsureHook ? hedgedDeviatorPattern(r) : `${r.method} ${r.path} — no auth`,
      evidence: [{ line: r.line, code: `${r.method} ${r.path}` }],
    })),
    dominantFiles: [],
    recommendation:
      (declared
        ? `${opts.hint!.source}:${opts.hint!.line} declares auth is required. Add auth middleware to these ${unauthed.length} mutating route(s), or mark them explicitly public.`
        : `These ${unauthed.length} mutating route(s) have no auth while the codebase authenticates elsewhere. Add auth middleware, or confirm they are intentionally public.`) +
      hedgeRecommendationSuffix(unauthed),
  };
}

export interface FileMiddleware {
  hasAuth: boolean;
  hasValidation: boolean;
  hasRateLimit: boolean;
}

export interface RouteInfo {
  method: string;
  path: string;
  file: string;
  line: number;
  hasAuth: boolean;
  hasValidation: boolean;
  hasRateLimit: boolean;
  hasErrorHandler: boolean;
  /** Python or Go AST path only: the name of a middleware/hook whose BODY is
   *  auth-flavored but statically unverifiable (an opaque helper, an imported or
   *  selector/attribute target, a duplicate def). Present ONLY when
   *  `hasAuth === false`; `hasAuth === true` always omits it. An "unsure" route
   *  still counts as not-authed in every vote (never blesses) — this field only
   *  lets a renderer hedge the finding copy to name the exact middleware the user
   *  should double-check. Never set on the JS/TS AST path or the regex fallback,
   *  so those routes serialize byte-identically. */
  authUnsureHook?: string;
}

// ─── Phase 1: file-level middleware index ────────────────────────────

function buildFileMiddlewareIndex(files: DriftFile[]): Map<string, FileMiddleware> {
  const index = new Map<string, FileMiddleware>();
  for (const file of files) {
    if (!file.language) continue;
    const c = file.content;

    // Python: Flask / FastAPI. AST when a clean parsed tree is available; regex
    // fallback otherwise. Byte-compat: for every non-(python-with-clean-tree)
    // file, ALL regex arms (js/go/py) keep running on the raw content exactly as
    // today. For a python file WITH a clean tree the js and go arms are forced
    // false: on python content they are pure cross-language noise (a docstring
    // mentioning app.use(authMiddleware) matches the jsAuth regex), and noise in
    // this index is a file-wide bless.
    const pythonAst = file.language === "python" && !!file.tree && !file.tree.rootNode.hasError;
    const goAst = file.language === "go" && !!file.tree && !file.tree.rootNode.hasError;
    // Rust is AST-only (no regex fallback anywhere): a clean-parsed rust file is
    // handled by the Rust lane below and forces every js/go/py regex arm false for
    // the same cross-language-noise reason as pythonAst/goAst (a rust doc-comment
    // mentioning app.use(...) matches the jsAuth regex). A tree-less / errored rust
    // file has no lane at all -> its index entry stays all-false, byte-identical.
    const rustAst = file.language === "rust" && !!file.tree && !file.tree.rootNode.hasError;

    // JS/TS — Express / Hono / Fastify / Koa. AST when a parsed tree is
    // available (structural: gated on a router/app receiver, not just
    // proximity of the keyword); regex fallback otherwise.
    let jsAuth: boolean, jsRateLimit: boolean, jsValidation: boolean;
    if (file.tree && (file.language === "javascript" || file.language === "typescript")) {
      const mw = extractFileMiddlewareAst(file.tree);
      jsAuth = mw.hasAuth;
      jsRateLimit = mw.hasRateLimit;
      jsValidation = mw.hasValidation;
    } else if (pythonAst || goAst || rustAst) {
      // Cross-language noise on any clean-tree language is a file-wide bless: on a
      // clean-parsed python, go OR rust file the js regex arms are pure noise (they
      // match app.use(...) text inside docstrings/comments/doc-comments), so force
      // them false rather than let them file-wide-bless that file's routes.
      jsAuth = false;
      jsRateLimit = false;
      jsValidation = false;
    } else {
      // router.use(requireAuth) | app.use(passport.authenticate(...)) | router.use(authMiddleware)
      jsAuth = /(?:router|app|router\w*|api\w*)\s*\.\s*use\s*\(\s*[^,)]*?(?:auth|requireAuth|isAuthenticated|passport|verifyToken|jwt)/i.test(c);
      jsRateLimit = /(?:router|app)\s*\.\s*use\s*\(\s*[^,)]*?(?:rateLimit|throttle|limiter)/i.test(c);
      jsValidation = /(?:router|app)\s*\.\s*use\s*\(\s*[^,)]*?(?:validate|validator|joi|zod|celebrate)/i.test(c);
    }

    // Go: Gin / Echo / chi / Gorilla. AST when a clean parsed tree is available;
    // regex fallback otherwise (keeping Phase A's !pythonAst guards
    // byte-identical). Byte-compat: for every non-(python-or-go-with-clean-tree)
    // file, ALL regex arms keep running on the raw content exactly as today.
    let goAuth: boolean, goRateLimit: boolean, goValidation: boolean;
    if (goAst) {
      const mw = extractGoFileMiddlewareAst(file.tree!);
      goAuth = mw.hasAuth;
      goRateLimit = mw.hasRateLimit;
      goValidation = mw.hasValidation;
    } else {
      goAuth = !pythonAst && !rustAst && /\.\s*Use\s*\(\s*[^,)]*?(?:[Aa]uth|RequireAuth|VerifyToken|JWT|Bearer)/.test(c);
      goRateLimit = !pythonAst && !rustAst && /\.\s*Use\s*\(\s*[^,)]*?(?:[Rr]ateLimit|[Tt]hrottle|[Ll]imiter)/.test(c);
      goValidation = !pythonAst && !rustAst && /\.\s*Use\s*\(\s*[^,)]*?(?:[Vv]alidate|[Vv]alidator)/.test(c);
    }

    // Python — Flask / FastAPI
    // @app.before_request def f() | @blueprint.before_request | app.add_middleware(AuthMW)
    let pyAuth: boolean, pyRateLimit: boolean, pyValidation: boolean;
    if (pythonAst) {
      const mw = extractPythonFileMiddlewareAst(file.tree!);
      pyAuth = mw.hasAuth;
      pyRateLimit = mw.hasRateLimit;
      pyValidation = mw.hasValidation;
    } else {
      // Forced false on a clean-parsed go OR rust file for the same cross-language
      // noise reason as above (a go comment / rust doc-comment containing
      // login_required currently sets pyAuth for that file).
      pyAuth = !goAst && !rustAst && /(?:@\w+\.before_request|@blueprint\.before_request|add_middleware\s*\([^,)]*[Aa]uth|@?\bjwt_required\b|@?\blogin_required\b)/.test(c);
      pyRateLimit = !goAst && !rustAst && /(?:@\w+\.\w+\s*\([^)]*[Ll]imit|RateLimiter|Limiter\(|add_middleware\s*\([^,)]*[Ll]imit)/.test(c);
      pyValidation = !goAst && !rustAst && /add_middleware\s*\([^,)]*[Vv]alid/.test(c);
    }

    // Rust — Axum / Actix / Rocket. AST when a clean parsed tree is available;
    // there is NO regex fallback for Rust (an absent / errored tree yields
    // all-false lanes). extractRustFileMiddlewareAst returns all-false
    // unconditionally: Axum .layer auth is CHAIN-scoped (wraps only its fluent
    // subtree), so there is no safe FILE-level Rust auth OR — the route extractor
    // computes covering-layer auth from the tree itself. This lane exists for seam
    // parity; it never blesses (mirror how the Go/Python AST paths ignore this OR
    // for auth). For every non-(rust-with-clean-tree) file it is all-false, so the
    // final OR below is byte-identical to today.
    let rustAuth: boolean, rustRateLimit: boolean, rustValidation: boolean;
    if (rustAst) {
      const mw = extractRustFileMiddlewareAst(file.tree!);
      rustAuth = mw.hasAuth;
      rustRateLimit = mw.hasRateLimit;
      rustValidation = mw.hasValidation;
    } else {
      rustAuth = false;
      rustRateLimit = false;
      rustValidation = false;
    }

    index.set(file.relativePath, {
      hasAuth: jsAuth || goAuth || pyAuth || rustAuth,
      hasValidation: jsValidation || goValidation || pyValidation || rustValidation,
      hasRateLimit: jsRateLimit || goRateLimit || pyRateLimit || rustRateLimit,
    });
  }
  return index;
}

// ─── Route extraction (per-route middleware via proximity) ──────────

function extractRoutes(
  files: DriftFile[],
  fileMw: Map<string, FileMiddleware>,
  xfile: CrossFileIndex,
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const file of files) {
    if (!file.language) continue;
    if (file.language === "go") extractGoRoutes(file, routes, fileMw, xfile);
    else if (file.language === "javascript" || file.language === "typescript") extractJsRoutes(file, routes, fileMw);
    else if (file.language === "python") extractPythonRoutes(file, routes, fileMw, xfile);
    else if (file.language === "rust") extractRustRoutes(file, routes);
  }
  return routes;
}

function extractRustRoutes(file: DriftFile, routes: RouteInfo[]) {
  // AST ONLY, and ONLY on a CLEAN parse. There is NO regex fallback for Rust
  // anywhere in this codebase: an absent or errored tree yields zero Rust routes
  // (unchanged from before this module was wired in). A parse error can only
  // shrink the recognized route set for that file, never emit a wrong route, and
  // Rust has no legacy regex path whose over-blesses we would need to preserve.
  // No FileMiddleware argument: Axum .layer scope is CHAIN-scoped, so the AST path
  // computes covering-layer auth from the tree itself (a file-level OR would
  // false-bless siblings a layer never wrapped, and the seam-2 index entry is
  // all-false for rust anyway).
  if (file.tree && !file.tree.rootNode.hasError) {
    routes.push(...extractRustRoutesAst(file.tree, file.relativePath));
  }
}

function inheritedAuth(perRoute: boolean, fileMw: FileMiddleware | undefined): boolean {
  return perRoute || (fileMw?.hasAuth ?? false);
}
function inheritedValidation(perRoute: boolean, fileMw: FileMiddleware | undefined): boolean {
  return perRoute || (fileMw?.hasValidation ?? false);
}
function inheritedRateLimit(perRoute: boolean, fileMw: FileMiddleware | undefined): boolean {
  return perRoute || (fileMw?.hasRateLimit ?? false);
}

function extractGoRoutes(file: DriftFile, routes: RouteInfo[], fileMw: Map<string, FileMiddleware>, xfile: CrossFileIndex) {
  // AST only on a CLEAN parse: tree-sitter always returns a tree for broken Go
  // (with ERROR nodes), and error recovery SWALLOWS later valid registrations
  // into a broken call's argument_list as clean-looking nested calls (a
  // cross-bless hazard). Any parse error routes the whole file to the regex,
  // byte-identical to today's behavior INCLUDING the regex path's known
  // over-blesses (see the pinned-legacy tests).
  if (file.tree && !file.tree.rootNode.hasError) {
    // No FileMiddleware argument: the AST path computes receiver-scoped
    // inheritance from the tree itself (a file-level OR would false-bless
    // mixed-receiver files, and the index entry may carry cross-language noise
    // for non-go files). The cross-file index lets an imported package
    // middleware selector resolve to its in-repo defining body (blessing still
    // requires that body to verifiably reject); an unresolved / external / index-
    // disabled selector stays UNSURE, byte-identical to the in-file-only path.
    routes.push(...extractGoRoutesAst(file.tree, file.relativePath, xfile));
    return;
  }
  extractGoRoutesRegex(file, routes, fileMw.get(file.relativePath));
}

function extractGoRoutesRegex(file: DriftFile, routes: RouteInfo[], fileMiddleware: FileMiddleware | undefined) {
  const lines = file.content.split("\n");
  const echoPattern = /\.\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/;
  const gorillaPattern = /HandleFunc\s*\(\s*"([^"]+)".*\.Methods\s*\(\s*"(\w+)"/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let method = "", path = "";
    const echoMatch = line.match(echoPattern);
    if (echoMatch) { method = echoMatch[1]; path = echoMatch[2]; }
    const gorillaMatch = line.match(gorillaPattern);
    if (gorillaMatch) { path = gorillaMatch[1]; method = gorillaMatch[2]; }
    if (!method || !path) continue;

    const context = lines.slice(Math.max(0, i - 10), i + 10).join("\n");
    const handlerContent = findHandlerContent(file.content, path);

    const perAuth = /[Aa]uth|[Tt]oken|require[A-Z]|middleware\.\w*[Aa]uth/.test(context);
    const perVal = /[Bb]ind|[Vv]alidat|[Pp]arse/.test(handlerContent);
    const perRate = /[Rr]ate[Ll]imit|[Tt]hrottle/.test(context + handlerContent);

    routes.push({
      method, path, file: file.relativePath, line: i + 1,
      hasAuth: inheritedAuth(perAuth, fileMiddleware),
      hasValidation: inheritedValidation(perVal, fileMiddleware),
      hasRateLimit: inheritedRateLimit(perRate, fileMiddleware),
      hasErrorHandler: /catch|err\s*!=\s*nil|try|except|\.catch/.test(handlerContent),
    });
  }
}

function extractJsRoutes(file: DriftFile, routes: RouteInfo[], fileMw: Map<string, FileMiddleware>) {
  const fileMiddleware = fileMw.get(file.relativePath);
  if (file.tree) {
    routes.push(...extractJsRoutesAst(file.tree, file.relativePath, fileMiddleware));
    return;
  }
  extractJsRoutesRegex(file, routes, fileMiddleware);
}

function extractJsRoutesRegex(file: DriftFile, routes: RouteInfo[], fileMiddleware: FileMiddleware | undefined) {
  const lines = file.content.split("\n");
  const expressPattern = /\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(expressPattern);
    if (!match) continue;
    const path = match[1];
    const method = match[0].match(/\.(get|post|put|patch|delete|all)/)?.[1]?.toUpperCase() ?? "ANY";
    const context = lines.slice(Math.max(0, i - 5), i + 20).join("\n");

    const perAuth = /(?:requireAuth|isAuthenticated|passport\.authenticate|verifyToken|jwt|authMiddleware)/.test(context);
    const perVal = /validate|joi|zod|yup|celebrate|body\(|query\(/.test(context);
    const perRate = /rateLimit|throttle|limiter/.test(context);

    routes.push({
      method, path, file: file.relativePath, line: i + 1,
      hasAuth: inheritedAuth(perAuth, fileMiddleware),
      hasValidation: inheritedValidation(perVal, fileMiddleware),
      hasRateLimit: inheritedRateLimit(perRate, fileMiddleware),
      hasErrorHandler: /catch|try|\.catch|next\(err/.test(context),
    });
  }
}

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

function extractPythonRoutes(
  file: DriftFile,
  routes: RouteInfo[],
  fileMw: Map<string, FileMiddleware>,
  xfile: CrossFileIndex,
) {
  // AST only on a CLEAN parse: tree-sitter always returns a tree for broken
  // Python (with ERROR nodes), and error recovery can erase the whole file's
  // decorator structure or merge adjacent handlers' decorators into one
  // decorated_definition (a cross-bless hazard). Any parse error routes the
  // whole file to the regex, byte-identical to today's behavior INCLUDING the
  // regex path's known over-blesses (see the pinned-legacy test, Task 6).
  if (file.tree && !file.tree.rootNode.hasError) {
    // No FileMiddleware argument: the AST path computes receiver-scoped
    // inheritance from the tree itself (a file-level OR would false-bless
    // mixed-receiver files, and the index entry may carry cross-language noise
    // for non-python files).
    routes.push(...extractPythonRoutesAst(file.tree, file.relativePath, xfile));
    return;
  }
  extractPythonRoutesRegex(file, routes, fileMw.get(file.relativePath));
}

function extractPythonRoutesRegex(file: DriftFile, routes: RouteInfo[], fileMiddleware: FileMiddleware | undefined) {
  const lines = file.content.split("\n");
  const routePattern = /@\w+\.(?:route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(routePattern);
    if (!match) continue;
    const path = match[1];
    // Flask's @app.route defaults to GET when no methods= kwarg is present, NOT an
    // unknown "ANY". Decorator-verb style (@app.post) resolves directly; the
    // methods=[...] kwarg (Flask/others) is parsed so a mutating verb classifies
    // the route as mutating. The kwarg is read from the route's own decorator
    // via balanced paren scanning, so it can never bleed into an adjacent
    // route's decorator even when routes sit right next to each other.
    const decoratorVerb = lines[i].match(/\.(get|post|put|patch|delete)\s*\(/)?.[1]?.toUpperCase();
    let method = decoratorVerb ?? "GET";
    const decoratorArgs = balancedDecoratorArgs(lines, i);
    const methodsKw = decoratorArgs.match(/methods\s*=\s*\[([^\]]*)\]/i);
    if (methodsKw) {
      const verbs = (methodsKw[1].match(/["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']/gi) ?? [])
        .map((v) => v.replace(/["']/g, "").toUpperCase());
      const mutating = verbs.find((v) => MUTATION_METHODS.includes(v));
      method = mutating ?? verbs[0] ?? method;
    }
    const context = lines.slice(i, Math.min(lines.length, i + 30)).join("\n");

    const perAuth = /login_required|jwt_required|@requires|permission|token/.test(context);
    const perVal = /pydantic|validate|Schema|Serializer/.test(context);
    const perRate = /rate_limit|throttle|limiter/.test(context);

    routes.push({
      method, path, file: file.relativePath, line: i + 1,
      hasAuth: inheritedAuth(perAuth, fileMiddleware),
      hasValidation: inheritedValidation(perVal, fileMiddleware),
      hasRateLimit: inheritedRateLimit(perRate, fileMiddleware),
      hasErrorHandler: /try|except|raise/.test(context),
    });
  }
}

function findHandlerContent(fullContent: string, routePath: string): string {
  const idx = fullContent.indexOf(routePath);
  if (idx === -1) return "";
  return fullContent.slice(Math.max(0, idx - 500), Math.min(fullContent.length, idx + 2000));
}

// ─── Phase 3: dominance vote per security property, scoped per directory ──

/** Top-level directory a route's file lives in, e.g. "src/routes/admin/users.ts"
 *  -> "src/routes/admin". Routes under the same router directory vote together,
 *  so an intentionally-public router isn't judged against an admin router's
 *  auth baseline (or vice versa). */
function routeGroupKey(filePath: string): string {
  const parts = filePath.split("/");
  return parts.slice(0, Math.max(1, parts.length - 1)).join("/");
}

function groupRoutes(routes: RouteInfo[]): RouteInfo[][] {
  const byDir = new Map<string, RouteInfo[]>();
  for (const r of routes) {
    const k = routeGroupKey(r.file);
    const g = byDir.get(k);
    if (g) g.push(r); else byDir.set(k, [r]);
  }
  return [...byDir.values()];
}

function analyzeSecurityProperty(
  routes: RouteInfo[],
  propertyName: string,
  getter: (r: RouteInfo) => boolean,
  excludePaths: RegExp,
): DriftFinding | null {
  const applicableRoutes = routes.filter((r) => !excludePaths.test(r.path));
  if (applicableRoutes.length < 2) return null;

  const withProperty = applicableRoutes.filter(getter);
  const withoutProperty = applicableRoutes.filter((r) => !getter(r));
  const ratio = withProperty.length / applicableRoutes.length;

  if (ratio <= 0.75 || withoutProperty.length === 0) return null;

  return {
    detector: "security_posture",
    subCategory: propertyName,
    driftCategory: "security_posture",
    severity: withoutProperty.length > 2 ? "error" : "warning",
    confidence: 0.75,
    finding: `${propertyName} missing on ${withoutProperty.length} of ${applicableRoutes.length} routes (after router-scope middleware inheritance)`,
    dominantPattern: `${propertyName} applied`,
    dominantCount: withProperty.length,
    totalRelevantFiles: applicableRoutes.length,
    consistencyScore: Math.round(ratio * 100),
    deviatingFiles: withoutProperty.map((r) => ({
      path: r.file,
      // Hedge only the AUTH subcategory: authUnsureHook is an auth-only marker,
      // and gating on propertyName keeps the validation / rate-limit findings'
      // deviator copy free of the hook name for a route that also misses those.
      detectedPattern:
        propertyName === SECURITY_SUBCATEGORIES.auth && r.authUnsureHook
          ? hedgedDeviatorPattern(r)
          : `${r.method} ${r.path} — no ${propertyName}`,
      evidence: [{ line: r.line, code: `${r.method} ${r.path}` }],
    })),
    dominantFiles: [...new Set(withProperty.map((r) => r.file))].sort().slice(0, 3),
    recommendation:
      `${withProperty.length} of ${applicableRoutes.length} routes have ${propertyName}. Review ${withoutProperty.length} unprotected routes — apply per-route middleware or move them under a router that does.` +
      (propertyName === SECURITY_SUBCATEGORIES.auth ? hedgeRecommendationSuffix(withoutProperty) : ""),
  };
}

export const securityConsistency: DriftDetector = {
  id: "security-consistency",
  name: "Security Posture Consistency",
  category: "security_posture",

  detect(ctx: DriftContext): DriftFinding[] {
    const findings: DriftFinding[] = [];
    const fileMw = buildFileMiddlewareIndex(ctx.files);
    // Repo-wide cross-file symbol index: lets the Python AST route extractor
    // resolve an imported before_request hook / FastAPI dependency to its in-repo
    // defining body, but ONLY when resolution is exact and unambiguous (every
    // ambiguity refuses). Blessing still flows through the existing body-first
    // classifier — a resolved body must verifiably reject. An imported symbol that
    // does not resolve stays UNSURE, byte-identical to today.
    const xfile = buildXFileIndex(ctx.files, ctx.goModulePath);
    // Denominator-removing suppression: a route carrying an inline
    // `// @vibedrift-public` annotation, OR whose file matches a config
    // `security.allowlist` glob (ctx.projectConfig), is dropped BEFORE it
    // reaches any vote below, so it never inflates the "unauthed" numerator
    // or the total-routes denominator. Every suppression is cited via the
    // audit finding pushed immediately below, independent of whatever the
    // votes decide — a suppressed route always leaves a trail. ctx.projectConfig
    // is undefined on paths that build their own AnalysisContext without
    // loading one (e.g. the MCP/baseline path), in which case the allowlist
    // arm simply no-ops and only annotations suppress.
    const { kept: routes, suppressed } = applyRouteSuppressions(
      extractRoutes(ctx.files, fileMw, xfile),
      ctx.files,
      ctx.projectConfig ?? null,
    );
    if (suppressed.length > 0) {
      findings.push(buildSuppressionAuditFinding(suppressed));
    }
    if (routes.length < 2) return findings;

    const healthPaths = /^\/(?:health|healthz|ready|metrics|ping)$/;
    const authHint = pickIntentHint(ctx, "security_posture");

    // Vote per top-level route directory rather than globally, so an
    // intentionally-public router (e.g. src/routes/public) isn't judged
    // against a different router's baseline (e.g. src/routes/admin) and vice
    // versa. analyzeSecurityProperty already returns null under 2 applicable
    // routes, so small groups are naturally silent — no separate min-size gate.
    const groups = groupRoutes(routes);

    for (const group of groups) {
      // Auth applies to every state-changing route (POST/PUT/PATCH/DELETE).
      // Rescoped from `group`: counting read-only GETs put intentionally-public
      // reads in the denominator and made the "X of Y mutating routes" line false.
      // Same set as analyzeUniformAuthGap so the primary vote and its fallback agree.
      const groupAuthRoutes = group.filter((r) => MUTATION_METHODS.includes(r.method));
      const authFinding = analyzeSecurityProperty(groupAuthRoutes, SECURITY_SUBCATEGORIES.auth, (r) => r.hasAuth, healthPaths);
      if (authFinding) {
        findings.push(authFinding);
        continue;
      }
      // Dominance vote stayed silent (e.g. uniformly unauthed → ratio 0). Fall
      // back to the absolute baseline so uniform wrongness isn't invisible.
      // hasMachinery stays repo-GLOBAL, not scoped to this group: "the
      // codebase knows how to auth" is evidence wherever it lives, including
      // inline requireAuth in a sibling directory's route file. Scoping this
      // to the group silently disables the uniform-auth-gap safety net for
      // any directory whose only "repo authenticates elsewhere" evidence is
      // another group's inline auth calls (as opposed to a standalone
      // middleware/auth.ts file) — exactly the multi-directory layout this
      // task makes more common.
      const gap = analyzeUniformAuthGap(group, {
        hasMachinery: repoHasAuthMachinery(ctx.files),
        hint: authHint,
        healthPaths,
      });
      if (gap) findings.push(gap);
    }

    for (const group of groups) {
      const groupMutationRoutes = group.filter((r) => BODY_METHODS.includes(r.method));
      const valFinding = analyzeSecurityProperty(groupMutationRoutes, SECURITY_SUBCATEGORIES.validation, (r) => r.hasValidation, healthPaths);
      if (valFinding) findings.push(valFinding);
    }

    for (const group of groups) {
      const rateLimitFinding = analyzeSecurityProperty(group, SECURITY_SUBCATEGORIES.rateLimit, (r) => r.hasRateLimit, healthPaths);
      if (rateLimitFinding) findings.push(rateLimitFinding);
    }

    return findings;
  },
};
