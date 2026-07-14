/**
 * Calibration fixture for the Python AST security extractor (Task 7): a
 * realistic Flask + FastAPI multi-file corpus with planted ground truth, used
 * by test/calibration/security-python.test.ts to measure BOTH the primary
 * dominance vote (analyzeSecurityProperty) and the uniform-auth-gap fallback
 * (analyzeUniformAuthGap) on real framework idioms, plus a negative control
 * that must produce zero findings.
 *
 * Directory layout mirrors three independent "repos" so each corpus roots its
 * own `repoHasAuthMachinery` evidence (that check is repo-global over
 * whatever files are in ctx.files, not scoped to a route group):
 *   pysrv/routes/*_routes.py   8 Flask blueprints, one mutating route each
 *   pysrv/auth.py              the shared @login_required decorator
 *   pysrv/app.py                factory that registers blueprints, no routes
 *   fastsrv/routes/*_api.py    5 FastAPI routers, one mutating route each
 *   fastsrv/deps.py            the shared get_current_user dependency
 *   hooks/routes/*_hook.py     5 uniformly PUBLIC webhook receivers (negative control)
 *
 * Addendum (S6-S9) adds four more independent roots exercising the body-signature
 * hook classifier and the methods= variable resolver:
 *   hookcol/routes/*_routes.py    S6: 4 @login_required + 1 name-auth-but-body-isnt
 *                                 collision (verify_user_email that only emails)
 *   bodysrv/routes/*_routes.py    S7: 5 routes whose ONLY auth is a boring gate()
 *                                 before_request hook (session read + abort(401))
 *   unsuresrv/routes/*_routes.py  S8: 4 @login_required + 1 imported-hook UNSURE
 *   varsrv/routes/*_routes.py     S9: 5 routes with methods=ALLOWED resolved from a
 *                                 same-file ("POST",) tuple literal
 *
 * Receiver names in the Flask group deliberately mix two recognition paths so
 * the fixture measures recall across BOTH: four convention-gated names
 * (users_bp, orders_bp, payments_router, api — recognized by ROUTER_RECEIVER)
 * and four bare names resolved only structurally via their `Blueprint(...)`
 * assignment (main, carts, auth, admin — the "flasky" tutorial layout).
 */
import type { BaselineFile } from "./baseline.js";

interface FlaskEntity {
  name: string;
  receiver: string;
  blueprintName: string;
}

// 8 entities: 4 convention-gated receivers, 4 bare receivers resolved only
// structurally via their Blueprint(...) assignment (never-false-bless: a
// route-loss regression on the structural path must show up here, not just
// on the convention-gated one).
const FLASK_ENTITIES: FlaskEntity[] = [
  { name: "users", receiver: "users_bp", blueprintName: "users" },
  { name: "orders", receiver: "orders_bp", blueprintName: "orders" },
  { name: "payments", receiver: "payments_router", blueprintName: "payments" },
  { name: "products", receiver: "api", blueprintName: "catalog" },
  { name: "invoices", receiver: "main", blueprintName: "main" },
  { name: "carts", receiver: "carts", blueprintName: "carts" },
  { name: "sessions", receiver: "auth", blueprintName: "auth" },
  { name: "notifications", receiver: "admin", blueprintName: "admin" },
];

// 5 FastAPI routers, one mutating route each, all guarded via the same
// Depends(get_current_user) idiom. 5 files so one deviator gives 4/5 = 0.8 >
// 0.75 (n=4 would never clear the strict > 0.75 gate).
const FASTAPI_ENTITIES = ["items", "accounts", "subscriptions", "tickets", "shipments"];

interface HookProvider {
  name: string;
  header: string;
}

// 5 uniformly public webhook receivers: signature checking (if any) happens
// INSIDE the handler body via a helper named check_signature, never as a
// before_request hook and never under an auth-lexicon name. This is the
// negative control corpus and lives in its own directory root so it never
// shares repoHasAuthMachinery evidence with the authed corpora.
const HOOK_PROVIDERS: HookProvider[] = [
  { name: "stripe", header: "Stripe-Signature" },
  { name: "github", header: "X-Hub-Signature-256" },
  { name: "slack", header: "X-Slack-Signature" },
  { name: "twilio", header: "X-Twilio-Signature" },
  { name: "sendgrid", header: "X-Sendgrid-Signature" },
];

