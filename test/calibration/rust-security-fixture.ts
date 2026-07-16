/**
 * Calibration fixture for the Rust AST security extractor (Task 6): a
 * realistic Axum + Actix multi-file corpus with planted ground truth, used by
 * test/calibration/security-rust.test.ts to measure the primary dominance
 * vote (analyzeSecurityProperty) through TWO independent bless mechanisms
 * (from_fn and from_fn_with_state), the uniform-auth-gap fallback
 * (analyzeUniformAuthGap), a negative control, the three body-signature
 * outcomes (collision / gate / unsure), and the Actix v1 boundary. Mirrors
 * go-security-fixture.ts / python-security-fixture.ts function-for-function.
 *
 * LOCKED decision (see security-ast-rust.ts and task-6-brief.md): Rust v1
 * blesses ONLY via a covering (ancestor) `.layer`/`.route_layer` wrapping
 * `middleware::from_fn(fn)` / `middleware::from_fn_with_state(state, fn)`
 * whose in-file body VERIFIABLY rejects (401-family). There is NO name-only
 * bless and NO type-name bless. So every authed corpus below DEFINES its
 * `require_auth` / `gate` middleware IN-FILE with a body that actually
 * rejects, and blesses through rule 2 (the readable reject), never through
 * the name — an imported or extractor-typed auth surface resolves UNSURE at
 * best, never a bless.
 *
 * Directory layout mirrors independent "repos" so each corpus roots its own
 * `repoHasAuthMachinery` evidence (repo-global over whatever files are in
 * ctx.files, not scoped to a route group) and its own route-directory vote
 * (`routeGroupKey` = dirname, so every corpus's route files share ONE parent
 * directory):
 *   rustsrv/routes/*.rs      8 Axum files, 2 mutating routes each (POST +
 *                            DELETE), one `.route_layer(from_fn(require_auth))`
 *                            covering both — the S1 bless mechanism.
 *   rustsrv/auth_tokens.rs   the repo-global `login_required` machinery token
 *                            (case-sensitive: this is what `repoHasAuthMachinery`
 *                            matches; Rust-idiomatic `require_auth` is NOT in
 *                            that regex, mirroring the Python fixture's
 *                            `auth.py` trick).
 *   statesrv/routes/*.rs     5 Axum files, one mutating route each, authed via
 *                            `.layer(from_fn_with_state(state.clone(), require_auth))`
 *                            (LAST-arg fn resolution) — the S2 bless mechanism,
 *                            proving S1 is not a single code path.
 *   hooks/routes/*.rs        5 uniformly PUBLIC Axum webhook receivers
 *                            (negative control): signature checking happens
 *                            INSIDE the handler body via a helper
 *                            `check_signature`, never as a `from_fn` layer,
 *                            never with an auth-lexicon name.
 *   bodycol/routes/*.rs      S6: 4 authed + 1 name-auth-but-body-isnt collision.
 *   bodygate/routes/*.rs     S7: 5 routes whose ONLY auth is a boring `gate()`
 *                            hook (no auth-lexicon identifier anywhere).
 *   bodyunsure/routes/*.rs   S8: 4 authed + 1 imported-hook UNSURE.
 *   actixsrv/*.rs            Actix attribute-macro handlers (method+path
 *                            recognition only): a `.wrap`/request-guard/
 *                            extractor-typed auth surface, never blessed —
 *                            v1 does not bless Actix/Rocket auth.
 */
import type { BaselineFile } from "./baseline.js";

// The in-file auth middleware every "authed" Axum fixture defines: a 401 on a
// missing Authorization header. Identical text across every file that uses
// it, so a single strip() call can remove its CALL SITE deterministically
// (see stripAxumAuth below) while leaving the (now unused) definition intact —
// mirrors the brief's "byte-identical MINUS the .route_layer(...) link".
const REQUIRE_AUTH_BLOCK =
`async fn require_auth(req: Request, next: Next) -> Result<Response, StatusCode> {
    let tok = req.headers().get("Authorization");
    if tok.is_none() { return Err(StatusCode::UNAUTHORIZED); }
    Ok(next.run(req).await)
}

`;

