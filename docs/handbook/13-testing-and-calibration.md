# Testing, Calibration, and CI

A drift detector has two failure modes a normal unit test cannot see: it can be wrong about real code (precision and recall), and it can be numerically unresponsive (drift rises but the score barely moves). The test suite is therefore layered: conventional unit and integration tests for behavior, a calibration harness with enforced accuracy gates for detector quality, and a manual eval harness for the expensive questions. This chapter maps the layers and ends with the workflow a contributor should follow to prove a detector change is safe.

## Test suite layout

The runner is vitest; `vitest.config.ts` includes every `test/**/*.test.ts`, so `npm test` runs the unit tests, the integration tests, and the calibration-directory test files in one pass.

```text
test/
  unit/           mirrors src/: analyzers, auth, calibration, cli, codedna,
                  core, drift, intent, mcp, ml-client, output, scoring,
                  telemetry, tools, tools-core, utils
  integration/    drift.test.ts, intent-hints.test.ts, mcp.test.ts,
                  scan.test.ts, temporal-pivot.test.ts
  calibration/    the harnesses (below) + security-{python,go,rust}.test.ts
  eval/           unit tests for the eval harness (fixtures, measure,
                  orchestrate, runners, stats)
  fixtures/       seven small end-to-end repos
  helpers/        drift-tree.ts (shared fixture-tree builder)
```

The fixture repos are `clean-project`, `messy-project` (empty catch blocks, a TODO cluster, CJS/ESM mixing, duplicate fetchers, env-var drift), `drift-project` (handlers, services, and repositories with injected convention splits), `empty-project`, and one each for `go-project`, `python-project`, `rust-project`. Integration tests scan these end to end; `test/integration/mcp.test.ts` spawns the actual stdio server binary.

Some tests are guard tests for architectural invariants rather than behavior: `test/unit/tools-core/no-mcp-coupling.test.ts` fails if `src/tools-core/` ever imports the MCP SDK, and the floor-badge suite pins that a security-floor trip never changes the grade.

## The calibration harness

`test/calibration/` (see its README) holds two harnesses that run over a synthetic labeled corpus: drift is injected into a uniform generated baseline, so ground truth is exact and mechanical, with no human labeling.

### npm run calibrate: the accuracy harness

`test/calibration/precision-recall.ts` generates the uniform baseline (`baseline.ts`), applies one injector at a time (`injectors.ts`), derives ground-truth labels by diffing which files were mutated, scans, and reports precision, recall, and F1 per detector against that ground truth. `INJECTOR_CATEGORY` maps each injector to the category expected to catch it: naming to `naming_conventions`, architectural and error-handling to `architectural_consistency`, security to `security_posture`, and the floor injector to the `security-floor` analyzer. `INJECT_RATE = 0.34` mutates roughly 2 of every 6 eligible files: a clear minority, so the injected drift is unambiguous against the dominant pattern.

> [!IMPORTANT]
> One row is an enforced gate, not a report: the `security-floor` row must hold precision at or above `FLOOR_PRECISION_GATE = 0.95` or the run fails. The floor badge tells a user "fix before shipping", and that copy is only defensible if a floor trip is almost never a false alarm.

Results land in `test/calibration/reports/latest.json`. The README calls these per-category rows "trend rows": they are compared across runs to catch accuracy regressions, which makes the file the before/after artifact for any detector change. Categories that fire on the templated baseline's own structure (`semantic_duplication`, dead code, `phantom_scaffolding`; the near-identical, consumer-less generated handlers legitimately trip them) are reported separately as un-measured rather than pretending the synthetic corpus can score them. The README also records a known finding from the first baseline honestly: `naming_conventions` scores F1 1.00, but `architectural_consistency` recall is 0.00 on the synthetic corpus, flagged for follow-up rather than hidden.

### npm run calibrate:monotonic: the responsiveness gate

`test/calibration/run.ts` generates the baseline, injects drift at rates 0, 10, 25, 50, 75, and 90 percent, and pushes each variant through the real pipeline: context building, parsing, analyzers, drift detectors, and `computeScores`, not a mock of any stage. It then asserts two properties and exits 1 on violation:

- **Monotonicity**: the composite score never rises as injection increases (tolerance 0.5 points).
- **Responsiveness**: each 25-percentage-point injection step, 25 to 50 and 50 to 75, must drop the composite by at least `REQUIRED_DROP_PER_25PCT = 3.0` points.

The README is candid that this is the weaker of the two harnesses (almost any threshold choice passes a monotonicity check), which is why it is kept as a pre-publish smoke test while the precision/recall harness is the accuracy authority. It exists to catch scoring regressions of the shape "one category silently dominates another", which shipped once before this gate existed.

## The S0-S11 security fixture families

The per-language AST security extractors (`src/drift/security-ast-python.ts`, `-go.ts`, `-rust.ts`) get their own enforced precision/recall gates: `security-python.test.ts`, `security-go.test.ts`, and `security-rust.test.ts` in `test/calibration/`, each with a fixture generator. These run on every `npm test`, not just in a manual calibration pass, because auth-detection regressions are the most expensive kind to ship.

Each language covers a scenario grid, with per-language differences: Python covers S0 through S11; Go covers S0 through S8 plus the cross-file S10/S11 (it has no S9); Rust covers S0 through S8 plus its own Rust-specific S9, a guarded-403 produce-gate scenario, and has no cross-file S10/S11 yet. Each scenario computes precision and recall explicitly against planted ground truth:

| Scenario family | What it pins |
|---|---|
| S0 | Recognition self-check: every planted route is counted before anything else, so a recall regression fails with a count instead of silently vanishing from a vote several layers down |
| S1, S2 | The primary dominance vote: one planted deviator among an authed majority, precision and recall 1.0 |
| S3 | The uniform-auth-gap fallback: all routes stripped at once, the primary vote goes silent, the gap must fire |
| S4 | Negative control with non-vacuity: route extraction is asserted before zero-findings, because silence only proves something once the routes were actually seen |
| S5 | Uniformly-authed control: zero findings on every axis |
| S6-S8 | Body-signature collisions: an auth-sounding hook that merely emails must not bless routes; a boring-named hook that really authenticates must |
| S9 (Python: the methods-variable pattern resolving correctly; Rust: the guarded-403 produce-gate) | Language-specific resolution mechanics |
| S10 (Python, Go) | Cross-file positive: route files importing an auth hook defined in another in-repo file resolve it and bless the routes |
| S11 (Python, Go) | Cross-file negative: the same routes importing the hook from outside the repo stay hedged, never silently blessed |

S10 and S11 encode the hedging contract described in the MCP and output chapters: an auth mechanism the scanner can actually resolve inside the repo may confidently bless routes; one it cannot see stays a hedged "double check" finding. Rust additionally contributes an isolated `security_posture_rust` trend row to `npm run calibrate` (first-run precision 1.00, recall 1.00). Language-specific rows are deliberately kept separate, never merged into the shared baseline row, so a Rust regression cannot hide inside a blended average.

## The eval/ harness

`eval/` holds the expensive, non-deterministic experiments that do not belong in CI:

- **`npm run eval`** (`eval/run.ts`): the drift-delta eval. It is manual and metered: it needs an `ANTHROPIC_API_KEY` and runs real agent tasks over `eval/fixtures/repos`, comparing arms in which the agent gets nothing, gets the generated context file, or gets the MCP tools (whose baselines are pre-built for that arm). `EVAL_TRIALS` defaults to 3. It writes timestamped reports to `eval/reports/`; a positive delta means the agent with VibeDrift introduced less drift than the control.
- **`eval/discrimination/run.mjs`**: the score-discrimination harness. It shallow-clones the repos listed in `repos.json`, runs the actual built CLI with `--local-only --json`, and prints a score-sorted table with clean-versus-messy separation and per-repo top analyzers. It measures only and changes nothing; use it when a scoring change should widen (or must not narrow) the separation between known-clean and known-messy repos.
- **`eval/recall/`**: stored artifacts (bands, functions, pairs, verdicts) from reimplementation-recall audits, kept so the audits are reproducible.
- **`eval/context-token-benchmark/`**: a pre-registered A/B harness with its own package.json and PRE-REGISTRATION.md.

## CI workflows

`.github/workflows/ci.yml` runs three jobs on pushes to main and on pull requests:

- **build-and-test**: a Node 20.x and 22.x matrix running `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`. Everything enumerated above under `npm test`, security grids included, gates every PR on both Node lines.
- **drift-scan**: dogfooding. CI builds the CLI and scans this repository with it (`node dist/cli/index.js . --local-only --no-cache --format terminal`). The run is currently informational: the `--fail-on-score` threshold is disabled, with an in-file comment explaining that a scoring-version change moved the self-score below the old floor and the gate stays off until recalibration sets a new one. The scan output remains visible in the logs. Note the `--local-only`: CI performs no network calls.
- **secret-scan**: gitleaks (pinned version) over the pushed ref's own history. The `--log-opts="HEAD"` scoping is deliberate and documented in the workflow: without it, a full-depth checkout would scan every branch, and an unrelated branch's extracted OSS test fixture (a template private-key block holding no real key) could fail main's build. Each branch is still scanned by its own PR run.

`discord-release.yml` is release plumbing, not a gate: it posts the release notes to Discord when a GitHub Release is published. The npm side has its own belt: `prepublishOnly` reruns lint, typecheck, test, and build, so a broken package cannot be published even manually.

## Proving a detector change is safe

The workflow that follows from these layers, for anyone modifying a detector, classifier, or scoring path:

1. **Write or update the unit tests first.** Every detector has a suite under `test/unit/drift/` or `test/unit/analyzers/`; a behavior change without a test change is a red flag in review.
2. **Run `npm test`.** This already includes the S0-S11 security grids, the guard tests, and the integration scans of the fixture repos.
3. **Run `npm run calibrate` and diff the trend rows** in `test/calibration/reports/latest.json` against the previous run. Precision or recall dropping on a category you did not intend to touch is the regression signal this harness exists to catch. The security-floor precision gate must hold at 0.95 or the run fails on its own.
4. **Run `npm run calibrate:monotonic`** if the change touches scoring or finding weights: the composite must still fall at least 3 points per 25% injected drift.
5. **For changes that could shift real-repo scores**, run the discrimination harness and check that clean/messy separation did not narrow.
6. If the change alters documented behavior, fix the affected handbook chapter in the same PR.

If a detector change is accurate on the synthetic corpus, holds the security gates, keeps the score responsive, and does not compress real-repo separation, it is as proven as local tooling can make it; CI then re-checks the first two on both supported Node versions.