function flaskRouteFile(entity: FlaskEntity): BaselineFile {
  return {
    path: `pysrv/routes/${entity.name}_routes.py`,
    content:
`"""POST /${entity.name}: create a ${entity.name} record."""
from flask import Blueprint, jsonify, request
from ..auth import login_required

${entity.receiver} = Blueprint("${entity.blueprintName}", __name__)

@${entity.receiver}.route("/${entity.name}", methods=["POST"])
@login_required
def create_${entity.name}():
    payload = request.get_json()
    return jsonify(payload), 201
`,
  };
}

function fastapiRouteFile(name: string): BaselineFile {
  return {
    path: `fastsrv/routes/${name}_api.py`,
    content:
`"""POST /${name}: create a ${name} record."""
from fastapi import APIRouter, Depends
from ..deps import get_current_user

router = APIRouter()

@router.post("/${name}")
async def create_${name}(payload: dict, user=Depends(get_current_user)):
    return {"ok": True}
`,
  };
}

function hookFile(provider: HookProvider): BaselineFile {
  return {
    path: `hooks/routes/${provider.name}_hook.py`,
    content:
`"""${provider.name} webhook receiver. Requests are verified via payload
signature checking inside the handler, never via a gate that runs before it."""
from flask import Blueprint, jsonify, request

${provider.name}_bp = Blueprint("${provider.name}_webhooks", __name__)


def check_signature(payload, header):
    if not header:
        return False
    return len(header) > 8


@${provider.name}_bp.route("/webhooks/${provider.name}", methods=["POST"])
def handle_${provider.name}_event():
    if not check_signature(request.get_data(), request.headers.get("${provider.header}")):
        return jsonify({"error": "bad signature"}), 400
    event = request.get_json()
    return jsonify({"received": True, "type": event.get("type")})
`,
  };
}

export function flaskAuthedGroup(): BaselineFile[] {
  return FLASK_ENTITIES.map(flaskRouteFile);
}

export function fastapiAuthedGroup(): BaselineFile[] {
  return FASTAPI_ENTITIES.map(fastapiRouteFile);
}

export function publicByDesignControl(): BaselineFile[] {
  return HOOK_PROVIDERS.map(hookFile);
}

// Support files: kept OUT of flaskAuthedGroup()/fastapiAuthedGroup() so those
// two functions stay "one route per file" exactly (S0's route-loss guard
// requires every element to yield exactly one route). Callers add these
// explicitly, matching how they carry repoHasAuthMachinery evidence.
export const pyAuthFile: BaselineFile = {
  path: "pysrv/auth.py",
  content:
`"""Shared login-required decorator for Flask blueprints."""
import functools

from flask import g, jsonify, request


def login_required(f):
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get("Authorization")
        if not token:
            return jsonify({"error": "unauthorized"}), 401
        g.user_id = token.removeprefix("Bearer ")
        return f(*args, **kwargs)

    return wrapper
`,
};

export const pyAppFile: BaselineFile = {
  path: "pysrv/app.py",
  content:
`"""Application factory: wires blueprints together, registers no routes of its own."""
from flask import Flask

from .routes.users_routes import users_bp
from .routes.orders_routes import orders_bp
from .routes.payments_routes import payments_router
from .routes.products_routes import api
from .routes.invoices_routes import main
from .routes.carts_routes import carts
from .routes.sessions_routes import auth
from .routes.notifications_routes import admin


def create_app():
    app = Flask(__name__)
    app.register_blueprint(users_bp)
    app.register_blueprint(orders_bp)
    app.register_blueprint(payments_router)
    app.register_blueprint(api)
    app.register_blueprint(main)
    app.register_blueprint(carts)
    app.register_blueprint(auth)
    app.register_blueprint(admin)
    return app
`,
};

export const pyDepsFile: BaselineFile = {
  path: "fastsrv/deps.py",
  content:
`"""Shared FastAPI dependencies."""
from fastapi import HTTPException, Request


async def get_current_user(request: Request):
    token = request.headers.get("Authorization")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"id": token.removeprefix("Bearer ")}
`,
};

/** uniformly-authed control: the full Flask + FastAPI corpus, unchanged. */
export function uniformlyAuthed(): BaselineFile[] {
  return [...flaskAuthedGroup(), pyAuthFile, pyAppFile, ...fastapiAuthedGroup(), pyDepsFile];
}

function sortedEligiblePaths(files: BaselineFile[], predicate: (path: string) => boolean): string[] {
  return files
    .map((f) => f.path)
    .filter(predicate)
    .sort();
}

/** Sorted pysrv/routes/*_routes.py paths in `files` — the deterministic
 *  strip order stripFlaskAuth uses, exposed so tests can compute which
 *  path(s) got stripped without duplicating the sort/filter logic. */
