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

const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

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
      detectedPattern: `${r.method} ${r.path} — no auth`,
      evidence: [{ line: r.line, code: `${r.method} ${r.path}` }],
    })),
    dominantFiles: [],
    recommendation: declared
      ? `${opts.hint!.source}:${opts.hint!.line} declares auth is required. Add auth middleware to these ${unauthed.length} mutating route(s), or mark them explicitly public.`
      : `These ${unauthed.length} mutating route(s) have no auth while the codebase authenticates elsewhere. Add auth middleware, or confirm they are intentionally public.`,
  };
}

interface FileMiddleware {
  hasAuth: boolean;
  hasValidation: boolean;
  hasRateLimit: boolean;
}

interface RouteInfo {
  method: string;
  path: string;
  file: string;
  line: number;
  hasAuth: boolean;
  hasValidation: boolean;
  hasRateLimit: boolean;
  hasErrorHandler: boolean;
}

// ─── Phase 1: file-level middleware index ────────────────────────────

function buildFileMiddlewareIndex(files: DriftFile[]): Map<string, FileMiddleware> {
  const index = new Map<string, FileMiddleware>();
  for (const file of files) {
    if (!file.language) continue;
    const c = file.content;

    // JS/TS — Express / Hono / Fastify / Koa
    // router.use(requireAuth) | app.use(passport.authenticate(...)) | router.use(authMiddleware)
    const jsAuth = /(?:router|app|router\w*|api\w*)\s*\.\s*use\s*\(\s*[^,)]*?(?:auth|requireAuth|isAuthenticated|passport|verifyToken|jwt)/i.test(c);
    const jsRateLimit = /(?:router|app)\s*\.\s*use\s*\(\s*[^,)]*?(?:rateLimit|throttle|limiter)/i.test(c);
    const jsValidation = /(?:router|app)\s*\.\s*use\s*\(\s*[^,)]*?(?:validate|validator|joi|zod|celebrate)/i.test(c);

    // Go — Echo / Gin / Chi
    // e.Use(AuthMiddleware) | r.Use(authMiddleware) | g := e.Group(...); g.Use(...)
    const goAuth = /\.\s*Use\s*\(\s*[^,)]*?(?:[Aa]uth|RequireAuth|VerifyToken|JWT|Bearer)/.test(c);
    const goRateLimit = /\.\s*Use\s*\(\s*[^,)]*?(?:[Rr]ateLimit|[Tt]hrottle|[Ll]imiter)/.test(c);
    const goValidation = /\.\s*Use\s*\(\s*[^,)]*?(?:[Vv]alidate|[Vv]alidator)/.test(c);

    // Python — Flask / FastAPI
    // @app.before_request def f() | @blueprint.before_request | app.add_middleware(AuthMW)
    const pyAuth = /(?:@\w+\.before_request|@blueprint\.before_request|add_middleware\s*\([^,)]*[Aa]uth|@?\bjwt_required\b|@?\blogin_required\b)/.test(c);
    const pyRateLimit = /(?:@\w+\.\w+\s*\([^)]*[Ll]imit|RateLimiter|Limiter\(|add_middleware\s*\([^,)]*[Ll]imit)/.test(c);
    const pyValidation = /add_middleware\s*\([^,)]*[Vv]alid/.test(c);

    index.set(file.path, {
      hasAuth: jsAuth || goAuth || pyAuth,
      hasValidation: jsValidation || goValidation || pyValidation,
      hasRateLimit: jsRateLimit || goRateLimit || pyRateLimit,
    });
  }
  return index;
}

// ─── Route extraction (per-route middleware via proximity) ──────────

function extractRoutes(files: DriftFile[], fileMw: Map<string, FileMiddleware>): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const file of files) {
    if (!file.language) continue;
    if (file.language === "go") extractGoRoutes(file, routes, fileMw);
    else if (file.language === "javascript" || file.language === "typescript") extractJsRoutes(file, routes, fileMw);
    else if (file.language === "python") extractPythonRoutes(file, routes, fileMw);
  }
  return routes;
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

function extractGoRoutes(file: DriftFile, routes: RouteInfo[], fileMw: Map<string, FileMiddleware>) {
  const lines = file.content.split("\n");
  const echoPattern = /\.\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/;
  const gorillaPattern = /HandleFunc\s*\(\s*"([^"]+)".*\.Methods\s*\(\s*"(\w+)"/;
  const fileMiddleware = fileMw.get(file.path);

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
      method, path, file: file.path, line: i + 1,
      hasAuth: inheritedAuth(perAuth, fileMiddleware),
      hasValidation: inheritedValidation(perVal, fileMiddleware),
      hasRateLimit: inheritedRateLimit(perRate, fileMiddleware),
      hasErrorHandler: /catch|err\s*!=\s*nil|try|except|\.catch/.test(handlerContent),
    });
  }
}

