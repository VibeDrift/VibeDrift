# Changelog

All notable changes to `@vibedrift/cli` are documented here. The format
follows Keep-a-Changelog loosely; breaking-shape changes are called out
explicitly under **Breaking** so CI users can recalibrate.

## 0.9.5 — 2026-06-14

### Added

- **Lines of code per scan.** Every scan now reports the total lines of code it
  covered. The count rides along on the anonymous beacon and the dashboard scan
  log, so repo size shows up per project for benchmarking — still no code, no
  file paths, no PII.
- **vibedrift.ai link in committed `.vibedrift/` files.** `context.md`,
  `fix-prompts.md`, `fix-plan.md`, and `patterns.json` now carry a link back to
  vibedrift.ai, so a committed context folder points teammates to the tool.

## 0.9.1 — 2026-06-08

### Fixed

- **`validate_change` now catches the *first* drift into a fully-consistent
  dimension.** Previously, when a dimension (e.g. async style) was 100% consistent
  across the repo, no drift vote was stored — so `validate_change` had nothing to
  compare a proposed function against and passed it `ok: true`. That meant the single
  most valuable thing to prevent — the first `.then()` introduced into an
  all-`async/await` repo — slipped through. It now falls back to the team's **declared
  convention** (the highest-confidence intent hint from `CLAUDE.md` / `AGENTS.md` /
  `.cursorrules`) as the dominant when no detector vote exists, and cites the
  declaration (e.g. "declared in CLAUDE.md:101") in the fix hint. When declared hints
  conflict, the strongest (highest-confidence) one wins, so a stray mention never
  inverts the rule.

## 0.9.0 — 2026-06-08

### Added

- **MCP deep mode — the full deep scan, in-loop.** `validate_change` and
  `find_similar_function` now accept an opt-in **`deep: true`** that runs the
  cloud deep scan on the single function being checked: CodeRankEmbed
  intent-mismatch detection + Claude-validated semantic duplicates (the same
  engine as `vibedrift . --deep`). The agent catches misleading names and
  semantic clones *before the code lands*.
  - **Local-first stays the default.** The five core tools remain 100% local;
    `deep: true` is the one opt-in exception, sending only the checked function
    to the API.
  - **Shared-pool billing.** A deep check costs **1/50 of a deep scan** (≈50
    in-loop checks per scan) from your existing pool — no separate budget.
    Hourly-rate-capped to bound runaway agent loops.
  - **Never errors the agent.** Out of budget / rate-limited / offline →
    `status: "degraded"` with the local result intact, plus an actionable note.

## 0.8.4 — 2026-06-08

### Changed

- **MCP server is now a Pro feature, invoked as `vibedrift mcp`.** Two fixes to
  the 0.8.3 MCP launch:
  - **Install command:** the server is now a subcommand of the single
    `vibedrift` bin, so the reliable install is
    `claude mcp add vibedrift -- npx -y @vibedrift/cli mcp`
    (the separate `vibedrift-mcp` bin from 0.8.3 didn't resolve cleanly through
    `npx`). For Cursor, use `args: ["-y", "@vibedrift/cli", "mcp"]`.
  - **Entitlement:** the MCP tools require a **Pro or Team** plan. Sign in with
    `vibedrift login`; free / signed-out users get an `upgrade_required` prompt
    instead of results. The tools still run entirely locally — your code never
    leaves your machine; only your plan is read from the local login.

## 0.8.3 — 2026-06-08

### Added

- **MCP server — use VibeDrift inside your AI coding agent.** A new local,
  stdio MCP server (`vibedrift-mcp`) lets Claude Code / Cursor consult your
  repo's own conventions **while it writes code**, turning drift detection into
  drift prevention. Five tools: `get_intent_hints`, `get_dominant_pattern`,
  `check_file_drift`, `find_similar_function`, `validate_change`. Local-only —
  no network, no login. Install with
  `claude mcp add vibedrift -- npx -y @vibedrift/cli vibedrift-mcp`, then run
  `vibedrift .` once to build the baseline. See the README "MCP server" section.