export function sortedFlaskRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith("pysrv/routes/") && p.endsWith("_routes.py"));
}

/** Sorted fastsrv/routes/*_api.py paths in `files`, same purpose as
 *  sortedFlaskRoutePaths above. */
export function sortedFastapiRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith("fastsrv/routes/") && p.endsWith("_api.py"));
}

/** Deterministically strips @login_required (decorator line AND its import)
 *  from the first `count` Flask route files, sorted by path. The route
 *  decorator and its methods=["POST"] kwarg are untouched, so every stripped
 *  file remains a valid, still-mutating route with hasAuth: false. */
export function stripFlaskAuth(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedFlaskRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const lines = f.content
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== "from ..auth import login_required" && line.trim() !== "@login_required",
      );
    return { path: f.path, content: lines.join("\n") };
  });
}

/** Deterministically strips `, user=Depends(get_current_user)` (and its
 *  import) from the first `count` FastAPI route files, sorted by path. The
 *  route decorator is untouched, so every stripped file remains a valid,
 *  still-mutating route with hasAuth: false. */
export function stripFastapiAuth(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedFastapiRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const content = f.content
      .split("\n")
      .filter((line) => line.trim() !== "from ..deps import get_current_user")
      .join("\n")
      .replace(", user=Depends(get_current_user)", "");
    return { path: f.path, content };
  });
}

// ─── S6-S9: body-signature + methods-var calibration groups (addendum) ───────
//
// Each group roots its own directory so the route-directory vote grouping and
// `repoHasAuthMachinery` evidence never bleed between scenarios. Each helper
// keeps "one route per file" so the non-vacuity guards stay exact.

/** A Flask route file authed by an @login_required decorator applied BELOW the
 *  route decorator (positional binding: it must sit below to be enforced). */
function loginRequiredRouteFile(root: string, receiver: string, blueprintName: string, name: string): BaselineFile {
  return {
    path: `${root}/${name}_routes.py`,
    content:
`"""POST /${name}: create a ${name} record."""
from flask import Blueprint, jsonify, request
from ..auth import login_required

${receiver} = Blueprint("${blueprintName}", __name__)

@${receiver}.route("/${name}", methods=["POST"])
@login_required
def create_${name}():
    payload = request.get_json()
    return jsonify(payload), 201
`,
  };
}

// ── S6: name-auth-but-body-isnt collision (negative) ─────────────────────────
const S6_ROOT = "hookcol/routes";
/** The one deviator in S6: its only gate is a `verify_user_email` before_request
 *  hook whose visible body merely sends a confirmation email. Body-first
 *  classification resolves it flat not-auth (name looks like auth, body is not),
 *  so the finding must NOT be suppressed. */
export const hookCollisionDeviatorPath = `${S6_ROOT}/notify_routes.py`;
export function hookCollisionGroup(): BaselineFile[] {
  const authed = [
    loginRequiredRouteFile(S6_ROOT, "users_bp", "users", "users"),
    loginRequiredRouteFile(S6_ROOT, "orders_bp", "orders", "orders"),
    loginRequiredRouteFile(S6_ROOT, "payments_router", "payments", "payments"),
    loginRequiredRouteFile(S6_ROOT, "carts", "carts", "carts"),
  ];
  const collision: BaselineFile = {
    path: hookCollisionDeviatorPath,
    content:
`"""POST /notify: send a notification. The only before_request gate is
verify_user_email, whose visible body merely emails a confirmation link, so the
NAME looks like auth while the BODY does not authenticate (body-first: flat
not-auth, no bless)."""
from flask import Blueprint, jsonify, request, g

notify_bp = Blueprint("notify", __name__)


@notify_bp.before_request
def verify_user_email():
    send_confirmation_email(g.user.email)
    return None


@notify_bp.route("/notify", methods=["POST"])
def create_notify():
    payload = request.get_json()
    return jsonify(payload), 201
`,
  };
  return [...authed, collision];
}

// ── S7: body-is-real-auth positive (boring gate() hook) ──────────────────────
const S7_ROOT = "bodysrv/routes";
/** The exact before_request block S7 files carry and stripBodyHook removes; a
 *  boring name (`gate`) whose BODY reads the session and abort(401)s, so ONLY
 *  the body signature blesses (no auth-lexicon identifier anywhere in S7). */
