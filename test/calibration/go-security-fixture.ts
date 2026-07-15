/**
 * Calibration fixture for the Go AST security extractor (Task 7): a realistic
 * Gin + Gorilla multi-file corpus with planted ground truth, used by
 * test/calibration/security-go.test.ts to measure the primary dominance vote
 * (analyzeSecurityProperty), the uniform-auth-gap fallback
 * (analyzeUniformAuthGap), a negative control, and the three body-signature
 * outcomes (collision / gate / unsure) added by the body-first classifier
 * (Task 3-4). Mirrors python-security-fixture.ts function-for-function.
 *
 * LOCKED decision (see task-7-brief.md): blessing requires a verifiable
 * reject in a READABLE IN-FILE body. An imported/opaque auth middleware
 * NEVER blesses on its name alone — it resolves UNSURE at best. So every
 * authed corpus below DEFINES its `AuthMiddleware` / `RequireAuth` /
 * `guard` IN-FILE with a body that actually rejects (401-family), and
 * blesses through rule 2 (the readable reject), never through the name.
 *
 * Directory layout mirrors seven independent "repos" so each corpus roots
 * its own `repoHasAuthMachinery` evidence (repo-global over whatever files
 * are in ctx.files, not scoped to a route group) and its own route-directory
 * vote (`routeGroupKey` = dirname, so every corpus's route files share ONE
 * parent directory):
 *   gosrv/routes/*.go        8 Gin route files, one mutating route each
 *   gosrv/middleware/auth.go the repo-global AuthMiddleware machinery token
 *   gosrv/main.go             factory that wires routes, registers none itself
 *   muxsrv/routes/*.go       5 Gorilla mux route files, one mutating route each
 *   muxsrv/middleware/auth.go RequireAuth, retained for the authed-control list only
 *   hooks/routes/*_hook.go   5 uniformly PUBLIC webhook receivers (negative control)
 *   bodycol/routes/*.go      S6: 4 authed + 1 name-auth-but-body-isnt collision
 *   bodygate/routes/*.go     S7: 5 routes whose ONLY auth is a boring guard() hook
 *   bodyunsure/routes/*.go   S8: 4 authed + 1 imported-hook UNSURE
 *
 * Receiver recognition in the Gin group deliberately mixes two recognition
 * paths (the Flask convention/structural mix, ported to Go): four routes
 * resolve their receiver STRUCTURALLY, via an in-file router-constructor
 * assignment or a Group(...) derivation (`r := gin.Default()`, `engine :=
 * gin.New()`, `app = gin.New()` plain assignment, `api := r.Group("/api")`),
 * and four resolve purely by NAMING CONVENTION on a func-param/struct-field
 * receiver with no local constructor call at all (`func RegisterX(router
 * *gin.Engine)`, two `*gin.RouterGroup` params, one method-receiver file).
 * Auth idiom is independently split across BOTH: four files register auth
 * receiver-scoped via `<recv>.Use(AuthMiddleware())` BEFORE the route, four
 * pass it as a per-route leading arg `<recv>.POST(path, AuthMiddleware(),
 * handler)` — two of each idiom land in each receiver-recognition group, so
 * every corner of the 2x2 is exercised by a real route file.
 */
import type { BaselineFile } from "./baseline.js";

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A Go struct-tag literal, e.g. jsonTag("sku") -> `` `json:"sku"` ``. Built via
 *  a plain double-quoted string so no backtick-escaping is needed at any of
 *  this file's (already backtick-delimited) call sites. */
function jsonTag(key: string): string {
  return "`json:\"" + key + "\"`";
}

// The in-file auth middleware every "authed" Gin fixture defines: a factory
// returning a closure that 401s when the Authorization header is missing.
// Identical text across every file that uses it, so a single strip() call
// can remove it deterministically (see stripGinAuth below).
const GIN_AUTH_BLOCK =
`func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	}
}

`;

// ─── gosrv: 8 Gin route files, one mutating route each ───────────────────────
const GOSRV_ROOT = "gosrv/routes";