function sortedEligiblePaths(files: BaselineFile[], predicate: (path: string) => boolean): string[] {
  return files
    .map((f) => f.path)
    .filter(predicate)
    .sort();
}

// ─── rustsrv: 8 Axum route files, 2 mutating routes each (S0/S1) ────────────
const RUSTSRV_ROOT = "rustsrv/routes";
const RUSTSRV_ENTITIES = [
  "orders", "users", "products", "payments", "invoices", "carts", "sessions", "notifications",
];

function axumRouteFile(name: string): BaselineFile {
  return {
    path: `${RUSTSRV_ROOT}/${name}.rs`,
    content:
`use axum::{Router, routing::post, routing::delete, middleware, http::StatusCode};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

${REQUIRE_AUTH_BLOCK}async fn create_${name}() -> Response {
    todo!()
}

async fn delete_${name}() -> Response {
    todo!()
}

pub fn routes() -> Router {
    Router::new()
        .route("/${name}", post(create_${name}))
        .route("/${name}/:id", delete(delete_${name}))
        .route_layer(middleware::from_fn(require_auth))
}
`,
  };
}

export function axumAuthedGroup(): BaselineFile[] {
  return RUSTSRV_ENTITIES.map(axumRouteFile);
}

// Support file: kept OUT of axumAuthedGroup() so it stays two-routes-per-file
// exactly (S0's route-loss guard requires every element to yield exactly the
// planted count). Each route file now carries its OWN in-file require_auth
// (that is what actually blesses each route); this file's role is purely to
// keep "the codebase uses auth elsewhere" evidence present once those in-file
// copies are stripped (S3). LOAD-BEARING: `login_required` (the literal
// identifier) is what the case-sensitive repoHasAuthMachinery regex matches —
// Rust-idiomatic `require_auth` is deliberately NOT in that token list,
// mirroring the Python fixture's pysrv/auth.py trick.
export const rustAuthTokensFile: BaselineFile = {
  path: "rustsrv/auth_tokens.rs",
  content:
`//! Deprecated auth token bridge, superseded by the from_fn-based
//! \`require_auth\` middleware defined in each route module.

#[deprecated(note = "use the require_auth middleware instead")]
pub fn login_required() -> bool {
    false
}
`,
};

/** Sorted rustsrv/routes/*.rs paths in `files` — the deterministic strip
 *  order stripAxumAuth uses, exposed so tests can compute which path(s) got
 *  stripped without duplicating the sort/filter logic. */
export function sortedAxumRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${RUSTSRV_ROOT}/`) && p.endsWith(".rs"));
}

/** Deterministically strips the `.route_layer(middleware::from_fn(require_auth))`
 *  call-site line from the first `count` rustsrv route files, sorted by path.
 *  The routes and the (now unused) require_auth definition are untouched, so
 *  every stripped file remains valid, still-mutating routes with
 *  hasAuth: false and no covering layer at all. */
export function stripAxumAuth(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedAxumRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const content = f.content
      .split("\n")
      .filter((line) => line.trim() !== ".route_layer(middleware::from_fn(require_auth))")
      .join("\n");
    return { path: f.path, content };
  });
}

// ─── statesrv: 5 Axum files, from_fn_with_state bless (S2) ──────────────────
const STATESRV_ROOT = "statesrv/routes";
const STATESRV_ENTITIES = ["teams", "projects", "tags", "comments", "attachments"];

// 5 files so one deviator gives 4/5 = 0.8 > 0.75 (the arithmetic floor: n=4
// can never clear the strict > 0.75 gate). Blesses through the LAST-arg
// from_fn_with_state form, resolved via rule 2 (the readable in-file reject),
// never the name — a SECOND bless mechanism from S1's, proving the dominance
// vote is not a single code path.
function stateRouteFile(name: string): BaselineFile {
  return {
    path: `${STATESRV_ROOT}/${name}.rs`,
    content:
`use axum::{Router, routing::post, middleware, http::StatusCode};
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;

