# Extending VibeDrift

This chapter is recipes: the exact files to touch, in order, for the four most common extensions. One rule governs all of them, and it comes from `CONTRIBUTING.md`: a new signal must be grounded in a baseline it deviates from (a dominance vote, a similarity measure, a taint flow). A raw heuristic with no peer group can still ship, but it is hygiene-kind by definition and will never move the Vibe Drift Score. Decide which side of that line your idea is on before writing code.

## Recipe 1: add a static analyzer

A static analyzer examines files independently and returns findings. The contract is small:

```ts
// src/analyzers/base.ts
export interface Analyzer {
  id: string;
  name: string;
  category: ScoringCategory;
  requiresAST: boolean;
  applicableLanguages: SupportedLanguage[] | "all";
  version?: number; // bump when logic changes; part of the cache key
  analyze(ctx: AnalysisContext): Promise<Finding[]>;
}
```

1. Create `src/analyzers/<id>.ts` implementing `Analyzer`. Use `file.tree` (a tree-sitter tree) when it exists and fall back to regex when it does not: parsing failures return an absent tree rather than aborting, and every shipped analyzer degrades gracefully (see `naming.ts` or `complexity.ts` for the pattern).
2. Register it in `createAnalyzerRegistry()` in `src/analyzers/index.ts`. Position matters: findings are reassembled in registry declaration order after the analyzers run concurrently, so the registry order is part of the deterministic-output contract.
3. Register the analyzer id in `CATEGORY_CONFIG` in `src/scoring/categories.ts`, choosing the scoring bucket (`architecturalConsistency`, `redundancy`, `dependencyHealth`, `securityPosture`, `intentClarity`) and the `kind`.
4. Emit findings in the house shape (`src/core/types.ts`): `analyzerId`, `severity` (`info` | `warning` | `error`), `confidence` (0 to 1), `message`, `locations`, `tags`. Aggregate: shipped analyzers emit one rolled-up finding per phenomenon (often per directory or per project) with locations as evidence, and cap runaway lists the way `complexity.ts` caps its per-tier findings. A finding per offending line drowns the report.
5. Bump `version` whenever you change the logic. It feeds the findings-cache key (`src/core/findings-cache.ts`), so a bump invalidates stale cached output; forgetting it means users with warm caches keep seeing the old findings.
6. Add `test/unit/analyzers/<id>.test.ts` (vitest, `describe`/`it`). For end-to-end coverage, the small fixture repos under `test/fixtures/` (`clean-project`, `messy-project`, per-language projects) are scanned by the integration suite; extend one if your analyzer needs a realistic corpus.
7. Run the gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

> [!WARNING]
> Unregistered analyzer ids silently default to hygiene (`getAnalyzerKind` in `src/scoring/categories.ts`). That default is deliberate, so an unknown id can never contaminate the drift composite, but it means step 3 is not optional if you intend the analyzer to be drift-kind.

## Recipe 2: add a cross-file drift detector

Detectors live one level up from analyzers: they see all files at once and vote.

```ts
// src/drift/types.ts
export interface DriftDetector {
  id: string;
  name: string;
  category: DriftCategory;
  detect(ctx: DriftContext): DriftFinding[];
}
```