function ginRequestStruct(name: string, fields: Array<[string, string, string]>): string {
  const cap = capitalize(name);
  const lines = fields.map(([f, t, j]) => `\t${f} ${t} ${jsonTag(j)}`).join("\n");
  return `type create${cap}Request struct {\n${lines}\n}`;
}

function ginHandler(name: string): string {
  const cap = capitalize(name);
  return `func create${cap}(c *gin.Context) {\n\tc.JSON(201, gin.H{"ok": true})\n}\n`;
}

// 1. users — structural (r := gin.Default()), Use-idiom.
function usersFile(): BaselineFile {
  return {
    path: `${GOSRV_ROOT}/users.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("user", [["Email", "string", "email"], ["Name", "string", "name"]])}

${GIN_AUTH_BLOCK}func RegisterUsers() {
	r := gin.Default()
	r.Use(AuthMiddleware())
	r.POST("/users", createUser)
}

${ginHandler("user")}`,
  };
}

// 2. orders — structural (engine := gin.New()), Use-idiom.
function ordersFile(): BaselineFile {
  return {
    path: `${GOSRV_ROOT}/orders.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("order", [["SKU", "string", "sku"], ["Count", "int", "count"]])}

${GIN_AUTH_BLOCK}func RegisterOrders() {
	engine := gin.New()
	engine.Use(AuthMiddleware())
	engine.POST("/orders", createOrder)
}

${ginHandler("order")}`,
  };
}

// 3. payments — structural (app = gin.New() plain assignment), per-route arg.
function paymentsFile(): BaselineFile {
  return {
    path: `${GOSRV_ROOT}/payments.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("payment", [["Amount", "int", "amount"], ["Currency", "string", "currency"]])}

var app *gin.Engine

${GIN_AUTH_BLOCK}func RegisterPayments() {
	app = gin.New()
	app.POST("/payments", AuthMiddleware(), createPayment)
}

${ginHandler("payment")}`,
  };
}

// 4. products — structural derived group (api := r.Group("/api")), per-route arg.
function productsFile(): BaselineFile {
  return {
    path: `${GOSRV_ROOT}/products.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("product", [["Name", "string", "name"], ["Price", "float64", "price"]])}

${GIN_AUTH_BLOCK}func RegisterProducts(r *gin.Engine) {
	api := r.Group("/api")
	api.POST("/products", AuthMiddleware(), createProduct)
}

${ginHandler("product")}`,
  };
}

// 5. invoices — convention func-param (router *gin.Engine, no local ctor), Use-idiom.
function invoicesFile(): BaselineFile {
  return {
    path: `${GOSRV_ROOT}/invoices.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("invoice", [["CustomerID", "string", "customerId"], ["Total", "float64", "total"]])}

${GIN_AUTH_BLOCK}func RegisterInvoices(router *gin.Engine) {
	router.Use(AuthMiddleware())
	router.POST("/invoices", createInvoice)
}

${ginHandler("invoice")}`,
  };
}

// 6. carts — convention func-param (*gin.RouterGroup, no local ctor), Use-idiom.
function cartsFile(): BaselineFile {
  return {
    path: `${GOSRV_ROOT}/carts.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("cart", [["UserID", "string", "userId"]])}

${GIN_AUTH_BLOCK}func RegisterCarts(grp *gin.RouterGroup) {
	grp.Use(AuthMiddleware())
	grp.POST("/carts", createCart)
}

${ginHandler("cart")}`,
  };
}

// 7. sessions — convention func-param (*gin.RouterGroup, no local ctor), per-route arg.
function sessionsFile(): BaselineFile {
  return {
    path: `${GOSRV_ROOT}/sessions.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("session", [["UserID", "string", "userId"]])}

${GIN_AUTH_BLOCK}func RegisterSessions(apiGroup *gin.RouterGroup) {
	apiGroup.POST("/sessions", AuthMiddleware(), createSession)
}

${ginHandler("session")}`,
  };
}