#[derive(Clone)]
struct AppState;

async fn require_auth(State(_state): State<AppState>, req: Request, next: Next) -> Result<Response, StatusCode> {
    let tok = req.headers().get("Authorization");
    if tok.is_none() { return Err(StatusCode::UNAUTHORIZED); }
    Ok(next.run(req).await)
}

async fn create_${name}(State(_state): State<AppState>) -> Response {
    todo!()
}

pub fn routes(state: AppState) -> Router {
    Router::new()
        .route("/${name}", post(create_${name}))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state)
}
`,
  };
}

export function axumStateAuthedGroup(): BaselineFile[] {
  return STATESRV_ENTITIES.map(stateRouteFile);
}

/** Sorted statesrv/routes/*.rs paths in `files`, same purpose as
 *  sortedAxumRoutePaths above. */
export function sortedStateRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${STATESRV_ROOT}/`) && p.endsWith(".rs"));
}

/** Deterministically strips the `.layer(middleware::from_fn_with_state(...))`
 *  call-site line from the first `count` statesrv route files, sorted by
 *  path, leaving a bare (now unauthed) still-mutating route. */
export function stripStateAuth(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedStateRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const content = f.content
      .split("\n")
      .filter((line) => line.trim() !== ".layer(middleware::from_fn_with_state(state.clone(), require_auth))")
      .join("\n");
    return { path: f.path, content };
  });
}

/** uniformly-authed control: axumAuthedGroup + axumStateAuthedGroup + support
 *  files, unchanged. */
export function uniformlyAuthed(): BaselineFile[] {
  return [...axumAuthedGroup(), rustAuthTokensFile, ...axumStateAuthedGroup()];
}

// ─── hooks: 5 uniformly PUBLIC webhook receivers (negative control, S4) ─────
const HOOKS_ROOT = "hooks/routes";

interface HookProvider { name: string; header: string; }
const HOOK_PROVIDERS: HookProvider[] = [
  { name: "stripe", header: "Stripe-Signature" },
  { name: "github", header: "X-Hub-Signature-256" },
  { name: "slack", header: "X-Slack-Signature" },
  { name: "twilio", header: "X-Twilio-Signature" },
  { name: "sendgrid", header: "X-Sendgrid-Signature" },
];

// Signature checking (if any) happens INSIDE the handler body via a helper
// named check_signature — never as a from_fn layer, never with an
// auth-lexicon name, and never even reaches the covering-layer walk (there is
// no `.layer`/`.route_layer` at all). Own directory root so it never shares
// repoHasAuthMachinery evidence with the authed corpora. Deliberately no
// "limit"/"validate" token and no CLAUDE.md/AGENTS.md file in this corpus.
function hookFile(provider: HookProvider): BaselineFile {
  return {
    path: `${HOOKS_ROOT}/${provider.name}_hook.rs`,
    content:
`use axum::{Router, routing::post, http::StatusCode};
use axum::extract::Request;
use axum::response::{IntoResponse, Response};

// ${provider.name} webhook receiver. Requests are verified via payload
// signature checking inside the handler, never via a gate that runs before it.

async fn handle_${provider.name}_event(req: Request) -> Response {
    let sig = req.headers().get("${provider.header}");
    if !check_signature(sig) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    StatusCode::OK.into_response()
}

fn check_signature(header: Option<&axum::http::HeaderValue>) -> bool {
    header.is_some()
}

pub fn routes() -> Router {
    Router::new().route("/webhooks/${provider.name}", post(handle_${provider.name}_event))
}
`,
  };
}

export function publicByDesignControl(): BaselineFile[] {
  return HOOK_PROVIDERS.map(hookFile);
}

