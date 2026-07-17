# CLI backlog

- **Import-style drift is JS/TS only ([#56](https://github.com/VibeDrift/VibeDrift/issues/56)).** No import
  convention check for Python, Go, or Rust (`imports` analyzer and the `import-consistency` detector are both
  JS/TS-gated). Other languages get import parsing only for dependency/dead-code, not a style signal. Candidate
  analyzer, tracked in the issue.

- **`test/calibration/README.md` drift.** Sample output shows a "≥5pt" monotonic drop (the gate in
  `run.ts` is 3.0) and a "drop a generator in `generators/`" section references a directory that
  does not exist (injectors live in `injectors.ts`).
- **Rust auth recall gaps (all fail-safe — a miss, never a false-bless).** From
  the real-repo spot check: (1) a `MethodRouter::route_layer(...)` nested inside
  `arg1` of `.route(path, mr)` is invisible to the ancestor-layer coverage walk,
  so a genuinely-protected Axum route gets neither bless nor hedge; (2)
  parenthesized/macro-wrapped rejects (`return (Err(FORBIDDEN))`, `forbidden!()`)
  don't bless because `rustProducesReject` has no `parenthesized_expression` /
  `macro_invocation` case (symmetric across 401/403 — fix both at once); (3) an
  Actix `ErrorForbidden(..)` ctor isn't recognized for the guarded-403 lane.
- **Rust v1.1: in-file `FromRequest`/`FromRequestParts` impl bless.** Today an
  extractor-typed param resolves to `unsure`; reading the impl body to verify a
  reject would let it bless. Same idea for multi-statement middleware bodies
  (e.g. Echo `JWTWithConfig`, Go) and cross-function group wiring.
- **Cross-file resolution extensions.** Python absolute imports; multi-module Go
  (multiple `go.mod`). Current resolver is single-module / relative-import only.
- **Minor cross-language hedge asymmetry.** A Python hook with an opaque body and
  a NON-auth-flavored name resolves `unsure`; Go/Rust resolve the same shape
  `not-auth`. Both are safe (never a bless). Decide whether to align Python to
  `not-auth` for uniformity, or keep the more cautious hedge.
- **Optional: language-aware hedge noun.** The auth "double check" hedge now says
  a neutral "an auth hook (X)" for all languages (was the Flask-specific "a
  before_request hook"). A nicety would be language-specific nouns (Python
  "before_request hook / dependency", Go "middleware", Rust "extractor / layer"),
  which needs threading the finding's language into `hedgeRecommendationSuffix`
  and the terminal read-back regex in lockstep. Low priority.
- **No per-call logging in the MCP server (tool calls are invisible).** The stdio
  server (`src/mcp/server.ts`) only writes startup (`vibedrift-mcp running on
  stdio`), a one-time baseline-index line, and `Fatal:` to stderr — never a line
  per tool call. So there is no way to watch which in-loop tools fire, when, or
  with what outcome. Add an env-gated per-call stderr log (e.g.
  `VIBEDRIFT_MCP_LOG=1`): tool name, repo, and a one-word result
  (`fits` / `ok` / `no_baseline` / …). Because MCP clients capture server stderr
  into their logs (Claude Code: `mcp-logs-<server>/*.jsonl`; also streamed by
  `claude --debug`), this makes tool usage `tail -f`-able without touching the
  JSON-RPC channel on stdout. Parked.

- **No first-class "MCP is active / being used" signal.** After enabling the
  server a user cannot tell it is doing anything: the tools are pull-based (they
  fire only when the agent chooses to call them), `/mcp` shows "connected" but not
  "used", and the `indexing … for the first time` line fires once per repo per
  session, not per call. Consider a lightweight liveness/usage signal (pairs with
  the per-call log above) so "connected" is distinguishable from "actually
  invoked." Parked.

- **Terminal hedge detection is a prose-regex.** The terminal decides a security
  finding is hedged by testing its recommendation text with `/Double check/`
  (`src/output/terminal.ts`), which is brittle copy coupling: a wording change to
  the hedge sentence silently drops the hedge from the terminal. A dedicated
  finding-metadata flag (a boolean the renderers read instead of the prose) would
  be more robust. Parked.

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
  the raw representation for continuity. (The CROSS-VERSION case is FIXED as of
  2026-07-16: `diffScans` now takes the current scan's `scoringVersion` and
  refuses comparison when the pair spans versions — `versionMismatch: true`
  zeroes deltas, empties the resolved set, and both the terminal banner and the
  committed `context.md` trajectory stay silent, `--since` included. What
  remains here is the SAME-VERSION raw-vs-rendered concern only.) If we
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
