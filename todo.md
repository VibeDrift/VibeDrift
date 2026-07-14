# CLI backlog

- **Python hook body: `Depends`-target body DEMOTION.** The additive Depends
  same-file body path (`callsWithAuthDependency`, `security-ast-python.ts`) only
  ever ADDS a bless when a boring-named dependency's visible body raises a
  verified reject; it never DEMOTES a name-hit dependency whose visible body is
  plainly non-enforcing (the mirror of the `verify_user_email` fix on the hook
  path). Symmetry with the before_request path would close a residual name-only
  bless for Depends. Left additive-only for now (demotion could hide a real
  reject reached via a shape the scanner does not model).

- **`add_middleware` class-body analysis.** `app.add_middleware(X)` blesses on
  the CLASS NAME segments only (`MIDDLEWARE_AUTH_SEGMENTS`); it does not read the
  middleware class body (its `__call__`/`dispatch`) to confirm or deny auth. A
  body-first pass (as done for before_request hooks) would let a boring-named
  middleware whose dispatch 401s bless, and stop an auth-named one whose body is
  visibly non-enforcing. Out of scope for this addendum.

- **`@api_view(SOME_VAR)` same-file methods resolution.** Upgrade 2 resolves a
  Flask `methods=VAR` kwarg through a same-file literal (`collectMethodsVars` +
  `methodFromLiteral`), but `asApiViewDecorator` deliberately does NOT: an
  `@api_view(METHODS)` list behind a variable stays ALL even when METHODS has a
  same-file literal assignment. Flipping it is a two-line owner-gated change
  (reuse `methodFromLiteral` against the same census); scoped out because the
  approved Upgrade 2 names the `methods=` kwarg only.