1. Create `src/drift/<name>.ts` implementing `DriftDetector`. Its `DriftFinding`s must carry the vote arithmetic: `dominantPattern`, `dominantCount`, `totalRelevantFiles`, `consistencyScore` (dominant/total × 100), `deviatingFiles` with line-level evidence, and ideally `dominantFiles` (up to 3 exemplars, which power fix prompts and the MCP tools' fix hints).
2. Add the new category to the `DriftCategory` union and to `DRIFT_WEIGHTS` in `src/drift/types.ts`. `DRIFT_WEIGHTS` is typed `Record<DriftCategory, number>`, so the compiler forces the entry; note the weight is the report bar's max score, not a composite weight.
3. Register the detector in `createDriftDetectors()` in `src/drift/index.ts`, and add the category to the `DriftScores` interface and the category list inside `computeDriftScores` in the same file.
4. Register the id `drift-<category>` in `CATEGORY_CONFIG` (`src/scoring/categories.ts`) with `kind: "drift"` under the scoring bucket it should dent.
5. Build on the vote machinery in `src/drift/utils.ts` instead of reimplementing it: `buildDirectoryScopedVote` (minimum group size 3, dominance threshold 0.7, temporal weighting, intent-hint seeding), the `entropyGate` with `noConventionFinding` for the "no norm exists" case, and `isAnalyzableSource` to exclude tests, fixtures, and config files from the vote. If your detector measures a count phenomenon (pairs, orphans) rather than a peer ratio, set `countBased: true` so the scoring engine routes it through its density branch instead of misreading `consistencyScore` as a deviation rate.
6. Tests: `test/unit/drift/<name>.test.ts` for the detector, and check `test/unit/drift/drift-finding-to-finding.test.ts` and `test/integration/drift.test.ts` still pass. If the category can be injected synthetically, add an injector to `test/calibration/injectors.ts` and map it in `INJECTOR_CATEGORY` in `test/calibration/precision-recall.ts` so `npm run calibrate` measures its precision and recall.

> [!IMPORTANT]
> `driftFindingToFinding` (`src/drift/index.ts`) derives the routing `analyzerId` from the typed `driftCategory` as `drift-<category>`, never from the freeform `detector` string. Skipping step 4 does not error; the finding just defaults to hygiene and the detector never affects the headline score. This exact wiring gap once excluded most detectors from the composite, which is why the invariant is documented in the conversion function itself.

## Recipe 3: add a language to Security Consistency

Security Consistency (chapter 06) votes on whether routes carry the security properties their peers carry. Each language has its own AST extractor: `src/drift/security-ast.ts` (JS/TS), `security-ast-python.ts`, `security-ast-go.ts`, `security-ast-rust.ts`. Precondition: the language must already be parsed by the core pipeline (`SupportedLanguage` and the extension map in `src/core/language.ts`, grammar loading in `src/utils/ast.ts`).

1. Write `src/drift/security-ast-<lang>.ts` with route extraction: recognize the ecosystem's route registrations (verb calls, decorators, attribute macros), resolve receivers structurally first (assignments from known router constructors) with a naming-convention fallback, and gate paths on a leading-slash string literal so `cache.get("user:1")` never becomes a route. Resolve HTTP methods conservatively: a statically unresolvable method resolves to `"ALL"` so it stays in the mutating-route vote; never silently drop it to GET.
2. Implement the body-first auth classification with the same five-rule precedence the three existing extractors share (`classifyHookAuth`, `classifyGoMiddlewareAuth`, `classifyRustAuth`): (1) a veto segment on the name means not-auth, even over a real reject in the body; (2) a readable body with a verified reject is the only bless; (3) a fully visible non-enforcing body is not-auth, a name never rescues it; (4) an opaque body is `unsure` when the name is auth-flavored, else not-auth; (5) an unreadable or imported body behaves like (4). A name alone never blesses.
3. Define "verified reject" narrowly for the language: a 401 blesses alone; a 403 blesses only when the guarding condition structurally reads a credential surface; prune rejects inside nested closures (they do not run inline); allow at most a one-hop same-file helper follow with a cycle guard. Rust adds produce-position gating on top; study `security-ast-rust.ts` if your language has expression-oriented returns.
4. Wire the extractor into the orchestrator `src/drift/security-consistency.ts`: dispatch to the AST path only on a clean parse (`!tree.rootNode.hasError`) and decide the fallback explicitly. Python and Go route parse errors to a legacy regex path; Rust has no regex fallback and yields zero routes on a parse error. Either choice is fine; an AST path that half-runs on a broken tree is not.
5. Add a language noun to `HOOK_PHRASE` in `security-consistency.ts` so hedged copy reads naturally ("a before_request hook", "a middleware", "an extractor or layer").
6. Optionally extend cross-file resolution in `src/drift/security-xfile-index.ts` so an imported hook can be classified by its in-repo defining body. The governing rule there: resolution is path-anchored, never name-searched, and every ambiguity refuses. A resolved body still has to verifiably reject; the index adds no new bless path.
7. Build the fixture gate: `test/calibration/<lang>-security-fixture.ts` plus `security-<lang>.test.ts`, mirroring the existing Python/Go/Rust suites. These run on every `npm test`. Cover the scenario families below, each corpus in its own directory root (the `repoHasAuthMachinery` baseline check is repo-global, so mixing corpora leaks auth evidence between scenarios).
8. Add an isolated trend row (like `security_posture_rust`) to `test/calibration/precision-recall.ts` so `npm run calibrate` tracks the language's precision and recall separately; per-language rows are never merged into the shared baseline row.
9. Unit tests for the extractor itself go in `test/unit/drift/security-ast-<lang>.test.ts`.

| Family | What it pins |
| --- | --- |
| S0 | Recognition self-check: every fixture file yields exactly the expected route count, so a recall regression fails loudly instead of vanishing from a vote |
| S1 / S2 | Primary dominance vote: one planted deviator among an authed majority, precision and recall 1.0, through two different bless mechanisms |
| S3 | Uniform-auth-gap fallback: strip auth from every route and the fallback must fire (the ratio vote goes silent at 0%) |
| S4 | Negative control: uniformly public webhook receivers; non-vacuity asserted before zero findings |
| S5 | Uniformly-authed control: zero findings on every axis |
| S6 | Name reads as auth but the body does not enforce: flat not-auth, finding not suppressed |
| S7 | Boring-named hook whose body verifiably rejects: blesses on the body alone |
| S8 | Unresolvable body: `unsure`, hedged copy naming the hook |
| S9 | (Python) `methods=VAR` resolved through a single top-level literal assignment |
| S10 / S11 | Cross-file positive and negative: an in-repo hook body resolves and blesses; the same shape imported from outside the repo stays hedged |

> [!IMPORTANT]
> The invariant that must hold, stated in every extractor's module doc: **never-false-bless**. The extractor may under-report auth (a recall miss becomes an over-flag, which the hedged copy softens), but it must never mark an unauthenticated route as authenticated. An `unsure` outcome never sets an auth lane and never enters the file-middleware union; it only records the hook name in `RouteInfo.authUnsureHook`, and a blessed route never carries that field.

## Recipe 4: add an output format

1. Create `src/output/<fmt>.ts` exporting a pure `render<Fmt>Report(result: ScanResult)` returning a string or `Buffer`. Renderers are presentation only; no analysis, no network.
2. Add the format literal to `ReportFormat` and `VALID_FORMATS` in `src/core/project-config.ts`. This both validates `--format` and lets `.vibedrift/config.json` set the format as a committed project default.
3. Add a dispatch branch in `renderToFormat` in `src/cli/commands/scan.ts`, following the `csv`/`docx` pattern: dynamic import of the renderer, a default output filename (`vibedrift-report.<ext>`), and respect for `--output`.
4. Update the `--format` help text in `src/cli/index.ts`, and update `README.md` (`CONTRIBUTING.md` requires a README update for any flag or feature change).
5. Respect the honesty plumbing: render from the `ScanResult` as given. Below-peer-floor security findings and the suppression audit are already filtered out of the drift view at one upstream source point (`scoredDriftView` in `src/drift/index.ts`), so do not re-derive drift rows from raw findings; and if you render per-category scores, keep the security row consistent with a composite N/A the way `src/output/csv.ts` does. Machine-readable formats must keep stdout clean; the `json` path (data on stdout, notices on stderr) is the model.
6. Add tests under `test/unit/output/`, and consider the zero-dependency bias before adding a rendering library: the DOCX renderer hand-rolls its OOXML ZIP for exactly that reason.

## House conventions

- **Commits**: `feat|fix|docs(scope): description`, for example `fix(drift): handle empty directories in the dominance vote`.
- **Gates before any PR**: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. All four must pass.
- **Calibration gates that must stay green**: the `security-floor` precision gate in `npm run calibrate` (the run fails below 0.95 precision, `FLOOR_PRECISION_GATE` in `test/calibration/precision-recall.ts`); the multilang security suites (recipe 3), which run on every `npm test`; and `npm run calibrate:monotonic`, the pre-publish smoke test asserting the composite falls monotonically and by at least 3.0 points per 25% injected-drift step (`test/calibration/run.ts`).
- **Scoring changes**: any change to scoring behavior bumps `SCORING_VERSION` in `src/scoring/engine.ts`. Cross-version score deltas then suppress themselves and users get a single one-time notice; there is nothing else to wire. New scoring heuristics also get a section in `docs/algorithms.md` (what, why, limitations, tests).
- **Code style** (`CONTRIBUTING.md`): strict TypeScript, ESM throughout, named exports only, async/await (no `.then()` chains), throw on error rather than returning error-shaped objects, `@/*` aliases `src/*`.
- **Tests**: new behavior needs tests; bug fixes need a regression test.
- **Docs**: when your change makes a handbook chapter stale, fix the chapter in the same PR (`docs/handbook/README.md`).