// 8. notifications — convention method-receiver (s.router.POST), per-route arg.
function notificationsFile(): BaselineFile {
  return {
    path: `${GOSRV_ROOT}/notifications.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("notification", [["UserID", "string", "userId"], ["Message", "string", "message"]])}

type server struct {
	router *gin.Engine
}

${GIN_AUTH_BLOCK}func (s *server) RegisterNotifications() {
	s.router.POST("/notifications", AuthMiddleware(), createNotification)
}

${ginHandler("notification")}`,
  };
}

export function ginAuthedGroup(): BaselineFile[] {
  return [
    usersFile(), ordersFile(), paymentsFile(), productsFile(),
    invoicesFile(), cartsFile(), sessionsFile(), notificationsFile(),
  ];
}

// Support files: kept OUT of ginAuthedGroup() so it stays one-route-per-file
// exactly (S0's route-loss guard requires every element to yield exactly one
// route). goAuthFile is the repo-global MACHINERY-token support file: the
// route files now each carry their OWN in-file AuthMiddleware (that is what
// blesses each route directly), so this file's role is purely to keep the
// "the codebase uses auth elsewhere" evidence present once those in-file
// copies are stripped (S3). The exported name is LOAD-BEARING: "AuthMiddleware"
// (capital A, capital M) is what the case-sensitive repoHasAuthMachinery
// regex matches.
export const goAuthFile: BaselineFile = {
  path: "gosrv/middleware/auth.go",
  content:
`package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// AuthMiddleware is the shared repo auth gate. Route files under gosrv/routes
// each define their OWN in-file copy (that is what actually blesses each
// route); this file exists so "the codebase uses auth elsewhere" evidence
// survives once those in-file copies are stripped.
func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	}
}
`,
};

export const goMainFile: BaselineFile = {
  path: "gosrv/main.go",
  content:
`package main

import (
	"github.com/gin-gonic/gin"

	"example.com/gosrv/routes"
)

func main() {
	r := gin.Default()
	routes.RegisterProducts(r)
	routes.RegisterInvoices(r)
	r.Run(":8080")
}
`,
};

function sortedEligiblePaths(files: BaselineFile[], predicate: (path: string) => boolean): string[] {
  return files
    .map((f) => f.path)
    .filter(predicate)
    .sort();
}

/** Sorted gosrv/routes/*.go paths in `files` — the deterministic strip order
 *  stripGinAuth uses, exposed so tests can compute which path(s) got stripped
 *  without duplicating the sort/filter logic. */
export function sortedGinRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${GOSRV_ROOT}/`) && p.endsWith(".go"));
}

/** Deterministically strips the in-file AuthMiddleware block AND its call site
 *  (a `<recv>.Use(AuthMiddleware())` own-line for the Use idiom, or the inline
 *  `AuthMiddleware(), ` argument for the per-route-arg idiom — idiom-agnostic,
 *  so it works on either shape without per-file metadata) from the first
 *  `count` gosrv route files, sorted by path. The route registration and its
 *  path are untouched, so every stripped file remains a valid, still-mutating
 *  route with hasAuth: false and NO machinery token of its own. */
export function stripGinAuth(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedGinRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    let content = f.content.replace(GIN_AUTH_BLOCK, "");
    content = content
      .split("\n")
      .filter((line) => !/^\s*\S+\.Use\(AuthMiddleware\(\)\)\s*$/.test(line))
      .join("\n");
    content = content.replace(/AuthMiddleware\(\),\s*/g, "");
    return { path: f.path, content };
  });
}

// ─── muxsrv: 5 Gorilla mux route files, one mutating route each ─────────────
const MUXSRV_ROOT = "muxsrv/routes";

// 5 Gorilla files so one deviator gives 4/5 = 0.8 > 0.75 (n=4 can never clear
// the strict gate). Each blesses through the WRAPPED-HANDLER form
// (RequireAuth(http.HandlerFunc(handleX))) resolved via rule 2 (the readable
// in-file reject inside the returned closure), never on the name.
function muxRouteFile(name: string): BaselineFile {
  const cap = capitalize(name);
  return {
    path: `${MUXSRV_ROOT}/${name}.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gorilla/mux"
)

${ginRequestStruct(name, [["ID", "string", "id"]])}

