# CLI backlog

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

- **AST route middleware: unpack array-literal middleware.** `middlewareNames`
  in `src/drift/security-ast.ts` doesn't unpack `router.post("/x", [requireAuth],
  handler)` (middleware passed as an array), so a genuinely-authed route reads as
  an unauthed deviator. Safe direction (over-flags, never falsely blesses) and
  narrow, but a ~3-line fix: when a middleware arg is an `array` node, recurse
  over its `namedChildren`.

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
  the raw representation for continuity, and the first-scan-after-upgrade case is
  already silenced by the SCORING_VERSION-mismatch guard. If we want the diff to
  match the rendered (scored) view, feed `scoredDriftView(...).driftFindings` to
  both the diff digest (buildScanResult) and `saveScanResult` together (keep the
  two sources identical or a spurious per-scan diff reappears).
- **`watch` renderer shows signed-out copy while authenticated** (v0.14.8): watch
  output includes the "Sign in with `vibedrift login`…" hint and free-tier deep
  tease even on a logged-in session. Fix the auth-state branch in the renderer.
- **Default `--deep` output should surface the AI results inline**: the concise
  deep render shows "AI fix prompts ready" + the dashboard link, but the
  coherence audit, AI-validated findings, and intent-mismatch checks only
  appear with `--format terminal`. Add a short AI summary (coherence grade +
  top finding) to the default deep render.
