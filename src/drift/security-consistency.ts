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
import { extractJsRoutesAst, extractFileMiddlewareAst } from "./security-ast.js";
import { applyRouteSuppressions, buildSuppressionAuditFinding } from "./security-suppression.js";

const MUTATION_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

// The auth vote's peer group: every state-changing method, PLUS "ANY" (a route
// whose method the extractor could not pin down, e.g. Flask `@app.route(...)`)
// and "ALL" (Express `.all()`, which handles every verb including the mutating
// ones). Filtering the peer group to MUTATION_METHODS alone dropped both
// silently, losing auth-consistency detection for whole frameworks: a Flask
// repo with 9 authed + 1 unauthed routes produced no finding at all. The
// validation vote deliberately keeps the narrower POST/PUT/PATCH set
// (body-carrying methods only), so it must NOT use this constant.
const AUTH_VOTE_METHODS = [...MUTATION_METHODS, "ANY", "ALL"];

/** Copy helper: "ANY" means the method is unresolved, so a message counting
 *  such routes must not assert they all mutate. "ALL" routes genuinely handle
 *  the mutating verbs, so they keep the plain "mutating" label. */
function authRoutesNoun(routes: RouteInfo[]): string {
  return routes.some((r) => r.method === "ANY") ? "mutating or unresolved-method route(s)" : "mutating route(s)";
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
 * without auth produced a clean grade. This fires on uniformly-unauthed routes
 * in the auth peer group (AUTH_VOTE_METHODS: mutating, method-ANY, and .all()
 * routes) — but only with a baseline reason: either the repo uses auth
 * elsewhere, or a CLAUDE.md/AGENTS.md hint declares auth required. With neither,
 * we stay silent (could be an intentionally-public API).
 */
function analyzeUniformAuthGap(
  routes: RouteInfo[],
  opts: { hasMachinery: boolean; hint: ReturnType<typeof pickIntentHint>; healthPaths: RegExp },
): DriftFinding | null {
  // Same peer group as the primary dominance vote (AUTH_VOTE_METHODS), so the
  // vote and its fallback can never disagree about which routes are judged.
  const authPeers = routes.filter((r) => AUTH_VOTE_METHODS.includes(r.method) && !opts.healthPaths.test(r.path));
  const unauthed = authPeers.filter((r) => !r.hasAuth);
  if (unauthed.length === 0) return null;
  if (!opts.hasMachinery && !opts.hint) return null; // no baseline → maybe intentionally public

  const declared = !!opts.hint;
  // Evidence-driven confidence: a declared rule is strong; "uses auth elsewhere"
  // is a softer signal.
  const confidence = declared ? 0.9 : 0.6;
  const have = authPeers.length - unauthed.length;
  const noun = authRoutesNoun(unauthed);

  return {
    detector: "security_posture",
    subCategory: SECURITY_SUBCATEGORIES.auth,
    driftCategory: "security_posture",
    severity: unauthed.length > 2 ? "error" : "warning",
    confidence,
    finding: declared
      ? `${unauthed.length} ${noun} lack auth, but ${opts.hint!.source} declares authentication is required`
      : `${unauthed.length} ${noun} lack auth while the codebase uses auth elsewhere`,
    dominantPattern: declared ? `${opts.hint!.label}` : "auth on mutating routes",
    dominantCount: have,
    totalRelevantFiles: authPeers.length,
    consistencyScore: authPeers.length ? Math.round((have / authPeers.length) * 100) : 0,
    deviatingFiles: unauthed.map((r) => ({
      path: r.file,
      detectedPattern: `${r.method} ${r.path} — no auth`,
      evidence: [{ line: r.line, code: `${r.method} ${r.path}` }],
    })),
    dominantFiles: [],
    recommendation: declared
      ? `${opts.hint!.source}:${opts.hint!.line} declares auth is required. Add auth middleware to these ${unauthed.length} ${noun}, or mark them explicitly public.`
      : `These ${unauthed.length} ${noun} have no auth while the codebase authenticates elsewhere. Add auth middleware, or confirm they are intentionally public.`,
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
}

// ─── Phase 1: file-level middleware index ────────────────────────────

function buildFileMiddlewareIndex(files: DriftFile[]): Map<string, FileMiddleware> {
  const index = new Map<string, FileMiddleware>();
  for (const file of files) {
    if (!file.language) continue;
    const c = file.content;

    // JS/TS — Express / Hono / Fastify / Koa. AST when a parsed tree is
    // available (structural: gated on a router/app receiver, not just
    // proximity of the keyword); regex fallback otherwise.
    let jsAuth: boolean, jsRateLimit: boolean, jsValidation: boolean;
    if (file.tree && (file.language === "javascript" || file.language === "typescript")) {
      const mw = extractFileMiddlewareAst(file.tree);
      jsAuth = mw.hasAuth;
      jsRateLimit = mw.hasRateLimit;
      jsValidation = mw.hasValidation;
    } else {
      // router.use(requireAuth) | app.use(passport.authenticate(...)) | router.use(authMiddleware)
      jsAuth = /(?:router|app|router\w*|api\w*)\s*\.\s*use\s*\(\s*[^,)]*?(?:auth|requireAuth|isAuthenticated|passport|verifyToken|jwt)/i.test(c);
      jsRateLimit = /(?:router|app)\s*\.\s*use\s*\(\s*[^,)]*?(?:rateLimit|throttle|limiter)/i.test(c);
      jsValidation = /(?:router|app)\s*\.\s*use\s*\(\s*[^,)]*?(?:validate|validator|joi|zod|celebrate)/i.test(c);
    }

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

    index.set(file.relativePath, {
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
  const fileMiddleware = fileMw.get(file.relativePath);

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

function extractPythonRoutes(file: DriftFile, routes: RouteInfo[], fileMw: Map<string, FileMiddleware>) {
  const lines = file.content.split("\n");
  const routePattern = /@\w+\.(?:route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/;
  const fileMiddleware = fileMw.get(file.relativePath);

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
      extractRoutes(ctx.files, fileMw),
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
      // Auth applies to every state-changing route (POST/PUT/PATCH/DELETE)
      // plus method-ANY/ALL routes (see AUTH_VOTE_METHODS). Rescoped from
      // `group`: counting read-only GETs put intentionally-public reads in the
      // denominator and made the "X of Y routes" line false. Same set as
      // analyzeUniformAuthGap so the primary vote and its fallback agree.
      // Runs on post-suppression routes only: `group` descends from the
      // applyRouteSuppressions `kept` set above, so a suppressed ANY/ALL route
      // never re-enters the vote through this filter.
      const groupAuthRoutes = group.filter((r) => AUTH_VOTE_METHODS.includes(r.method));
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
      const groupMutationRoutes = group.filter((r) => ["POST", "PUT", "PATCH"].includes(r.method));
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