func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func Register${cap}() {
	router := mux.NewRouter()
	router.Handle("/${name}", RequireAuth(http.HandlerFunc(handle${cap}))).Methods("POST")
}

func handle${cap}(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusCreated)
}
`,
  };
}

export function muxAuthedGroup(): BaselineFile[] {
  return ["items", "accounts", "subscriptions", "tickets", "shipments"].map(muxRouteFile);
}

// Retained only for the uniformly-authed control's file list; the routes no
// longer import it (they bless via their own in-file def). "RequireAuth"
// (capital R) is not "requireAuth" (lowercase r) — the case-sensitive
// repoHasAuthMachinery regex does not match it, so this file carries no
// machinery-token evidence (gosrv's AuthMiddleware does that job in mixed
// scenarios; S2 needs no gap fallback in the first place).
export const muxAuthFile: BaselineFile = {
  path: "muxsrv/middleware/auth.go",
  content:
`package middleware

import "net/http"

func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
`,
};

/** Sorted muxsrv/routes/*.go paths in `files`, same purpose as
 *  sortedGinRoutePaths above. */
export function sortedMuxRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${MUXSRV_ROOT}/`) && p.endsWith(".go"));
}

/** Deterministically strips auth from the first `count` sorted mux route
 *  files: replaces `RequireAuth(http.HandlerFunc(handleX))` with the bare
 *  `http.HandlerFunc(handleX)`. The now-unused in-file RequireAuth def may
 *  stay (its name does not match the machinery regex, so it never leaks
 *  false "the repo uses auth elsewhere" evidence). */
export function stripMuxAuth(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedMuxRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const content = f.content.replace(/RequireAuth\(http\.HandlerFunc\((\w+)\)\)/, "http.HandlerFunc($1)");
    return { path: f.path, content };
  });
}

/** uniformly-authed control: the full Gin + Gorilla corpus, unchanged. */
export function uniformlyAuthed(): BaselineFile[] {
  return [...ginAuthedGroup(), goAuthFile, goMainFile, ...muxAuthedGroup(), muxAuthFile];
}

// ─── hooks: 5 uniformly PUBLIC webhook receivers (negative control) ─────────
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
// named isValidSignature — never as a Use hook, never as a wrap, and the
// handler position is never classified by the middleware scanner in the
// first place. Own directory root so it never shares repoHasAuthMachinery
// evidence with the authed corpora.
function hookFile(provider: HookProvider): BaselineFile {
  const cap = capitalize(provider.name);
  return {
    path: `${HOOKS_ROOT}/${provider.name}_hook.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// ${cap} webhook receiver. Requests are verified via payload signature
// checking inside the handler, never via a gate that runs before it.

func Register${cap}Webhook(${provider.name}Router *gin.RouterGroup) {
	${provider.name}Router.POST("/webhooks/${provider.name}", handle${cap}Event)
}

func handle${cap}Event(c *gin.Context) {
	if !isValidSignature(c.GetHeader("${provider.header}")) {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	c.JSON(200, gin.H{"received": true})
}

func isValidSignature(header string) bool {
	return len(header) > 8
}
`,
  };
}

export function publicByDesignControl(): BaselineFile[] {
  return HOOK_PROVIDERS.map(hookFile);
}

// ─── S10/S11: cross-file auth resolution (imported middleware, in-repo vs
// external) ───────────────────────────────────────────────────────────────
//
// Mirrors python-security-fixture.ts's S10/S11: S10 proves the POSITIVE (a
// package-qualified middleware.RequireAuth() call resolves cross-PACKAGE to
// internal/middleware/auth.go's REJECTING body and blesses every importing
// route); S11 proves the NEGATIVE (the SAME 5 route files, same call,
// importing from an out-of-repo package path instead: cross-file resolution
// runs live and still refuses, because the import path never maps under the
// root module's prefix — see goImportPathToDir's null return in
// security-xfile-index.ts). Both groups share the SAME 5 relativePaths
// (handlers/<name>.go) and bodies; only the import path differs.
const S10_ROOT = "handlers";
const S10_NAMES = ["campaigns", "surveys", "audits", "reviews", "backups"];

