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
export const GO_AUTH = /[Aa]uth|[Tt]oken|require[A-Z]|middleware\.\w*[Aa]uth/;
export const GO_VALIDATION = /[Bb]ind|[Vv]alidat|[Pp]arse/;
export const GO_RATE_LIMIT = /[Rr]ate[Ll]imit|[Tt]hrottle/;
export const GO_ERROR_HANDLER = /catch|err\s*!=\s*nil|try|except|\.catch/;

// ─── JS/TS — Express / Hono / Fastify / Koa ───

/** `.post("/x"` → capture [1] = path. */
export const JS_ROUTE = /\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/;
/** Verb of a matched route call → capture [1] = method (lowercase). */
export const JS_METHOD = /\.(get|post|put|patch|delete|all)/;
export const JS_AUTH = /(?:requireAuth|isAuthenticated|passport\.authenticate|verifyToken|jwt|authMiddleware)/;
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
export const PY_AUTH = /login_required|jwt_required|@requires|permission|token/;
export const PY_VALIDATION = /pydantic|validate|Schema|Serializer/;
export const PY_RATE_LIMIT = /rate_limit|throttle|limiter/;
export const PY_ERROR_HANDLER = /try|except|raise/;
