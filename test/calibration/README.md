# Scoring calibration harness

Two harnesses over a SYNTHETIC labeled corpus (drift injected into a uniform
baseline → exact, mechanical ground truth, no human labeling):

- **`npm run calibrate`** → `precision-recall.ts` — the **accuracy** harness.
  Injects a known drift type, derives ground-truth labels by diffing the
  mutated files, scans, and reports **precision / recall / F1 per detector**
  against that ground truth. This answers "is the detector actually accurate?",
  which the monotonicity harness below cannot.
- **`npm run calibrate:monotonic`** → `run.ts` — the older **responsiveness**
  gate: verifies the composite score drops monotonically as injected drift
  rises. A weaker check (any threshold passes it) — kept as a pre-publish
  smoke test.

## Precision/recall (the accuracy harness)

Only the **injected** categories have ground truth, so only those are scored.
Categories that fire on the templated baseline's inherent structure
(`semantic_duplication`, `dead-code`, `phantom_scaffolding` — the near-identical,
consumer-less handlers legitimately trip them) are reported separately as
**un-measured** (no clean baseline to measure against here). Baselines land in
`reports/latest.json`; compare across runs to catch accuracy regressions.

**Known finding (first baseline):** `naming_conventions` scores F1 1.00, but
`architectural_consistency` recall is 0.00 — the synthetic raw-SQL / error-shape
drift is not caught. Flagged for follow-up (injector strength vs detector gap;
overlaps the security/detector work).