function xfileRouteFile(name: string, importPath: string): BaselineFile {
  const cap = capitalize(name);
  return {
    path: `${S10_ROOT}/${name}.go`,
    content:
`package handlers

import (
	"${importPath}"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct(name, [["Name", "string", "name"]])}

func Register${cap}(r *gin.Engine) {
	r.Use(middleware.RequireAuth())
	r.POST("/${name}", create${cap})
}

${ginHandler(name)}`,
  };
}

/** S10: 5 route files, each `import "myapp/internal/middleware"` — a REAL
 *  in-repo package resolvable to internal/middleware/auth.go below. */
export function goCrossFileAuthedGroup(): BaselineFile[] {
  return S10_NAMES.map((name) => xfileRouteFile(name, "myapp/internal/middleware"));
}

/** S10 support: the module root (threads goModulePath) and the shared
 *  cross-PACKAGE middleware. RequireAuth's BODY (401 on a missing
 *  Authorization header, the exact GIN_AUTH_BLOCK reject signature) is what
 *  blesses the importing routes — never its name. */
export const goCrossFileModFile: BaselineFile = {
  path: "go.mod",
  content: `module myapp\n\ngo 1.21\n`,
};
export const goCrossFileAuthFile: BaselineFile = {
  path: "internal/middleware/auth.go",
  content:
`package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// RequireAuth is the shared cross-PACKAGE auth gate imported by every
// handlers/*.go route file (import "myapp/internal/middleware"). Its BODY,
// not its name, is what blesses the importing routes cross-file.
func RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	}
}
`,
};

/** S11: the SAME 5 route files (same paths, same call) importing
 *  middleware.RequireAuth() from an out-of-repo package path instead — no
 *  internal/middleware dir needed for THIS group (nothing resolves
 *  regardless: the import path never maps under the root module prefix). */
export function goCrossFileExternalGroup(): BaselineFile[] {
  return S10_NAMES.map((name) => xfileRouteFile(name, "github.com/foo/middleware"));
}

/** Sorted handlers/*.go paths in `files` — same predicate for either group
 *  above, since they share paths. */
export function sortedCrossFileGoRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${S10_ROOT}/`) && p.endsWith(".go"));
}

/** Deterministically strips the middleware import AND its Use() call from
 *  the first `count` S10/S11 files, sorted by path, leaving a bare (now
 *  unauthed, S1-shape) still-mutating route. Matches either group's import
 *  path, so it works on files pulled from either. */
export function stripCrossFileGoAuth(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedCrossFileGoRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    let content = f.content
      .replace('\t"myapp/internal/middleware"\n\n', "")
      .replace('\t"github.com/foo/middleware"\n\n', "");
    content = content
      .split("\n")
      .filter((line) => line.trim() !== "r.Use(middleware.RequireAuth())")
      .join("\n");
    return { path: f.path, content };
  });
}

// ─── S6-S8: body-signature calibration groups ────────────────────────────────
//
// Each group roots its own directory so the route-directory vote grouping and
// repoHasAuthMachinery evidence never bleed between scenarios. Each helper
// keeps "one route per file" so the non-vacuity guards stay exact.

/** A Gin route file authed by an in-file AuthMiddleware factory, Use-scoped
 *  BEFORE the route (rule-2 bless). Shared by bodyCollisionGroup (S6) and
 *  bodyUnsureGroup (S8) for their four confidently-authed peers. */
function ginUseAuthedFile(root: string, name: string): BaselineFile {
  const cap = capitalize(name);
  return {
    path: `${root}/${name}.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct(name, [["Name", "string", "name"]])}

${GIN_AUTH_BLOCK}func Register${cap}(router *gin.Engine) {
	router.Use(AuthMiddleware())
	router.POST("/${name}", create${cap})
}

