# Changelog

All notable changes to `@vibedrift/cli` are documented here. The format
follows Keep-a-Changelog loosely; breaking-shape changes are called out
explicitly under **Breaking** so CI users can recalibrate.

## [Unreleased]

## 0.15.0 — 2026-07-09

### Fixed

- **Security Consistency now sees catch-all and Flask routes.** Express
  `.all()` routes and Flask `@app.route(..., methods=[...])` routes were
  excluded from the auth-consistency check, so a repo could carry an unauthed
  state-changing route that produced no finding at all. Routes are now
  classified by their real method: a mutating route with no guard is flagged,
  while read-only routes (a bare Flask `@app.route`, which defaults to GET) are
  left alone, so plain GETs never raise a false alarm. The in-loop
  `validate_change` check shares the same route classification as the batch
  scan, so the two can never disagree.
- **`check_file_drift` no longer reports a file as clean when it has an unauthed
  route.** It now reads the per-convention security votes (auth, validation,
  rate limit) instead of a single collapsed slot, so an auth deviation can't
  hide behind a wider convention.
- **The MCP baseline rebuilds itself after an upgrade** instead of serving votes
  computed under an older version. A security convention drawn from too few
  routes to be reliable is now surfaced as advisory rather than stated as
  established.

### Changed

- **Scoring refined (recalibration).** Because the auth check now counts routes
  it previously missed, repos that use Express `.all()` or Flask `methods=[...]`
  routes may see their Vibe Drift Score move to reflect security drift that was
  always present. Saved scores are kept as-is and the new method applies to new
  scans; the CLI shows a one-time notice linking to the release notes. CI users
  gating on `--fail-on-score` for such a repo should re-check their threshold.
  Every other repo is unchanged.

## 0.14.9 — 2026-07-06

### Fixed

- **Fewer false-positive unused exports.** An export used only through a
  destructured dynamic import (`const { thing } = await import("./module.js")`)
  is now recognized as used. Lazy-loaded modules — common in CLIs and
  code-split apps — are no longer flagged as unused, and the files they load are
  no longer counted as orphaned.

## 0.14.8 — 2026-07-01

### Changed

- **Dependency Health is no longer shown as a scored category.** It has no drift
  check yet, so it always read "N/A"; the dependency signals it does have (unused
  / phantom packages) continue to feed the Hygiene score. The Vibe Drift Score
  now shows four drift dimensions.

## 0.14.7 — 2026-07-01

### Added

- **`--inject-context` flag.** Inlines the context summary into `CLAUDE.md`
  inside an idempotent managed block. Pairs with `--write-context` — run both
  together to refresh `.vibedrift/` files and keep the CLAUDE.md block in sync
  in a single pass.

### Fixed

- **Fewer false-positive duplicates.** Recurring test-fixture helpers, and
  functions that merely share a control-flow shape rather than real duplicated
  logic, are no longer flagged as duplicates — so the duplicates you see are the
  ones actually worth consolidating.
- **Clearer messaging for categories with no signal.** Instead of a bare
  "N/A — not scored", a category with nothing to score now says why: Dependency
  Health reads "not yet measured", and every other category reads "no findings
  in this repo".
- **Cleaner scans of repos with vendored code.** File discovery now skips
  vendored and minified files, so bundled third-party code doesn't skew results.

## 0.14.6 — 2026-06-27

### Changed

- **Scoring version updated.** The deep-scan reimplementation change below is
  recorded as a new scoring version. VibeDrift shows a one-time notice linking the
  release notes and suppresses score comparisons across the version boundary, so
  you never see a misleading delta. Existing scores are kept as they were; the new
  scoring applies to new scans.

## 0.14.5 — 2026-06-27

### Changed

- **Concentrated reimplementation now affects the score on deep scans.** When a
  deep scan finds the same logic redundantly reimplemented across many files at
  high density, that now lowers the Vibe Drift Score. Sparse, incidental
  reimplementation stays informational and does not affect the score, so
  well-structured codebases are never penalized for a stray parallel or legacy
  implementation. Local and signed-out scans are unaffected.

## 0.14.4 — 2026-06-26

### Changed

- **Results appear immediately.** A scan now prints the Vibe Drift Score,
  category breakdown, and fix plan as soon as the scan finishes. The slower
  steps — AI fix prompts (Pro) and the dashboard sync — then run behind labeled
  progress indicators instead of a silent wait.
- **Signed-in scans link to your dashboard.** A signed-in scan links straight
  to its project on the dashboard (full report, history, and trends) instead of
  opening a local HTML file.
- **Signed-out scans get the full report.** Running signed out now gives you the
  complete HTML report too, served locally and opened in your browser, instead
  of a summary-only teaser.

## 0.10.0 — 2026-06-18

### Added

- **Tools API (`@vibedrift/cli/tools`).** The five in-loop checks are now a plain
  import as well as an MCP server. Same engine, plain async functions, your code
  stays local. See `docs/tools-api.md`.
- **Agent Skill.** A self-contained skill at `skills/vibedrift/` runs the same
  checks from the command line, so an agent gets drift prevention with or without
  an MCP server.
- **`vibedrift hook`.** Install a git pre-push hook that blocks a push whose Vibe
  Drift Score is below a threshold. Bypass once with `git push --no-verify`.

### Changed

- The tool logic now lives in a transport-neutral core (`src/tools-core`) with the
  MCP server as a thin adapter over it. No behavior change: the MCP tools and their
  results are identical. A guard test keeps the core free of transport imports.

## 0.9.7 — 2026-06-17

### Fixed

- **Startup on some Linux installs.** The published binary's shebang passed a
  flag that not every `env` implementation accepts, which could stop a global
  install from launching. The flag is gone and the CLI starts the same way
  everywhere.

## 0.9.6 — 2026-06-17

### Added

- **`VIBEDRIFT_TELEMETRY_DISABLED` environment variable.** A new env-var opt-out
  for the anonymous usage beacon and the daily npm update check, alongside
  `vibedrift telemetry disable` and `--local-only`. Convenient for CI and
  automation.

### Changed

- **Plain-language telemetry disclosure.** The README, `--help`, and docs now
  state exactly what the anonymous usage beacon sends (language, file count,
  lines of code, scan time, CLI version, finding count, score; no code, no file
  paths, no identifiers) and that it is on by default for every scan, signed in
  or not. Your code never leaves your machine, and you can opt out anytime. The
  beacon also carries an anonymous signed-in/signed-out boolean (no identifier).

## 0.9.5 — 2026-06-14

### Added

- **Lines of code per scan.** Every scan now reports the total lines of code it
  covered. The count rides along on the anonymous beacon and the dashboard scan
  log, so repo size shows up per project for benchmarking — still no code, no
  file paths, no PII.
- **vibedrift.ai link in committed `.vibedrift/` files.** `context.md`,
  `fix-prompts.md`, `fix-plan.md`, and `patterns.json` now carry a link back to
  vibedrift.ai, so a committed context folder points teammates to the tool.

## Earlier releases (pre-open-source)

Versions before 0.9.5 predate the open-source release of the CLI. Their full
changelog lives in the project's git history; it is omitted here because some of
those notes referenced the closed cloud service's internals.