- Each `vibedrift` scan now writes a small cached **drift baseline** to
  `~/.vibedrift/baseline-cache/` so the MCP server answers each call in under
  half a second. Tied to the existing cache toggle; skip it with `--no-cache`.

## 0.8.2 — 2026-06-08

### Fixed

- **Deep scan now actually runs Claude validation on borderline findings.**
  The `--deep` tier is supposed to have Claude confirm or reject the ambiguous
  ML findings (possible-duplicate, possible name/behavior mismatch) before they
  reach you. That path had been dead — those medium-confidence findings were
  discarded without ever being validated. They're now validated server-side in
  a single batched call: confirmed findings get promoted into your report,
  false positives are dropped (with a recorded reason), and uncertain ones are
  left out. The result is fewer noisy `--deep` findings and higher-trust ones.
  **This shipped server-side — existing installs already benefit; upgrading is
  not required to get it.**

### Internal

- Removed the dead client-side LLM-validation payload builder and corrected the
  `--deep --verbose` summary line, which previously claimed findings were "sent
  to LLM" from the client (validation runs server-side). No change to scan
  output, scoring, or any flag.

## 0.8.1 — 2026-06-08

### Docs

- **README refreshed for 0.8.0.** The example output and Scoring section now
  show the /100 scale (was a stale `54/80`), the full set of cross-file drift
  signals the score counts, the silent score migration, and deterministic
  output. No code changes from 0.8.0.

## 0.8.0 — 2026-06-08

### Breaking

- **The Vibe Drift Score now counts all 14 cross-file drift detectors.**
  Previously the headline composite was driven by only a subset of them;
  semantic duplication, naming/convention, async, import, export, and
  phantom-scaffolding drift now contribute. On a drifted repo the score
  comes out lower and more discerning — the measurement got sharper.
  - **CI:** if you gate on `--fail-on-score`, re-baseline once. Run a
    scan to read your new number, then set the threshold from it.
- **One scoring engine.** The drift composite and the per-category
  breakdown rendered in the HTML/cloud report are now produced by a
  single scoring path, so the headline and the breakdown can no longer
  disagree.

### New

- **Silent score migration.** When scoring math changes between releases,
  past scores are re-aligned to the current scale on read (locally and on
  the dashboard) so deltas always compare like-with-like. A one-time
  "scoring refined" notice links the release notes — no per-scan version
  banner, no internal version strings shown to users.

### Fixed

- **Deterministic output.** File discovery is now sorted (code-unit, not
  locale-dependent) and number formatting is locale-independent, so the
  same commit produces a byte-identical report and names the same
  "worst drifting file" on every machine and in CI.
- **Intent-hint laundering.** A convention declared in `CLAUDE.md` /
  `AGENTS.md` that the codebase has NOT actually converged on is now
  flagged as divergence instead of recorded as agreement. (A declaration
  that flipped a close/tied vote used to silence the warning.)
- **Deep-scan candidate selection.** `--deep` now routes ambiguous
  near-duplicate function pairs — the cases an LLM judge actually
  resolves — to deep analysis, instead of only sampling the largest
  entry-point-named files.

### Internal

- Scan results carry a scoring-version tag so trend lines stay
  comparable as the scoring model evolves; previously stored scores are
  re-aligned by version on the server.

## 0.7.0 — 2026-04-29

### Breaking

- **Vibe Drift Score is now displayed out of 100, not 80.** The
  internal scoring math is unchanged (4 applicable drift categories ×
  20 = 80 raw points), but the headline composite is normalized to a
  /100 scale at the engine boundary so users don't have to track two
  different denominators. Hygiene was already /100. Grades are
  computed from the percentage so they come out identical to prior
  versions.
  - **CI:** if you gated on `--fail-on-score`, recalibrate. A
    threshold of 60 against the old /80 scale now corresponds to 75
    against /100. Same scan, same grade, same fix priority — just
    update the threshold by `× 1.25`.
  - **JSON output:** `score.composite` and `score.max` now reflect
    the /100 form. Old scans uploaded by 0.6.x CLIs continue to
    render correctly on the dashboard via a read-side normalization.