// ─── S6-S8: body-signature calibration groups ────────────────────────────────
//
// Each group roots its own directory so the route-directory vote grouping and
// repoHasAuthMachinery evidence never bleed between scenarios. Each helper
// keeps "one route per file" so the non-vacuity guards stay exact.

// ── S6: name-auth-but-body-isnt collision (negative) ─────────────────────────
const S6_ROOT = "bodycol/routes";
const S6_AUTHED_NAMES = ["widgets", "gadgets", "tools", "devices"];

function s6AuthedFile(name: string): BaselineFile {
  return {
    path: `${S6_ROOT}/${name}.rs`,
    content:
`use axum::{Router, routing::post, middleware, http::StatusCode};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

${REQUIRE_AUTH_BLOCK}async fn create_${name}() -> Response {
    todo!()
}

pub fn routes() -> Router {
    Router::new()
        .route("/${name}", post(create_${name}))
        .route_layer(middleware::from_fn(require_auth))
}
`,
  };
}

/** The one deviator in S6: its only gate is an in-file `auth_check` whose
 *  visible body merely LOGS the request path and forwards unconditionally.
 *  Body-first classification resolves it flat not-auth (name looks like
 *  auth, body is not), so the finding must NOT be suppressed. */
export const bodyCollisionDeviatorPath = `${S6_ROOT}/notify.rs`;

export function bodyCollisionGroup(): BaselineFile[] {
  const authed = S6_AUTHED_NAMES.map(s6AuthedFile);
  const collision: BaselineFile = {
    path: bodyCollisionDeviatorPath,
    content:
`use axum::{Router, routing::post, middleware};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

// auth_check's NAME looks like auth, but its BODY only logs the request path
// and forwards unconditionally: body-first classification resolves this flat
// not-auth (a visible non-enforcing body, rule 3), never a bless and never a
// hedge.
async fn auth_check(req: Request, next: Next) -> Response {
    tracing::info!("auth check saw {}", req.uri().path());
    next.run(req).await
}

async fn create_notify() -> Response {
    todo!()
}

pub fn routes() -> Router {
    Router::new()
        .route("/notify", post(create_notify))
        .route_layer(middleware::from_fn(auth_check))
}
`,
  };
  return [...authed, collision];
}

// ── S7: body-is-real-auth positive (boring gate() hook) ──────────────────────
const S7_ROOT = "bodygate/routes";
const S7_NAMES = ["posts", "comments", "reviews", "tags", "media"];

/** The exact from_fn block S7 files carry and stripBodyGate removes: a boring
 *  name (`gate`) whose BODY reads the Authorization header and 401s, so ONLY
 *  the body signature blesses (no auth-lexicon identifier anywhere in S7). */
const GATE_BLOCK =
`async fn gate(req: Request, next: Next) -> Result<Response, StatusCode> {
    if req.headers().get("Authorization").is_none() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

`;

function bodyGateFile(name: string): BaselineFile {
  return {
    path: `${S7_ROOT}/${name}.rs`,
    content:
`use axum::{Router, routing::post, middleware, http::StatusCode};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

${GATE_BLOCK}async fn create_${name}() -> Response {
    todo!()
}

pub fn routes() -> Router {
    Router::new()
        .route("/${name}", post(create_${name}))
        .route_layer(middleware::from_fn(gate))
}
`,
  };
}

export function bodyGateGroup(): BaselineFile[] {
  return S7_NAMES.map(bodyGateFile);
}