${ginHandler(name)}`,
  };
}

// ── S6: name-auth-but-body-isnt collision (negative) ─────────────────────────
const S6_ROOT = "bodycol/routes";
/** The one deviator in S6: its only gate is an in-file `authCheck` whose
 *  visible body merely LOGS the request path and calls Next unconditionally.
 *  Body-first classification resolves it flat not-auth (name looks like
 *  auth, body is not), so the finding must NOT be suppressed. */
export const bodyCollisionDeviatorPath = `${S6_ROOT}/notify.go`;
export function bodyCollisionGroup(): BaselineFile[] {
  const authed = ["widgets", "gadgets", "tools", "devices"].map((n) => ginUseAuthedFile(S6_ROOT, n));
  const collision: BaselineFile = {
    path: bodyCollisionDeviatorPath,
    content:
`package routes

import (
	"log"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct("notify", [["Message", "string", "message"]])}

// authCheck's NAME looks like auth, but its BODY only logs the request path
// and calls Next unconditionally: body-first classification resolves this
// flat not-auth (a visible non-enforcing body, rule 3), never a bless and
// never a hedge.
func authCheck(c *gin.Context) {
	log.Printf("auth %s", c.Request.URL.Path)
	c.Next()
}

func RegisterNotify(r *gin.Engine) {
	r.Use(authCheck)
	r.POST("/notify", createNotify)
}

${ginHandler("notify")}`,
  };
  return [...authed, collision];
}

// ── S7: body-is-real-auth positive (boring guard() hook) ─────────────────────
const S7_ROOT = "bodygate/routes";
/** The exact Use block S7 files carry and stripBodyGate removes: a boring
 *  name (`guard`) whose BODY reads the Authorization header and 401s, so ONLY
 *  the body signature blesses (no auth-lexicon identifier anywhere in S7). */
const GO_GUARD_BLOCK =
`func guard(c *gin.Context) {
	if c.GetHeader("Authorization") == "" {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	c.Next()
}

`;
function bodyGateFile(name: string): BaselineFile {
  const cap = capitalize(name);
  return {
    path: `${S7_ROOT}/${name}.go`,
    content:
`package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

${ginRequestStruct(name, [["Name", "string", "name"]])}

${GO_GUARD_BLOCK}func Register${cap}(r *gin.Engine) {
	r.Use(guard)
	r.POST("/${name}", create${cap})
}

${ginHandler(name)}`,
  };
}
export function bodyGateGroup(): BaselineFile[] {
  return ["posts", "comments", "reviews", "tags", "media"].map(bodyGateFile);
}
export function sortedBodyGateRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${S7_ROOT}/`) && p.endsWith(".go"));
}
/** Removes the guard() Use block from the first `count` S7 files, sorted by
 *  path, leaving a bare (now unauthed) still-mutating route. */
export function stripBodyGate(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedBodyGateRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const content = f.content
      .replace(GO_GUARD_BLOCK, "")
      .split("\n")
      .filter((line) => line.trim() !== "r.Use(guard)")
      .join("\n");
    return { path: f.path, content };
  });
}

// ── S8: unresolvable-body UNSURE (imported auth-flavored middleware) ─────────
const S8_ROOT = "bodyunsure/routes";
/** The one deviator in S8: an IMPORTED auth-flavored middleware whose body is
 *  not visible in this file, so it resolves UNSURE (hasAuth false,
 *  authUnsureHook set, hedged copy), never a bless. */
export const bodyUnsureDeviatorPath = `${S8_ROOT}/reports.go`;
export function bodyUnsureGroup(): BaselineFile[] {
  const authed = ["alpha", "beta", "gamma", "delta"].map((n) => ginUseAuthedFile(S8_ROOT, n));
  const unsure: BaselineFile = {
    path: bodyUnsureDeviatorPath,
    content:
`package routes

import (
	"github.com/gin-gonic/gin"

	"example.com/bodyunsure/middleware"
)

${ginRequestStruct("report", [["Title", "string", "title"]])}

// The only gate is an IMPORTED auth-flavored middleware.VerifyToken: its body
// is not visible in this file, so it resolves UNSURE (hedged copy naming the
// hook), never a bless.
func RegisterReports(router *gin.Engine) {
	router.Use(middleware.VerifyToken)
	router.POST("/reports", createReport)
}

${ginHandler("report")}`,
  };
  return [...authed, unsure];
}