- **`result_json.perFileScores` shape changed.** Each entry no longer
  includes the full `findings: Finding[]` array (which fan-out
  duplicated the top-level findings, exploding the upload payload on
  registry-style codebases). Entries now ship a summary
  `{ file, score, maxScore, findingCount, weight, severities }` and
  the dashboard joins against the top-level `findings[]` for detail
  views. Saves 50%+ of upload size on large monorepos.

### Fixed

- **Upload failures are now visible by default.** Previously, when the
  CLI couldn't log a scan to the dashboard, the failure was swallowed
  unless you ran with `--verbose`. Now a clear yellow `⚠ Couldn't
  upload scan to dashboard: <reason>` line appears at the end of the
  scan, with payload size and HTTP status when relevant. Local report
  is unaffected.
- **`/v1/scans/log` 413 errors on large repos.** The 3,500-file
  shadcn-ui scan was producing a result_json payload too big to upload
  (the original 10MB cap rejected it). The CLI now applies progressive
  client-side trimming when the serialized payload exceeds 9 MB,
  stripping the heaviest fields in priority order
  (codeDnaResult.functions → finding snippets → deviating-files cap →
  perFileScores filter → raw files list) until it fits. The trim
  emits a one-line `ⓘ Result trimmed for upload: 39MB → 8MB` notice
  so users know what happened. Scoring is unaffected.
- **Upload timeout bumped from 20s to 60s.** A legit 7-MB upload on a
  cold Fly machine could exceed the old 20s, producing an `aborted`
  error on scans that should have succeeded. 60s covers the p99 of
  real-world cases.
- **`codedna-fingerprint` finding payload capped.** A duplicate group
  of 60+ functions (e.g. shadcn-ui's `PickerShortcut/Command-` family
  spanning 61 files) used to produce a single 30–40 KB finding with
  the entire member list inline. The finding now caps the message
  name list to 10 + "(+N more)" and the locations to the top 20, with
  a `metadata.truncatedLocations` total so the dashboard can label
  "showing 20 of 61." Scoring is unaffected — the finding still has
  one severity × confidence regardless of group size.

### Internal

- 5 new unit tests for `fingerprintFindings` payload caps:
  small-group passthrough, name-message truncation, location cap,
  scoring-input invariance, and a regression guard pinning a
  200-member group's serialized finding under 4 KB.
- Total suite: **287 tests, 43 files**.

---

## 0.6.4 — 2026-04-20

### New

- **Implementation-gap detector.** New hygiene analyzer that flags
  functions whose bodies are placeholder returns — `return "unvalidated"`,
  `return "not implemented"`, `verdict="stub"`, `raise NotImplementedError`,
  `unimplemented!()`, `panic("not implemented")`. Catches the exact
  pattern that slipped through in the 0.6.3 API-side fix
  (`/v1/analyze` returned `"verdict": "unvalidated"` in production for
  months). Registered under Intent Clarity, hygiene-kind so it shows up
  in the Hygiene pane and doesn't contaminate the drift score.
- **TODO-density adjacent-stub escalation.** When a `TODO` / `FIXME`
  sits within 5 lines of a placeholder return, a `NotImplementedError`,
  or similar language-level "not done" marker, the finding now surfaces
  as a WARNING (or ERROR for ≥3 occurrences) instead of a buried INFO
  summary. One TODO next to a `"unvalidated"` return is orders of
  magnitude more actionable than 10 scattered TODOs in a messy module,
  and the severity now reflects that.

### Why