To add a measurable category: add an injector to `injectors.ts` (must return a
clear minority deviation from the baseline's dominant pattern) and map its key
to the detector's `driftCategory` in `precision-recall.ts`'s `INJECTOR_CATEGORY`.

---

## Monotonicity gate (`calibrate:monotonic`)

Synthetic injection tests that verify the scoring formula responds
monotonically to drift. The goal is to catch regressions like the
"complexity dominates intentClarity" bug that shipped in 0.5.19
before the next publish.

## Temporal awareness is covered by integration tests

The temporal-pivot flow is exercised end-to-end
by `test/integration/temporal-pivot.test.ts`, which builds a real git
repo with two commits dated 400 days apart, runs the full scan
pipeline, and asserts:
- `ctx.hasGitMetadata === true`
- a finding carries `.pivot` metadata (old → new)
- legacy-pattern files are classified as `"legacy"`, not `"drift"`

That test is the calibration proof for temporal — the harness below
still covers flat-voting calibration.

## What it does

1. Generates a baseline repo with uniform patterns (one architecture,
   one naming style, one error-handling shape, etc.).
2. Produces variants by injecting drift at known levels:
   0%, 10%, 25%, 50%, 75%, 90%.
3. Runs the CLI against each variant and records:
   - composite score (the static/ML score)
   - drift composite (the 13-detector drift roll-up)
4. Asserts monotonicity — more injected drift should produce a lower
   score. If any pair violates, the run fails.

## Run it

```
npm run calibrate
```

Output:

```
Injection  Composite  Drift   Δ composite  Δ drift
─────────  ─────────  ──────  ───────────  ───────
      0%       94.5    97.2           —        —
     10%       89.0    92.0         -5.5     -5.2
     25%       80.4    82.5         -8.6    -9.5
     50%       68.7    65.1        -11.7   -17.4
     75%       55.0    48.6        -13.7   -16.5
     90%       42.2    35.8        -12.8   -12.8

monotonicity: ✓  (composite + drift both strictly decrease)
responsiveness: ✓  (each +25% drift yields ≥5pt score drop)
```

## Python security fixture (the multilang calibration gate)

`python-security-fixture.ts` + `security-python.test.ts` are the enforced
precision/recall gate for the Python AST security extractor
(`src/drift/security-ast-python.ts`). Unlike the harness above, this one runs
as a normal vitest file (`test/**/*.test.ts`), so it is checked on every
`npm test`, not just `npm run calibrate`.

The corpus is realistic Flask/FastAPI multi-file code (real Blueprint/
APIRouter idioms, `login_required` decorators, `Depends(get_current_user)`),
not minimal stubs, split into three independent roots:

- `pysrv/` — 8 Flask blueprints, one mutating route each, receiver names
  deliberately mixed between convention-gated (`users_bp`, `orders_bp`,
  `payments_router`, `api`) and bare names resolved only structurally via
  their `Blueprint(...)` assignment (`main`, `carts`, `auth`, `admin`).
- `fastsrv/` — 5 FastAPI routers, one mutating route each, guarded via
  `Depends(get_current_user)`.
- `hooks/` — 5 uniformly PUBLIC webhook receivers (Stripe, GitHub, Slack,
  Twilio, SendGrid). This is the negative control and lives in its own root
  so it never shares `repoHasAuthMachinery` evidence with the authed corpora
  (that check is repo-global over whatever files are in `ctx.files`, not
  scoped to a route group).

Nine scenarios, each computing precision/recall explicitly against planted
ground truth:

- **S0** recognition self-check — every route file in the Flask/FastAPI
  corpora yields exactly one route (13 total), and the negative control
  yields exactly 5. A receiver-gate recall regression fails here with a
  count, instead of silently vanishing from a vote several layers down.
- **S1 / S2** the primary dominance vote (`analyzeSecurityProperty`) on
  Flask and FastAPI respectively: one planted deviator among an authed
  majority, precision 1.0 / recall 1.0.
- **S3** the uniform-auth-gap fallback (`analyzeUniformAuthGap`): all 8
  Flask routes stripped at once, so the primary vote goes silent (ratio 0)
  and the gap must fire instead, precision 1.0 / recall 1.0.
- **S4** the negative control: route extraction is asserted BEFORE
  zero-findings (non-vacuity), because zero findings is also what you get
  when zero routes are recognized — silence only proves something once the
  routes were actually seen.
- **S5** the uniformly-authed control: zero findings on every axis (auth,
  validation, rate-limit).

The addendum adds four body-signature / methods-variable scenarios, each in
its own directory root and each RED-FIRST against the pre-addendum commit
(`353a939`): the assertion fails there and passes on this branch, so the pin
measures a real behavior change, not a tautology.

- **S6** name-auth-but-body-isnt collision (`hookcol/`): four
  `@login_required` routes plus one whose only gate is a `verify_user_email`
  before_request hook that merely emails. Body-first classification resolves
  it flat not-auth, so the finding must NOT be suppressed (dominantCount 4,
  consistencyScore 80, precision/recall 1.0). Red-first: the pre-addendum
  name-only path blessed the hook and the scenario produced ZERO findings.
- **S7** body-is-real-auth positive (`bodysrv/`): five routes whose ONLY auth
  is a boring-named `gate()` hook (session read + `abort(401)`); a
  machinery-style self-check asserts no auth-lexicon identifier appears. All
  five bless on the body signature alone (scenario A: zero findings);
  stripping one hook flags exactly it (scenario B). Red-first: scenario A
  fails non-vacuity pre-addendum (no body-bless, so nothing is authed).
- **S8** unresolvable-body UNSURE (`unsuresrv/`): four `@login_required`
  routes plus one gated only by an imported `before_request` hook, which
  resolves UNSURE — still flagged, with HEDGED copy naming the hook
  (`double check hook 'verify_session'`), counts identical to S6, and the S1
  deviator asserted flat in the same run (no hedge leakage). Red-first: the
  pre-addendum name path blessed the imported hook.
- **S9** methods=variable resolution (`varsrv/`): five routes registered via
  `methods=ALLOWED` where `ALLOWED = ("POST",)` is a same-file literal; every
  route resolves method exactly POST and enters the mutating auth vote.
  Red-first: pre-addendum a `methods=` variable resolved ALL, not POST.

## Go security fixture (the multilang calibration gate)

`go-security-fixture.ts` + `security-go.test.ts` are the enforced
precision/recall gate for the Go AST security extractor
(`src/drift/security-ast-go.ts`), mirroring the Python gate above
function-for-function and running the same way (a normal vitest file,
checked on every `npm test`).

The corpus is realistic Gin/Gorilla multi-file code (real router
constructors, `.Use(...)` scoping, wrapped-handler auth, chained
`.Methods(...)` resolution), split into seven independent roots so each
corpus roots its own `repoHasAuthMachinery` evidence and its own
route-directory vote (`routeGroupKey` = dirname):

- `gosrv/routes/` — 8 Gin route files, one mutating route each. Receiver
  recognition is deliberately split across both of the extractor's paths:
  four resolve structurally, via an in-file router-constructor assignment or
  a `Group(...)` derivation (`r := gin.Default()`, `engine := gin.New()`,
  `app = gin.New()` plain assignment, `api := r.Group("/api")`); four resolve
  purely by naming convention on a func-param/struct-field receiver with no
  local constructor at all (`func RegisterX(router *gin.Engine)`, two
  `*gin.RouterGroup` params, one method-receiver file). Auth idiom is
  independently split too: four files register `AuthMiddleware()`
  receiver-scoped via `.Use(...)` before the route, four pass it as a
  per-route leading arg.
- `gosrv/middleware/auth.go` / `gosrv/main.go` — support files. `auth.go`
  carries the repo-global `AuthMiddleware` machinery token (case-sensitive:
  this is what `repoHasAuthMachinery` matches); `main.go` wires routes and
  registers none of its own.
- `muxsrv/routes/` — 5 Gorilla mux route files, one mutating route each,
  each defining its own in-file `RequireAuth(next http.Handler)
  http.Handler` and registering via the WRAPPED-HANDLER form
  (`router.Handle(path, RequireAuth(http.HandlerFunc(h))).Methods("POST")`).
  Gorilla is the secondary framework (over Echo/chi) specifically because
  this one idiom puts the plan's two riskiest recognitions — the wrapped-
  handler bless and the chained `.Methods` resolution — inside the measured
  gate; Echo and chi stay covered by the unit catalog.
- `hooks/routes/` — 5 uniformly PUBLIC webhook receivers (Stripe, GitHub,
  Slack, Twilio, SendGrid), same negative-control shape as the Python row:
  signature verification happens inside the handler body, never as a `.Use`
  hook, so it's structurally invisible to the middleware scanner.
- `bodycol/routes/`, `bodygate/routes/`, `bodyunsure/routes/` — the three
  body-signature scenarios (S6-S8 below), each its own root for the same
  machinery-isolation reason.

**Why S0-S5 counts are unchanged despite the body-first rule:** the LOCKED
decision is that Go never blesses a middleware on its name alone — an
imported or opaque `AuthMiddleware`/`RequireAuth` now resolves UNSURE, not
AUTH. So every authed fixture above DEFINES its middleware IN-FILE with a
body that verifiably rejects (401 on a missing `Authorization` header), and
blesses through rule 2 (the readable reject), never through the name. That
keeps the S0-S5 arithmetic byte-identical to the pre-body-first plan while
actually exercising the tighter rule.

Nine scenarios, mirroring the Python S0-S8 (Go has no S9 analog: Go
deliberately emits `"ALL"` for a variable-methods form instead of resolving
it, so there's no same-file-literal-resolution case to pin):

| # | Scenario | Corpus | Asserts |
|---|----------|--------|---------|
| S0 | Recognition + no-name-bless pin | gosrv + muxsrv (13 files) | 1 route/file, exact Gorilla POST method, imported selector hedges, in-file reject blesses |
| S1 | Primary dominance vote, Gin | gosrv (8 files, 1 stripped) | dominantCount 7, score 88, precision/recall 1.0 |
| S2 | Primary dominance vote, Gorilla | muxsrv (5 files, 1 stripped) | dominantCount 4, score 80, through the wrap-bless path |
| S3 | Uniform-auth-gap fallback | gosrv (all 8 stripped) + auth.go | gap fires, severity error, precision/recall 1.0 |
| S4 | Negative control | hooks (5 files) | non-vacuity first, then zero findings |
| S5 | Uniformly-authed control | full gosrv + muxsrv corpus | non-vacuity first, then zero findings on every axis |
| S6 | Name-auth-but-body-isnt collision | bodycol (5 files) | flat not-auth, NOT suppressed, no hedge |
| S7 | Body-is-real-auth positive | bodygate (5 files) | boring `guard()` hook blesses on body alone |
| S8 | Unresolvable-body UNSURE | bodyunsure (5 files) | hedged copy naming the hook, counts match S6, no leakage into S1 |

**S6-S8 RED-FIRST rationale:** each scenario is a case where a name-only
classifier gives the WRONG answer, and only resolves once body-first lands.
S6's `authCheck` reads as auth by name but only logs the request path — a
name-only path would bless it and the scenario would produce zero findings;
body-first correctly reads the visible non-enforcing body and flags it. S7's
`guard()` hook carries no auth-flavored name at all — a name-only path would
never bless it, so scenario A would fail non-vacuity; body-first reads the
401-on-missing-header body and blesses it. S8's imported
`middleware.VerifyToken` has an auth-flavored name but an unreadable body — a
name-only path would bless it outright (zero findings); body-first resolves
it UNSURE instead (hedged, still flagged, never a bless).

## Cross-file auth resolution (S10-S11)

Both `security-python.test.ts` and `security-go.test.ts` add two more
scenarios, appended after S9/S8 respectively, measuring the cross-file
resolution work: an imported before_request hook (Python) or a
package-qualified middleware call (Go) whose body lives in a SEPARATE
in-repo file, rather than in the route file itself. S0-S9 are single-file /
in-file and reproduce byte-identically; cross-file resolution runs live in
every scenario in both suites (it is always built by
`securityConsistency.detect`), but it never changes an in-file verdict,
since local defs take precedence over any cross-file candidate.

- **S10** the cross-file POSITIVE: 5 route files each import a hook/middleware
  from one shared, separate in-repo file (`pkg/auth.py` in Python,
  `internal/middleware/auth.go` in Go), whose body verifiably rejects
  (a 401 on a missing session/header). Non-vacuity is asserted first
  (every route resolves `hasAuth: true`, no `authUnsureHook`), then a
  uniform corpus produces zero findings, then stripping the import + call
  from one file flags exactly it (dominantCount 4, score 80, precision/recall
  1.0). Pre-cross-file (index absent), the same files resolve
  `hasAuth: false` with a hedged `authUnsureHook` — the exact shape S8
  measures — which is the regression S10 pins.
- **S11** the cross-file NEGATIVE: the SAME 5 route files and bodies,
  importing the identical hook/middleware from an out-of-repo source instead
  (an absolute Python package, or a Go import path outside the module root).
  Cross-file resolution runs live and still refuses, because an absolute
  import is never a relative-resolution target (Python) and an out-of-repo
  import path never maps under the module prefix (Go) — never because the
  target merely doesn't exist. Every route stays hedged, byte-identical with
  and without the index. Mixing 4 files from the S10 group with 1 from the
  S11 group (same paths) reproduces the S8 shape exactly (dominantCount 4,
  score 80, hedged copy naming the hook, no em-dash/double-hyphen), and a
  plain S1-shape stripped deviator run in the same test stays flat, not
  hedged (no leakage between the two failure modes).

## Rust security fixture (the multilang calibration gate)

`rust-security-fixture.ts` + `security-rust.test.ts` are the enforced
precision/recall gate for the Rust AST security extractor
(`src/drift/security-ast-rust.ts`), mirroring the Python/Go gates above and
running the same way (a normal vitest file, checked on every `npm test`).

**The v1 boundary governs the whole corpus:** Rust v1 blesses a route ONLY
when a covering (ancestor) `.layer`/`.route_layer` wraps a
`middleware::from_fn`/`from_fn_with_state` whose in-file body VERIFIABLY
rejects (401-family). There is no name-only bless and no type-name bless. So
every authed fixture below DEFINES its `require_auth`/`gate` middleware
IN-FILE with a body that actually rejects, and blesses through the readable
reject, never through the name. Extractor-typed auth (an `AuthUser`/`Identity`
handler param) and Actix/Rocket auth resolve UNSURE at best — v1 does not read
a `FromRequest` impl even when it is in-file, and Actix attribute-macro routes
have no builder layer chain at all to walk.

The corpus is realistic Axum/Actix multi-file code (real `Router::new()`
builder chains, `.route_layer`/`.layer` scoping, `from_fn`/`from_fn_with_state`
resolution, Actix attribute macros), split into independent roots so each
corpus roots its own `repoHasAuthMachinery` evidence and its own
route-directory vote (`routeGroupKey` = dirname):

- `rustsrv/routes/` — 8 Axum files, 2 mutating routes each (POST + DELETE),
  authed via a single `.route_layer(middleware::from_fn(require_auth))`
  covering both.
- `rustsrv/auth_tokens.rs` — the repo-global `login_required` machinery token
  (case-sensitive: this is what `repoHasAuthMachinery` matches;
  Rust-idiomatic `require_auth` is deliberately NOT in that regex, mirroring
  the Python fixture's `auth.py` trick).
- `statesrv/routes/` — 5 Axum files, one mutating route each, authed via
  `.layer(middleware::from_fn_with_state(state.clone(), require_auth))`
  (LAST-arg resolution) — a SECOND bless mechanism, proving the dominance
  vote is not a single code path.
- `hooks/routes/` — 5 uniformly PUBLIC Axum webhook receivers, same
  negative-control shape as the Python/Go rows: signature verification
  happens inside the handler body via a `check_signature` helper, never as a
  `from_fn` layer, so it's structurally invisible to the covering-layer walk.
  **This is why the negative control lives in its own corpus root:**
  `repoHasAuthMachinery` is repo-global over whatever files are in
  `ctx.files`, not scoped to a route group, so mixing it into an authed
  corpus would let that corpus's own machinery leak in.
- `bodycol/routes/`, `bodygate/routes/`, `bodyunsure/routes/` — the three
  body-signature scenarios (S6-S8), each its own root for the same
  machinery-isolation reason.
- `actixsrv/` — Actix attribute-macro handlers (`#[get(...)]`/`#[post(...)]`).
  Measures the v1 boundary explicitly: method+path recognition works
  identically to Axum, but auth never blesses (an auth-flavored extractor
  type hedges, a non-auth extractor type or a scope-level `.wrap` resolves
  flat not-auth — the `.wrap` is structurally invisible to an attribute-macro
  route, since v1's covering-layer walk only ever starts from a builder
  `.route(...)` call node).

Nine scenarios (S0-S8), mirroring the Python/Go S0-S8, plus an Actix
addendum:

| # | Scenario | Corpus | Asserts |
|---|----------|--------|---------|
| S0 | Recognition + no-name-bless pin | rustsrv + statesrv + hooks (18 files) | 2 routes/file (Axum), 1 route/file (state), 1 unauthed route/file (hooks), def-only file yields 0 routes, unresolved name hedges, in-file reject blesses |
| S1 | Primary dominance vote, `from_fn` | rustsrv (8 files, 1 stripped) | dominantCount 14, totalRelevantFiles 16, consistencyScore 88, precision/recall 1.0 |
| S2 | Primary dominance vote, `from_fn_with_state` | statesrv (5 files, 1 stripped) | dominantCount 4, score 80, through the LAST-arg resolution path |
| S3 | Uniform-auth-gap fallback | rustsrv (all 8 stripped) + auth_tokens.rs | gap fires, severity error, precision/recall 1.0 |
| S4 | Negative control | hooks (5 files) | non-vacuity first, then zero findings |
| S5 | Uniformly-authed control | full rustsrv + statesrv corpus | non-vacuity first, then zero findings on every axis |
| S6 | Name-auth-but-body-isnt collision | bodycol (5 files) | flat not-auth, NOT suppressed, no hedge |
| S7 | Body-is-real-auth positive | bodygate (5 files) | boring `gate()` hook blesses on body alone |
| S8 | Unresolvable-body UNSURE | bodyunsure (5 files) | hedged copy naming the hook, counts match S6, no leakage into S1 |

**S1's arithmetic note (audit-first):** the task brief's shorthand describes
S1 by file count ("dominantCount 7, totalRelevantFiles 8"). The fixture
carries 2 mutating routes per file, so the actual applicable-routes
denominator is 16, not 8, and stripping one file's layer removes auth from
its 2 routes. The ratio is identical (7/8 == 14/16 == 0.875, consistencyScore
rounds to 88 either way), but the literal `dominantCount`/`totalRelevantFiles`
fields are asserted as 14/16 — verified against
`analyzeSecurityProperty`'s own arithmetic, not copied from the brief.

**Isolated trend row (`npm run calibrate`):** a Rust corpus loop runs after
the Go row in `precision-recall.ts`, relabeled to a dedicated
`security_posture_rust` category (never merged into the shared TS baseline or
the JS/Python/Go `security_posture` rows, for the same isolation reasons
those rows document). Measured on the first run: precision 1.00, recall 1.00
(TP 3, FP 0, FN 0) — every one of the 3 stripped files in the gap-path
variant was caught. The task brief flagged that Rust recall was *expected* to
be lower than Python/Go given the conservative v1; that did not materialize
here because this corpus's deviators use the canonical from_fn-strip shape
(the same shape S1/S3 measure), which the extractor resolves cleanly. This is
a real, verified number, not a floor — a future corpus exercising a harder
recall case (e.g. an extractor-typed deviator) could legitimately measure
lower without failing the gate (the enforced floor is the `security-floor`
row at >= 0.95, unaffected by this row).

## Adding a new injection type

Drop a generator in `generators/`. Signature:

```ts
export function injectFoo(baseline: Baseline, rate: number): Baseline
```

Where `rate` is 0-1 (fraction of files to deviate). Add it to
`run.ts`'s list of generators and it'll sweep alongside the others.
