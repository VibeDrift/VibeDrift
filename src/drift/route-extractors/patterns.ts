/**
 * Per-language regexes for the route-extractor regex fallbacks (used only when
 * tree-sitter has no clean parse). Collected here so each pattern can be
 * unit-tested individually: the route patterns' capture groups (method / path)
 * and the boolean signal detectors (auth / validation / rate-limit / error
 * handler). Moved verbatim from the per-language extractors — behavior is
 * unchanged; this is purely so the patterns are named and testable.
 */

// ─── Go — Echo / Gin / Gorilla mux ───

/** Echo/Gin `.POST("/x"` → capture [1] = METHOD, [2] = path. */
export const GO_ROUTE_ECHO = /\.\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/;
/** Gorilla `HandleFunc("/x")…Methods("POST")` → capture [1] = path, [2] = METHOD. */
export const GO_ROUTE_GORILLA = /HandleFunc\s*\(\s*"([^"]+)".*\.Methods\s*\(\s*"(\w+)"/;
/** Go auth ENFORCEMENT shapes. Deliberately not the bare `[Aa]uth` / `[Tt]oken`
 *  substrings this used to be: those matched `author`, `Authorization` header
 *  WRITES, `oauthConfig`, and every `token, err := issueToken(...)` inside a login
 *  handler, blessing the route that mints credentials as though it checked them.
 *  Every alternate below names a middleware/guard, not a token-shaped noun. */
export const GO_AUTH =
  /\b(?:[Aa]uthMiddleware|[Aa]uthRequired|[Aa]uthenticate\w*|[Aa]uthenticated|[Rr]equireAuth\w*|[Rr]equiresAuth|[Rr]equireLogin|[Rr]equireToken|[Rr]equireJWT|[Ee]nsureAuth\w*|[Vv]erifyToken|[Vv]erifyJWT|[Vv]alidateToken|[Cc]heckAuth|[Cc]heckToken|[Ww]ithAuth|[Mm]ustAuth|[Jj]wtAuth|JWTAuth|[Jj]wtMiddleware|JWTMiddleware)\b|\bmiddleware\.\w*[Aa]uth\w*|\bauth\.\w*(?:Middleware|Require\w*|Verify\w*|Check\w*)\b|require[A-Z]\w*/;
export const GO_VALIDATION = /[Bb]ind|[Vv]alidat|[Pp]arse/;
export const GO_RATE_LIMIT = /[Rr]ate[Ll]imit|[Tt]hrottle/;
export const GO_ERROR_HANDLER = /catch|err\s*!=\s*nil|try|except|\.catch/;

// ─── JS/TS — Express / Hono / Fastify / Koa ───

/** `router.post("/x"` → capture [1] = path.
 *
 *  Carries BOTH gates the AST path documents (security-ast.ts:11-17), which this
 *  fallback used to skip: (1) the receiver before the dot must look like a
 *  router/app identifier — the same vocabulary as SECURITY_AST.ROUTER_RECEIVER,
 *  inlined here because a regex cannot embed another regex's source without
 *  drifting from it silently, and pinned equal to it by a test in
 *  patterns.test.ts; (2) the captured path must start with "/". Without them,
 *  `cache.get("user:1")` and `config.get("PORT")` became phantom routes in every
 *  file tree-sitter could not parse. A preceding `.` is allowed (`this.router`,
 *  `self.app`) to match the AST receiverName, which resolves a member expression
 *  to its nearest property. */
export const JS_ROUTE =
  /(?:^|[^\w$])(?:app|application|server|router|api|route|v\d+|[a-z]*[Rr]outer)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(\s*['"`](\/[^'"`]*)['"`]/;
/** Verb of a matched route call → capture [1] = method (lowercase). */
export const JS_METHOD = /\.(get|post|put|patch|delete|all)/;
/** JS/TS auth ENFORCEMENT shapes. The bare `jwt` alternate is gone: it matched
 *  `require("jsonwebtoken")`, `jwt.sign(...)` (issuing a token, the opposite of
 *  checking one), and any `jwtSecret` constant, so a login handler that MINTS a
 *  token blessed itself. JWT now only counts in a guard-shaped name or as the
 *  express-jwt middleware call `jwt({ ... })`. */
export const JS_AUTH =
  /\b(?:requireAuth|requiresAuth|isAuthenticated|verifyToken|authMiddleware|authenticateUser|jwtAuth|authJwt|jwtMiddleware|verifyJwt|checkJwt|requireJwt|expressJwt)\b|passport\.authenticate\s*\(|\bjwt\s*\(\s*\{/;
export const JS_VALIDATION = /validate|joi|zod|yup|celebrate|body\(|query\(/;
export const JS_RATE_LIMIT = /rateLimit|throttle|limiter/;
export const JS_ERROR_HANDLER = /catch|try|\.catch|next\(err/;

// ─── Python — Flask / FastAPI ───

/** `@app.route("/x"` / `@app.post("/x"` → capture [1] = path. */
export const PY_ROUTE = /@\w+\.(?:route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/;
/** Decorator verb `.post(` → capture [1] = verb (lowercase). */
export const PY_DECORATOR_VERB = /\.(get|post|put|patch|delete)\s*\(/;
/** `methods=[...]` kwarg → capture [1] = inner list text (case-insensitive). */
export const PY_METHODS_KWARG = /methods\s*=\s*\[([^\]]*)\]/i;
/** Individual quoted verbs inside a `methods=[...]` list (global; used with `.match`). */
export const PY_METHODS_VERBS = /["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']/gi;
/** Python auth ENFORCEMENT shapes. The bare `token` and `permission` alternates
 *  are gone: the 30-line window this runs over (python.ts) starts at the route
 *  decorator and reaches into the handler body, so a `/login` handler returning
 *  `{"access_token": ...}` blessed ITSELF as authenticated — exactly backwards.
 *  Every alternate below is a decorator, a dependency, or a guard call. */
export const PY_AUTH =
  /@\w*\.?(?:login_required|jwt_required|token_required|auth_required|requires_auth|require_auth|requires_login|require_login|requires_permission|permission_required|permission_classes|authenticated|requires|protected)\b|\bDepends\s*\(\s*[\w.]*(?:current_user|auth|jwt|token|bearer|principal)\w*|\bSecurity\s*\(|\bverify_jwt_in_request\s*\(|\bpermission_classes\s*=|\bcurrent_user\.is_authenticated\b/;
export const PY_VALIDATION = /pydantic|validate|Schema|Serializer/;
export const PY_RATE_LIMIT = /rate_limit|throttle|limiter/;
export const PY_ERROR_HANDLER = /try|except|raise/;