After a production stub went undetected for months, an audit found
the hygiene layer was flagging adjacent signals (unreachable code +
TODO density) but the signals were either too-low-severity or didn't
exist as detectors. These two changes ensure a stub-shaped commit
will surface visibly on the next scan.

### Tests

- 12 new unit tests for `implementation-gap` covering: exact-phrase
  return literals, NotImplementedError in Python, throw-new-Error
  in JS/TS, Rust `unimplemented!()`, Go `panic("not implemented")`,
  kwargs vs dict-value syntax in Python, whole-word matching rules.
- Regression fixture reproducing the original `/v1/analyze` stub —
  the fixture now fires two hygiene findings (placeholder-return +
  adjacent-stub TODO) instead of silently passing.

---

## 0.6.3 — 2026-04-19

### Fixed

- **`--write-context` now requires `vibedrift login`.** Same rationale
  as the 0.6.2 watch-mode gate: the `.vibedrift/` files written by
  the flag (context.md, fix-plan.md, fix-prompts.md, patterns.json)
  carry the full finding surface — the same content a signed-in user
  gets in the HTML report. An unsigned user running
  `vibedrift . --write-context` would otherwise get the full premium
  surface without ever signing up. Now the scan errors out upfront
  with a clear login hint; signed-in users see zero change.

### Improved

- **AI agent context pipeline positioning.** The `.vibedrift/`
  context files + watch-mode loop are now the featured path on
  vibedrift.ai for AI coding integration. This release codifies that:
  `--write-context` is the single-shot form, `vibedrift watch` is
  the continuous form. Both behind the same (free) account gate.

---

## 0.6.2 — 2026-04-19

### Fixed

- **Watch mode now requires `vibedrift login`.** `vibedrift watch`
  (shipped in 0.6.0) ran without any auth check. Because it writes
  full findings to `.vibedrift/context.md`, `fix-plan.md`, and
  `fix-prompts.md` on every file change, that was effectively a
  backdoor around the free-account gate used by the one-shot scan.
  Watch now verifies a local token exists before starting the
  watcher and prints a clear `vibedrift login` prompt when it
  doesn't. Existing logged-in users see no change.

---

## 0.6.1 — 2026-04-19

### New

- **Passive update nudge.** Every scan now checks the npm registry
  once per 24 hours (cached at `~/.vibedrift/version-check.json`).
  When a newer `@vibedrift/cli` is available, a dim one-liner at the
  end of the scan output points you at `vibedrift update`. Non-
  interruptive — never blocks or delays the scan. Matching footer in
  the HTML report.
- Honors the same network gate as the scan beacon: `--local-only`
  skips the check entirely, and `vibedrift telemetry disable` opts
  out. Offline users and telemetry-off users see nothing.

### Why

VibeDrift ships often in its early stages; each release sharpens
detectors and ships fixes. Users stuck on an older version miss
accuracy improvements that change how the tool reads their code.
The nudge is a quiet "hey, there's a better version available" — no
more than that.

---

## 0.6.0 — 2026-04-19

### Breaking

- **Vibe Drift Score is now drift-only (max 80).** Previously the
  0–100 composite mixed drift signals (dominance-voted detectors, Code
  DNA, ML) with generic-hygiene signals (complexity, dead code, TODOs,
  OWASP regex, outdated deps, empty catches, language idioms). Generic
  hygiene findings now feed a **separate `Hygiene Score` (max 100)**
  that renders alongside but does NOT affect the drift composite.
  - **CI:** if you gate on `--fail-on-score`, recalibrate. A repo at
    80/100 on the old composite may now be ~65/80 on drift alone.
  - **JSON output** adds `hygieneScores`, `hygieneScore`,
    `maxHygieneScore` fields. `scores`, `compositeScore`, and
    `maxCompositeScore` now reflect drift-only values.
  - **Scan history:** schema bumped to v3. The diff banner silently
    ignores pre-v3 scans to avoid spurious "score went up" deltas
    caused by the semantic change.

