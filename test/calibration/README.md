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

Five scenarios, each computing precision/recall explicitly against planted
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

## Adding a new injection type

Drop a generator in `generators/`. Signature:

```ts
export function injectFoo(baseline: Baseline, rate: number): Baseline
```

Where `rate` is 0-1 (fraction of files to deviate). Add it to
`run.ts`'s list of generators and it'll sweep alongside the others.