- **Poison-census residual: `match`/`case` capture rebinding a `methods=` var.**
  `collectPoisonedMethodsNames` covers augmented/subscript/slice/pattern-unpack/
  `global`/walrus/for-target/`with-as`/mutating-call writes, but a `case`
  capture pattern that rebinds a module-level name used as `methods=VAR`
  (`match x:\n    case [*ALLOWED]:`) is not in the census. Astronomically rare
  (a match capture reusing a route's methods variable name) and only ever
  under-poisons toward a false GET-drop in that one shape; out of scope, safe to
  defer.

- **`context-md.ts` does not surface the auth hedge.** `buildContextMarkdown`
  renders only the neutral aggregate headline (`Auth middleware missing on N of
  M routes`), never the per-route deviator copy or the recommendation, so an
  UNSURE (hedged) route is not named in the committed `.vibedrift/context.md`.
  Safe today because context-md makes no confident per-route claim (see
  `test/unit/output/security-hedge-surfaces.test.ts`); a follow-up could add a
  short "N routes could not be confirmed (hooks: ...)" line so the AI-agent
  context file carries the same hedge the report surfaces do.

- **Landing-page release notes for SCORING_VERSION v10 (cross-repo).** The
  security release bumps `SCORING_VERSION` v9 -> v10 (Express `.all()` + Flask
  `@app.route(methods=[...])` mutating routes now enter the security auth vote,
  so repos with those shapes reflect security_posture drift they always had).
  The one-time scoring-refined notice (`src/core/scoring-notice.ts`) points
  users to `https://vibedrift.ai/releases`, so that page must describe the v10
  change before/at publish. Calibration corpus is byte-identical (no percentile
  regeneration needed). Belongs in `vibedrift-landing-page`, tracked here so the
  CLI publish does not ship a notice pointing at an undocumented change.

- **Gin `.Any()` / Chi `.Method()` routes are not extracted at all.** Task B1
  (2026-07-08, canonical mutating-method classification) fixed the
  vote-exclusion bug for Express `.all()` and Flask `methods=[...]`, but Go's
  `extractGoRoutes` (`src/drift/security-consistency.ts`) never recognizes
  `r.Any(...)` (Gin) or `r.Method(...)` (Chi) as route registrations in the
  first place, so these routes are missing from the route list entirely, not
  just excluded from the mutating-method vote. Separate coverage gap, not a
  vote-exclusion bug.

- **Security floor precision gate only covers `private-key`.** The calibration
  floor-precision gate (`test/calibration/precision-recall.ts`) exercises only the
  `private-key` floor rule because the fixture corpus has no `.go` files, so
  `go-tls-skip-verify`'s false-positive rate is unmeasured (not just under-weighted).
  Add a Go fixture to the calibration corpus so the "floor precision >= 0.95" claim
  covers all five floor rules, not one. (The composite `calibrate:monotonic`
  non-responsiveness at low injection rates is pre-existing and tracked with the
  scoring-formula responsiveness work, not here.)

- **Security suppression: regex-fallback over-suppression on unterminated strings.**
  In `src/drift/security-suppression.ts`, the AST comment-node path is immune, but
  the textual regex fallback's `stripStringLiterals` only blanks CLOSED quote spans.
  An unterminated string containing `// @vibedrift-public` therefore survives and is
  read as a comment, dropping the route from the security denominator (over-suppression
  hides a route). Only reachable in a global no-parser degraded mode (tree-sitter WASM
  fails to init), so low risk. Two fixes: (1) correct the inverted safe-direction code
  comment at `security-suppression.ts:55-58` (it wrongly says under-strip is safe);
  (2) strip an unterminated quote to end-of-line before scanning for a comment marker,
  so the fallback fails to the safe under-match side. Never-over-suppress is the
  dominating invariant.

- **Security Consistency is not at parity across supported languages.** The
  route/auth consistency detector (`extractRoutes`, `security-consistency.ts`)
  covers 3 of the 5 supported languages, at uneven precision, and the AST
  precision upgrade from the Phase 1 wedge is JS/TS-only:
  - **Rust: zero coverage.** There is no Rust route extractor at all — the
    `extractRoutes` dispatch silently skips Rust, so Axum/Actix/Rocket services
    produce no security-consistency signal. (The Phase 1 plan text claiming a
    "regex fallback for Go/Python/Rust" was wrong; no Rust extractor ever
    existed. Corrected in the plan.)
  - **Python/Go: still line-window regex, un-upgraded and unverified.**
    `extractPythonRoutes` / `extractGoRoutes` read auth/validation/rate-limit
    from a ±10–30 line proximity window, not from parsed middleware args, so
    they both false-positive (auth keyword nearby but not applied) and
    false-negate (auth applied via a pattern not in the regex). They did NOT get
    the receiver whitelist, `router.use()` inheritance, or the over-capture fix
    (`cache.get`) the JS/TS AST path got, and were not smoke-tested on the latest
    build (only JS was exercised in the Phase 1 verification).
  Full remediation is drafted as a dedicated phase:
  `PLAN-security-conformance-phase-multilang.md` (port the AST extractor to
  Python + Go, add a first Rust extractor, per-language calibration). Warrants
  its own branch, not a fold into the current work.

- **Mounted-router middleware resolution needs proper module resolution.** The
  Security Consistency detector should resolve `app.use('/api', apiRouter)`
  cross-file so a router-level guard propagates to the mounted routes. A
  basename-matching approach (resolving an import by its last path segment via
  the import graph) is unsafe for a security check: it is directory-blind, so a
  workspace-alias or partially-scanned import (`@shared/router`) plus a single
  generically-named file (`router.ts`) resolves uniquely to an unrelated file
  and silently attributes a guard to routes that are actually unauthed. Do it
  with real relative-path resolution: resolve a relative specifier against the
  importing file's directory to an exact path, refuse bare/aliased specifiers,
  and attribute a guard only on a single exact-path match. Security-critical (a
  false attribution is a missed vulnerability) — design deliberately.

- **Security calibration: exercise the primary dominance vote.** The `security`
  calibration injector strips auth at the shared `INJECT_RATE` (0.34), which puts
  the authed ratio below the 0.75 dominance-vote gate, so calibration only
  measures the uniform-auth-gap fallback. Add a per-injector rate (strip ~1/8) so
  a group lands just above 0.75 with one deviator, calibrating the primary path
  the AST upgrade centers on. (The dominance vote is already unit-tested; this is
  the precision/recall measurement of it.)

- **scan-over-scan diff still tracks the RAW drift representation**: `result.diff`
  / the persisted history digests read `driftResult.driftFindings` (raw), so a
  below-floor route-consistency security finding participates in the drift diff.
  If such a finding is newly introduced between two same-version scans, the
  terminal diff banner (`renderDiffBanner` top-new-drift) could momentarily call
  it a "new drift finding" even though the report body renders it as advisory.
  The same raw-digest diff source also feeds `## Recent trajectory` in
  `src/output/context-md.ts`, so `--write-context` could commit that raw finding
  text into the committed `.vibedrift/context.md` in the same scenario (a more
  durable surface than the ephemeral terminal line).
  This is deliberate for now: the baseline (`assembleBaseline`) and diff track
  the raw representation for continuity. CORRECTION (2026-07-08 audit, issue #34
  item C1): the claim below that the first-scan-after-upgrade case is "already
  silenced by the SCORING_VERSION-mismatch guard" is FALSE — verified against
  source. `diffScans` (`src/output/history-diff.ts`) only gates on
  `previous.schemaVersion`, never on `scoringVersion`; `previousScoresMismatch`
  (the actual guard, set in `scan.ts`) is never read by `diffScans` or
  `src/output/context-md.ts`. A scan taken right after a `SCORING_VERSION` bump
  WILL diff its `compositeScore` against the prior version's and can commit a
  cross-version "Vibe Drift Score delta" into `.vibedrift/context.md`. If we
  want the diff to match the rendered (scored) view, feed `scoredDriftView(...).driftFindings` to
  both the diff digest (buildScanResult) and `saveScanResult` together (keep the
  two sources identical or a spurious per-scan diff reappears).
  Same root cause covers the suppression-audit finding (subCategory
  `SECURITY_SUPPRESSION_SUBCATEGORY`, `security-suppression.ts`): the diff
  digest also reads raw `driftFindings`, so adding or removing a
  `@vibedrift-public` annotation or allowlist entry can show up as a "new" or
  "resolved" drift finding in the diff banner and get committed into
  `.vibedrift/context.md`. The same fix (feed the diff digest source from
  `scoredDriftView(...).driftFindings`) would exclude it too.
- **`watch` renderer shows signed-out copy while authenticated** (v0.14.8): watch
  output includes the "Sign in with `vibedrift login`…" hint and free-tier deep
  tease even on a logged-in session. Fix the auth-state branch in the renderer.
- **Default `--deep` output should surface the AI results inline**: the concise
  deep render shows "AI fix prompts ready" + the dashboard link, but the
  coherence audit, AI-validated findings, and intent-mismatch checks only
  appear with `--format terminal`. Add a short AI summary (coherence grade +
  top finding) to the default deep render.

- **Issue #34 audit findings (2026-07-08). B1-B4 RELEASE BLOCKERS + D2 are
  FIXED on branch `security-blockers-34` (2026-07-08); the items below are
  correctness/polish, NOT release blockers:**
  - **C2 — `computeDriftScores` credits an empty security_posture category
    full health** (`drift/index.ts:115-154`, `categoryHealth([...], ...)`
    returns 1 for an empty array with no "not measured" branch, unlike
    `computeCategoryScore`). Produces `{score:14, maxScore:14, findings:0}`,
    uploaded as-is in `result_json.driftScores` next to the composite's N/A.
  - **C4 — `applyReimplementationConcentrationGate` re-tag never propagates
    out of `computeScores`** (`engine.ts:88-103,732`; re-tags a local copy of
    `findings`, not returned). Same "local copy" bug class already fixed once
    for the security floor (see `scan.ts:405-420`'s comment) but never
    hoisted here — a concentrated reimplementation finding correctly dents the
    score but still renders/labels as hygiene everywhere (CSV/HTML/DOCX/context.md).
  - **C5 — per-file Drift/Static tallies still tag-based, headline is
    kind-based (mismatch)** (`docx.ts:398-399`, `html.ts:285-286` use
    `f.tags?.includes("drift")`; the headline sections
    (`docx.ts:424-427`, `html.ts:827-829`) were fixed to use
    `getAnalyzerKind`). A demoted `security_posture-advisory` finding tallies
    as "Drift" in the per-file table but lists under "Static"/"Hygiene" in the
    headline.
  - **D1 — N/A category card says "No findings in this repo"**
    (`html.ts:462`, `terminal.ts:588`) even when a demoted advisory finding
    exists and its actual message renders further down the same output
    (hygiene section, `html.ts:827-829` / `terminal.ts:512-533`).
  - **D3 — "consistent, not safe" gloss omits rate limiting**
    (`terminal.ts:604`, `html.ts:458` say "auth and validation patterns" only;
    `SECURITY_SUBCATEGORIES` has a third sub-convention, `rateLimit`).
  - **E1 — `allFindings.push(...flooredFindings)` spreads a whole array as
    call args** (`scan.ts:419`, also `:363`) — RangeError risk on very large
    finding sets.
  Full file:line evidence + quotes: see `LOGBOOK.md` "2026-07-08 (later 4)"
  at the workspace root.