function extractJsRoutes(file: DriftFile, routes: RouteInfo[], fileMw: Map<string, FileMiddleware>) {
  const lines = file.content.split("\n");
  const expressPattern = /\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/;
  const fileMiddleware = fileMw.get(file.path);

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
      method, path, file: file.path, line: i + 1,
      hasAuth: inheritedAuth(perAuth, fileMiddleware),
      hasValidation: inheritedValidation(perVal, fileMiddleware),
      hasRateLimit: inheritedRateLimit(perRate, fileMiddleware),
      hasErrorHandler: /catch|try|\.catch|next\(err/.test(context),
    });
  }
}

function extractPythonRoutes(file: DriftFile, routes: RouteInfo[], fileMw: Map<string, FileMiddleware>) {
  const lines = file.content.split("\n");
  const routePattern = /@\w+\.(?:route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/;
  const fileMiddleware = fileMw.get(file.path);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(routePattern);
    if (!match) continue;
    const path = match[1];
    const method = lines[i].match(/\.(get|post|put|patch|delete)/)?.[1]?.toUpperCase() ?? "ANY";
    const context = lines.slice(i, Math.min(lines.length, i + 30)).join("\n");

    const perAuth = /login_required|jwt_required|@requires|permission|token/.test(context);
    const perVal = /pydantic|validate|Schema|Serializer/.test(context);
    const perRate = /rate_limit|throttle|limiter/.test(context);

    routes.push({
      method, path, file: file.path, line: i + 1,
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

// ─── Phase 3: dominance vote per security property ───────────────────

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
      detectedPattern: `${r.method} ${r.path} — no ${propertyName}`,
      evidence: [{ line: r.line, code: `${r.method} ${r.path}` }],
    })),
    dominantFiles: [...new Set(withProperty.map((r) => r.file))].sort().slice(0, 3),
    recommendation: `${withProperty.length} of ${applicableRoutes.length} routes have ${propertyName}. Review ${withoutProperty.length} unprotected routes — apply per-route middleware or move them under a router that does.`,
  };
}

export const securityConsistency: DriftDetector = {
  id: "security-consistency",
  name: "Security Posture Consistency",
  category: "security_posture",

  detect(ctx: DriftContext): DriftFinding[] {
    const findings: DriftFinding[] = [];
    const fileMw = buildFileMiddlewareIndex(ctx.files);
    const routes = extractRoutes(ctx.files, fileMw);
    if (routes.length < 2) return findings;

    const healthPaths = /^\/(?:health|healthz|ready|metrics|ping)$/;
    const authHint = pickIntentHint(ctx, "security_posture");

    // Auth applies to every state-changing route (POST/PUT/PATCH/DELETE).
    // Rescoped from `routes`: counting read-only GETs put intentionally-public
    // reads in the denominator and made the "X of Y mutating routes" line false.
    // Same set as analyzeUniformAuthGap so the primary vote and its fallback agree.
    const authRoutes = routes.filter((r) => MUTATION_METHODS.includes(r.method));

    const authFinding = analyzeSecurityProperty(authRoutes, SECURITY_SUBCATEGORIES.auth, (r) => r.hasAuth, healthPaths);
    if (authFinding) {
      findings.push(authFinding);
    } else {
      // Dominance vote stayed silent (e.g. uniformly unauthed → ratio 0). Fall
      // back to the absolute baseline so uniform wrongness isn't invisible.
      const gap = analyzeUniformAuthGap(routes, {
        hasMachinery: repoHasAuthMachinery(ctx.files),
        hint: authHint,
        healthPaths,
      });
      if (gap) findings.push(gap);
    }

    const mutationRoutes = routes.filter((r) => ["POST", "PUT", "PATCH"].includes(r.method));
    if (mutationRoutes.length >= 2) {
      const valFinding = analyzeSecurityProperty(mutationRoutes, SECURITY_SUBCATEGORIES.validation, (r) => r.hasValidation, healthPaths);
      if (valFinding) findings.push(valFinding);
    }

    const rateLimitFinding = analyzeSecurityProperty(routes, SECURITY_SUBCATEGORIES.rateLimit, (r) => r.hasRateLimit, healthPaths);
    if (rateLimitFinding) findings.push(rateLimitFinding);

    return findings;
  },
};