export function sortedBodyGateRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${S7_ROOT}/`) && p.endsWith(".rs"));
}

/** Removes the gate() from_fn call-site line from the first `count` S7 files,
 *  sorted by path, leaving a bare (now unauthed) still-mutating route. */
export function stripBodyGate(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedBodyGateRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const content = f.content
      .split("\n")
      .filter((line) => line.trim() !== ".route_layer(middleware::from_fn(gate))")
      .join("\n");
    return { path: f.path, content };
  });
}

// ── S8: unresolvable-body UNSURE (imported require_auth) ─────────────────────
const S8_ROOT = "bodyunsure/routes";
const S8_AUTHED_NAMES = ["alpha", "beta", "gamma", "delta"];

function s8AuthedFile(name: string): BaselineFile {
  return {
    path: `${S8_ROOT}/${name}.rs`,
    content:
`use axum::{Router, routing::post, middleware, http::StatusCode};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

${REQUIRE_AUTH_BLOCK}async fn create_${name}() -> Response {
    todo!()
}

pub fn routes() -> Router {
    Router::new()
        .route("/${name}", post(create_${name}))
        .route_layer(middleware::from_fn(require_auth))
}
`,
  };
}

/** The one deviator in S8: an IMPORTED require_auth middleware whose body is
 *  not visible in this file, so it resolves UNSURE (hasAuth false,
 *  authUnsureHook set, hedged copy), never a bless. */
export const bodyUnsureDeviatorPath = `${S8_ROOT}/reports.rs`;

export function bodyUnsureGroup(): BaselineFile[] {
  const authed = S8_AUTHED_NAMES.map(s8AuthedFile);
  const unsure: BaselineFile = {
    path: bodyUnsureDeviatorPath,
    content:
`use axum::{Router, routing::post, middleware};
use axum::response::Response;
use some_crate::middleware::require_auth;

// The only gate is an IMPORTED require_auth middleware: its body is not
// visible in this file, so it resolves UNSURE (hedged copy naming the hook),
// never a bless.
async fn create_report() -> Response {
    todo!()
}

pub fn routes() -> Router {
    Router::new()
        .route("/reports", post(create_report))
        .route_layer(middleware::from_fn(require_auth))
}
`,
  };
  return [...authed, unsure];
}

// ─── actixsrv: Actix attribute-macro recognition (v1 boundary) ──────────────
//
// v1 blesses ONLY Axum from_fn/from_fn_with_state middleware. Actix routes
// (attribute macros) have no builder layer chain at all — `r.call` is null
// for every attribute-macro route, so the covering-layer walk never even
// runs. This corpus measures that boundary explicitly: method+path
// recognition works identically to Axum, but auth NEVER blesses — it either
// hedges via an auth-flavored extractor type (Identity) or resolves flat
// not-auth (a non-auth extractor type, or a builder-level `.wrap` that is
// structurally invisible to an attribute-macro route).
const ACTIX_ROOT = "actixsrv";

export function actixRecognitionGroup(): BaselineFile[] {
  return [
    {
      path: `${ACTIX_ROOT}/orders.rs`,
      content:
`use actix_web::{post, HttpResponse};

struct Identity;

#[post("/orders")]
async fn create_order(user: Identity) -> HttpResponse {
    HttpResponse::Created().finish()
}
`,
    },
    {
      path: `${ACTIX_ROOT}/products.rs`,
      content:
`use actix_web::{get, web, HttpResponse};

#[get("/products/{id}")]
async fn get_product(id: web::Path<u32>) -> HttpResponse {
    HttpResponse::Ok().finish()
}
`,
    },
    {
      path: `${ACTIX_ROOT}/reviews.rs`,
      content:
`use actix_web::{delete, web, HttpResponse};
use actix_web_httpauth::middleware::HttpAuthentication;

#[delete("/reviews/{id}")]
async fn delete_review(id: web::Path<u32>) -> HttpResponse {
    HttpResponse::NoContent().finish()
}

// A request-guard '.wrap' applied at the scope/App level is structurally
// invisible to an attribute-macro route: v1's covering-layer walk only ever
// starts from a builder '.route(...)' call node (r.call), which attribute
// routes never have.
pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/reviews")
            .wrap(HttpAuthentication::bearer(validator))
            .service(delete_review),
    );
}
`,
    },
  ];
}