### New

- **`vibedrift watch [path]`** — debounced file watcher. Refreshes
  `.vibedrift/context.md` / `fix-plan.md` / `patterns.json` on every
  change so AI coding agents always see up-to-date peer context. Zero
  network calls. `--interval <seconds>` (default 10, min 2, max 600),
  `--include`, `--exclude`, `--verbose`. Falls back to polling mode on
  Linux if recursive `fs.watch` is unavailable.
- **Scan-over-scan diff banner.** Every scan now compares to the
  previous one and shows `✓ Resolved: N / ✗ New: N / ▲▼ Score delta`.
  New flags: `--compare` (on by default when history exists),
  `--no-compare`, `--since <scanId>` to diff against a specific saved
  scan. Stable finding keys survive ±3-line edits via bucketing +
  message normalization.
- **Commit-archaeology detector.** Flags files whose git history shape
  (single-author, single 6-hour session, tight commit cadence)
  deviates from the directory's norm — a real AI-generated-code
  signal that no linter has access to. Silent on repos with <10 files
  of git history or where >40% of the repo is uniformly bursty.
- **Declared-conventions banner.** When the scan root contains a
  `CLAUDE.md`, `AGENTS.md`, `AGENT.md`, `.cursorrules`, or
  `.claude/instructions.md`, VibeDrift prints the detected
  declarations in the header:
  ```
  📘 Declared conventions (from CLAUDE.md)
     repository pattern · named exports · async/await
  ```
  These seed the dominance vote for **9** drift detectors (previously
  only 1 consumed hints).
- **Finding-specific deep-scan teaser.** Replaces the generic
  "run --deep for AI analysis" copy with concrete named candidates:
  - Near-duplicate function pairs (Code DNA LCS similarity 0.5–0.85)
    with cross-file examples
  - Functions with opaque names (`handle`, `process`, `run`, …) —
    intent-mismatch candidates for deep scan's UniXcoder check
  - Files flagged as internally-inconsistent patterns

### Improved

- **4 new intent-hint categories** in the parser:
  `logging_consistency`, `state_management_consistency`,
  `test_structure_consistency`, plus canonical values for
  `return_shape_consistency`. Example: declaring "use winston for
  structured logging" in `CLAUDE.md` now flags `console.log` files as
  divergent.
- **Git metadata** now collects `singleSession`, `initialAuthorEmail`,
  `authorDiversity` (Shannon entropy of commit-count-by-author), and
  `medianCommitIntervalHours`. Same single-pass `git log` call; no
  extra cost. Feeds commit archaeology.
- **Per-finding consistency impact** is now drift-only. Fix Plan
  prioritization is unaffected by hygiene findings.

### Internal

- **78 new unit tests** across drift detectors, Code DNA, diff
  engine, intent-hint seeding. Total suite: **254 tests, 41 files**.
- **MinHash property test** — estimate stays within
  `3 · 1/(2√k)` of true Jaccard across 100 random pairs.
- **FNV + SHA-256 two-pass fingerprint** verified on 1000 unique
  synthetic bodies — zero false-positive groupings.
- **Algorithm docs** pinned with unit tests for every edge case
  (empty bodies, template literals, nested comments, Go `var :=`,
  Python hash comments, collision rate).

### Fixed

- `state-management-consistency` silently called `pickIntentHint` with
  a category the parser didn't emit — the hint was never applied.
  Both sides of that contract are wired now.
- Terminal score label previously read `Hygiene (separate):` which
  scanned as a malformed phrase. Now `Hygiene Score:` with a one-line
  gloss underneath explaining what each scalar measures.
- History delta comparisons across schema versions are now skipped
  silently rather than producing misleading "score improved" banners
  after an upgrade.

---

## Prior releases

0.5.x and earlier history was tracked inline in git commits. See
`git log --oneline` for pre-0.6.0 details.