function bodyGateBlock(receiver: string): string {
  return (
`@${receiver}.before_request
def gate():
    if not session.get("user_id"):
        abort(401)


`
  );
}
function bodyGateFile(name: string): BaselineFile {
  const receiver = `${name}_bp`;
  return {
    path: `${S7_ROOT}/${name}_routes.py`,
    content:
`"""POST /${name}: create a ${name}. The ONLY auth is a boring-named gate()
before_request hook (session read + abort(401)); no auth-lexicon identifier
appears in this corpus, so a name-based check would see nothing."""
from flask import Blueprint, session, abort, request, jsonify

${receiver} = Blueprint("${name}", __name__)


${bodyGateBlock(receiver)}@${receiver}.route("/${name}", methods=["POST"])
def create_${name}():
    return jsonify(request.get_json()), 201
`,
  };
}
export function bodyAuthedGroup(): BaselineFile[] {
  return ["items", "accounts", "subscriptions", "tickets", "shipments"].map(bodyGateFile);
}
export function sortedBodyRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${S7_ROOT}/`) && p.endsWith("_routes.py"));
}
/** Removes the gate() before_request block from the first `count` S7 files,
 *  sorted by path, leaving a bare (now unauthed) still-mutating route. */
export function stripBodyHook(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedBodyRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const name = f.path.slice(`${S7_ROOT}/`.length, -"_routes.py".length);
    return { path: f.path, content: f.content.replace(bodyGateBlock(`${name}_bp`), "") };
  });
}

// ── S8: unresolvable-body UNSURE (imported before_request hook) ───────────────
const S8_ROOT = "unsuresrv/routes";
/** The one deviator in S8: an IMPORTED before_request hook whose body is not
 *  visible in-file, so it resolves UNSURE (hasAuth false, authUnsureHook set,
 *  hedged copy), never a bless. */
export const unsureHookDeviatorPath = `${S8_ROOT}/reports_routes.py`;
export function unsureHookGroup(): BaselineFile[] {
  const authed = [
    loginRequiredRouteFile(S8_ROOT, "alpha_bp", "alpha", "alpha"),
    loginRequiredRouteFile(S8_ROOT, "beta_bp", "beta", "beta"),
    loginRequiredRouteFile(S8_ROOT, "gamma_bp", "gamma", "gamma"),
    loginRequiredRouteFile(S8_ROOT, "delta_bp", "delta", "delta"),
  ];
  const unsure: BaselineFile = {
    path: unsureHookDeviatorPath,
    content:
`"""POST /reports: create a report. The only gate is an IMPORTED before_request
hook whose body is not visible in this file, so it resolves UNSURE (hedged copy
naming the hook), never a bless."""
from flask import Blueprint, jsonify, request
from .auth_helpers import verify_session

reports_bp = Blueprint("reports", __name__)
reports_bp.before_request(verify_session)


@reports_bp.route("/reports", methods=["POST"])
def create_reports():
    return jsonify(request.get_json()), 201
`,
  };
  return [...authed, unsure];
}

// ── S9: methods= variable resolved from a same-file literal ───────────────────
const S9_ROOT = "varsrv/routes";
function methodsVarFile(name: string, authed: boolean): BaselineFile {
  const receiver = `${name}_bp`;
  return {
    path: `${S9_ROOT}/${name}_routes.py`,
    content:
`"""POST /${name}: methods resolved from a same-file ALLOWED tuple literal."""
from flask import Blueprint, jsonify, request
from ..auth import login_required

${receiver} = Blueprint("${name}", __name__)
ALLOWED = ("POST",)

@${receiver}.route("/${name}", methods=ALLOWED)${authed ? "\n@login_required" : ""}
def create_${name}():
    return jsonify(request.get_json()), 201
`,
  };
}
export function methodsVarGroup(): BaselineFile[] {
  return ["invoices", "refunds", "coupons", "receipts", "credits"].map((n) => methodsVarFile(n, true));
}
export function sortedMethodsVarRoutePaths(files: BaselineFile[]): string[] {
  return sortedEligiblePaths(files, (p) => p.startsWith(`${S9_ROOT}/`) && p.endsWith("_routes.py"));
}
/** Strips @login_required (decorator + import) from the first `count` S9 files,
 *  sorted by path. The route decorator and its methods=ALLOWED kwarg are
 *  untouched, so the stripped file stays a POST-resolved, unauthed route. */
export function stripMethodsVarAuth(files: BaselineFile[], count: number): BaselineFile[] {
  const targets = new Set(sortedMethodsVarRoutePaths(files).slice(0, count));
  return files.map((f) => {
    if (!targets.has(f.path)) return f;
    const lines = f.content
      .split("\n")
      .filter(
        (line) =>
          line.trim() !== "@login_required" && line.trim() !== "from ..auth import login_required",
      );
    return { path: f.path, content: lines.join("\n") };
  });
}
