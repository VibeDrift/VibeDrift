# Scoring: From Findings to the Vibe Drift Score

Every analyzer, drift detector, and Code DNA module ends in the same place: a flat list of `Finding` objects. The scoring engine (`src/scoring/engine.ts`) turns that list into the headline Vibe Drift Score, a parallel Hygiene Score, five category scores, per-file scores, and per-finding fix impacts. This chapter documents the real engine as shipped, `SCORING_VERSION = "v11"`, including the design history that explains why it is not a weighted sum.

## Two tracks, one engine

`computeScores` runs the same category computation twice over the same findings, split by analyzer kind (`src/scoring/categories.ts`):

- **Drift track**: only drift-kind findings (dominance votes, similarity signals, taint flows, learned patterns). Its composite is the Vibe Drift Score, the number on the report.
- **Hygiene track**: hygiene-kind findings (classic linter territory: empty catches, dead code, generic security rules). Same math, separate score, separate pane.

The split is the product boundary in code. VibeDrift measures drift, deviation from the repo's own dominant patterns; a generic finding that any linter could produce must not move the headline number, however useful it is to show.

## The detector-level damage model

Findings within a category are first grouped by `analyzerId`. Each detector group then contributes exactly one bounded **damage** term, and the category's health is the product of the survivals, a structure known as a noisy-OR (each detector is an independent chance of "damaging" the category, and health is the probability of surviving all of them):

```text
damage_d = min(0.85, severity_d × confidence_d × importance_d × deviation_d × sampleConf_d)
health_c = Π_d (1 − damage_d)
categoryScore_c = 20 × health_c
composite = 100 × exp( Σ_c ln(max(0.02, health_c)) / |applicable categories| )
```

Grouping by detector, not by finding, is the first size-fairness decision: 30 findings from one detector damage a category exactly as much as that detector's worst deviation warrants, never 30 times as much. Raw finding count scales with codebase size; the number of distinct drifting patterns, and how badly each drifts, does not.

The five factors of `damage_d` (all in `detectorDamage`, `src/scoring/engine.ts`):

| Factor | Definition | Constants |
|---|---|---|
| `severity_d` | worst severity in the group, mapped through `SEVERITY_DAMAGE` | error 0.7, warning 0.4, info 0.12 |
| `confidence_d` | mean confidence across the group's findings | default 1.0 |
| `importance_d` | max file-importance weight over the group's locations | see the weights table below |
| `deviation_d` | how far the repo actually deviates on this axis (three shapes, below) | floor 0.05 |
| `sampleConf_d` | dominance sample-size weight: `min(1, maxTotalRelevantFiles / 8)` | `SAMPLE_FULL_CONFIDENCE = 8` |

and the cap `MAX_DETECTOR_DAMAGE = 0.85` guarantees that no single detector can remove more than 85% of a category, so one catastrophic axis cannot erase the information carried by the others.

### File-importance weights

The score measures drift in the code a project ships. Drift in generated output, fixtures, tests, and examples is analyzed and reported, but weighted down in the composite (`computeFileImportanceWeight`):

| Path class | Weight | Examples |
|---|---|---|
| Generated / fixtures | 0.05 | `generated/`, `*.gen.ts`, `*.pb.go`, `_pb2.py`, `fixtures/`, `__mocks__/`, `__snapshots__/` |
| Tests | 0.35 | `tests/`, `__tests__/`, `*.test.*`, `*_test.go`, `test_*.py` |
| Examples / demos | 0.35 | `examples/`, `demos/`, `samples/` |
| Entry points | 1.5 | `index.*`, `main.*`, `app.*`, `server.*`, `lib.rs`, `mod.rs`, `*.config.*`, `.env*` |
| Everything else | 1.0 | |

The rationale is calibrated, not aesthetic: the comment above these constants records that roughly 82% of trpc's real duplicate groups live in examples, tests, and generated code, not in `packages/src`. Down-weighting is the honest lever for that, rather than distrusting a duplicate detector that is precise about what it found.

### The deviation term: three shapes

`groupDeviation` picks the deviation formula by what evidence the group carries:

1. **Dominance detectors** (every finding in the group has a `driftSignal`): deviation is the worst `1 − consistencyScore/100` in the group, that is, the largest share of relevant files that deviate from the dominant pattern. It is a rate, already size-normalized. A nonzero deviation is floored at `DEVIATION_FLOOR = 0.05` so a flagged-but-nearly-consistent pattern still registers faintly, but an exact zero stays zero: a finding whose group turned out fully consistent is not drift and must contribute no damage.
2. **Grouped duplicates** (`dupGroupSize > 1` present): deviation is `1 − e^(−dupFraction/0.15)`, where `dupFraction` is the sum of redundant copies (`dupGroupSize − 1` per group, each weighted by where the group's files live) divided by the total function count. Thirty-two identical functions register as roughly 31 redundant copies no matter how the detector chunked them into findings. Because file importance is baked in per duplicate group here, `detectorDamage` uses a neutral importance for duplicate detectors to avoid double-counting.
3. **Other count-based detectors** (Code DNA similarity, ML findings, hygiene analyzers): deviation is a saturating per-function rate, `1 − e^(−(count/functions)/0.5)`, falling back to a per-KLOC density `1 − e^(−(count/KLOC)/2.0)` when the function count is unknown. The per-function rate (added in v6) is what keeps large repos fair: structural-similarity findings scale with function count, so a per-KLOC density kept rising with repo size and unfairly sank large clean repos.

The `sampleConf_d` factor exists for the same statistical reason in the other direction: a 70% majority over 4 files is far weaker evidence of a convention than the same share over 40 files, so dominance findings earn full damage weight only once the vote saw at least 8 relevant files. Count-based findings carry no dominance sample and pass through at 1.0.

## Category scores and the empty-category problem

A category with findings gets `20 × health`. A category with no findings is genuinely subtle, and `computeCategoryScore` treats two cases differently:

- **Surface-specific drift categories** (`securityPosture`, `intentClarity`): zero findings could mean "clean" or could mean "this repo has no routes to vote on." The engine cannot tell the difference, so on the drift track an empty one is marked not measured and excluded from the composite entirely, rather than credited a free 20/20 that would dilute the categories that were measured.
- **All other empty categories** earn evidence-weighted clean credit: `frac = 0.8 + 0.2 × (1 − e^(−LOC/2500))` of the max score. "No drift found" in 50 lines of code is weak evidence; in 8000 lines it is strong. Without this, every category in a tiny repo returned the max and the composite floated to ~100 purely because the repo was small (measured before the fix: repos under 20 functions had a median score of 100, repos over 500 functions a median of 82). The prior 0.8 is the elite-corpus mean health, so a thin-evidence clean repo lands near the population mean rather than getting either a free 100 or a punitive markdown.

## The composite: a geometric mean

The Vibe Drift Score is the geometric mean of category healths over the applicable categories, computed in log space for numerical stability, with each health floored at `HEALTH_FLOOR = 0.02` so one fully-collapsed category collapses the composite without hard-zeroing it into illegibility.

A geometric mean is multiplicative: a repo scoring 0.95/0.95/0.30 composites to about 65, where an additive average would report a reassuring 73. That asymmetry is deliberate. One collapsed dimension (say, security consistency in shreds) is not offset by tidiness elsewhere, and the old additive engine's floor near 75 was one of the main reasons it stopped discriminating.

One category never appears on the drift track at all: `dependencyHealth` has only hygiene-kind analyzers (`dependencies`, `config-drift`), so under the drift kind-gate it has zero applicable analyzers, is marked `applicable: false`, and simply drops out of the geometric mean's denominator. There is no /80 to /100 rescale; the mean is taken over whatever is applicable.

## The five categories and what feeds each

All five categories have `maxScore: 20` (`src/scoring/categories.ts`):

| Category | Drift-kind feeders | Hygiene-kind feeders |
|---|---|---|
| Architectural Consistency | `naming`, `imports`, `drift-architectural_consistency`, `drift-naming_conventions`, `drift-async_patterns`, `drift-import_style`, `drift-export_style`, `drift-return_shape_consistency`, `drift-logging_consistency`, `drift-state_management_consistency`, `drift-test_structure_consistency`, `codedna-pattern`, `codedna-deviation`, `ml-anomaly` | `error-handling`, `language-specific` |
| Redundancy | `drift-semantic_duplication`, `drift-phantom_scaffolding`, `codedna-fingerprint`, `codedna-opseq`, `ml-duplicate`, `ml-reimplementation-concentrated` | `duplicates`, `todo-density`, `dead-code`, `ml-reimplementation` |
| Dependency Health | (none; never on the drift track) | `dependencies`, `config-drift` |
| Security Consistency (`securityPosture`) | `drift-security_posture`, `codedna-taint` | `security`, `security-floor`, `security_posture-advisory`, `security-suppression` |
| Intent Clarity | `drift-comment_style_consistency`, `ml-intent` | `intent-clarity`, `complexity`, `implementation-gap` |

The report also renders 13 per-drift-category bars (import style, logging consistency, and so on). Those are not a second scoring formula: each bar is the same `categoryHealth` for that one detector, multiplied by a display weight from `DRIFT_WEIGHTS` (`src/drift/types.ts`), a faithful decomposition of the composite's terms. Collapsing the previous separate formula into this decomposition was the v3 "dual-engine collapse."

## Upstream signal shaping: entropy gate and temporal decay

Two mechanisms in `src/drift/utils.ts` shape the dominance signals before they ever reach the engine, and both directly set the numbers the damage model consumes.

The **entropy gate** decides whether a convention exists at all. Given the vote distribution for a pattern axis, it computes normalized Shannon entropy; above 0.8 there is no dominant convention, so the detector reports a single "no convention" observation at confidence 0.75 instead of flagging half the repo as deviant. Below the gate, deviators are flagged with confidence `max(0.3, min(0.9, 1 − normalizedEntropy))`: the tighter the convention, the more confident the deviation. That confidence is exactly the `confidence_d` the engine averages.

The **temporal weight** makes votes recency-aware when git metadata exists: each file's vote is scaled by `2 × e^(−ln2 × daysAgo / 90)`, so a file touched today counts 2x, at 90 days 1x, at 180 days 0.5x, and at a year roughly 0.12x. The point is migrations: three recent files should outvote ten stale ones when the codebase is actively moving away from an old pattern, otherwise every in-progress migration reads as drift. Files without metadata weight 1.0, which reproduces the pre-temporal behavior. The vote's outputs, `consistencyScore` and `totalRelevantFiles`, become the engine's deviation and sample-confidence inputs through the finding's `driftSignal`.

## Gates that re-tag findings

Two calibrated gates run at the top of `computeScores`, both implemented as pure re-tags of `analyzerId` between hygiene and drift kinds. Re-tagging (rather than deleting) is the lever this architecture offers for "show it, but don't score it."

**Reimplementation concentration gate** (`applyReimplementationConcentrationGate`). Panel-confirmed `ml-reimplementation` findings (a deep-scan output) are hygiene-kind by default and re-tag to the drift-kind `ml-reimplementation-concentrated` only when there are at least `REIMPL_CONCENTRATION_MIN_COUNT = 3` of them and their density reaches `REIMPL_CONCENTRATION_DENSITY_MIN = 1.0` per KLOC. The calibration story is in the source comment: across a 425-repo corpus, raw reimplementation count did not separate elite repos from AI-sprawl repos (large elite repos carry a sparse reimplementation baseline of legacy files and parallel platform implementations), but density did: 0 of 249 elite repos reach 1 finding/KLOC. The gate is deliberately conservative in the "clean" direction; sparse reimplementation stays informational.

**Security min-peer floor** (`applySecurityMinPeerFloor`). A route-consistency `drift-security_posture` finding whose dominance vote saw fewer than `MIN_SECURITY_PEERS = 4` relevant routes re-tags to the hygiene id `security_posture-advisory`. Below that floor, a single deviating route is too large a fraction of too small a sample to trust as a repo-level drift claim; the finding still renders, as an advisory, but never dents the composite. The same floor is applied a second time in `buildScanResult` before rendering, and renderers that read the raw drift-finding view use the shared predicate `isBelowSecurityPeerFloor`, so no export surface can list a security drift finding that the category scored as N/A.

## Worked example: two findings to a category score

Take a 12,000-line repo with 400 extracted functions, and two drift-kind findings in Architectural Consistency:

- **Finding A**, from the import-style drift detector (`drift-import_style`): warning, confidence 0.85, in `src/api/users.ts` (weight 1.0), with `driftSignal = { consistencyScore: 80, totalRelevantFiles: 20 }` (16 of 20 relevant files follow the dominant import style).
- **Finding B**, from the static `naming` analyzer: warning, confidence 0.62, in a normal source file. No `driftSignal`, so it takes the count-based path.

| Factor | Finding A (`drift-import_style`) | Finding B (`naming`) |
|---|---|---|
| severity | warning: 0.4 | warning: 0.4 |
| confidence | 0.85 | 0.62 |
| importance | 1.0 | 1.0 |
| deviation | 1 − 80/100 = 0.20 | 1 − e^(−(1/400)/0.5) ≈ 0.0050 |
| sample confidence | min(1, 20/8) = 1.0 | 1.0 (no dominance sample) |
| **damage** | 0.4 × 0.85 × 1.0 × 0.20 × 1.0 = **0.068** | 0.4 × 0.62 × 1.0 × 0.0050 × 1.0 ≈ **0.0012** |

The two findings come from different detectors, so the category multiplies their survivals:

```text
health  = (1 − 0.068) × (1 − 0.0012) ≈ 0.9308
score   = 20 × 0.9308 = 18.6 / 20
```

Note the asymmetry the model is built for: the dominance finding (a real 20% deviation across 20 files) costs 55 times more than the single count-based naming finding in a 400-function repo. Suppose the other drift categories land at Redundancy 17.6/20 (health 0.88) and Security Consistency 19.0/20 (health 0.95), with Intent Clarity unmeasured (no comment-style or intent findings) and Dependency Health not applicable on the drift track. The composite averages the three measured healths geometrically:

```text
composite = 100 × exp( (ln 0.93 + ln 0.88 + ln 0.95) / 3 ) ≈ 92.0   →  grade A
```

Letter grades are assigned at render time: A at 90+, B at 75+, C at 50+, D at 25+, F below (`src/cli/commands/scan.ts`, kept in sync with the HTML renderer's `gradeFor()`).

## Per-file scores and fix projections

`computePerFileScores` applies the same detector-level noisy-OR scoped to each file's findings, with deviation treated as full (the file is the deviator on its own axes), bounded by the same 0.85 cap, on a 0 to 100 scale.

Two "what if" surfaces come from the same machinery. `consistencyImpact`, stamped on each drift finding, is the exact score gain from removing that finding alone, computed by recomputing the category without it (O(n²) per category, but findings per category are few); an emptied category routes through the same evidence-weighted clean-credit path, not a free maximum. `estimateScoreAfterFixes` does a real recompute on the remaining set and additionally returns `consistencyGain`, the summed per-category point gain, which is provably between the largest individual impact and the sum of all impacts, because the noisy-OR is sub-additive. The Fix Plan displays that value, so the projected total and the per-item impacts can never contradict each other.

There is also a peer-percentile hook: `compositeToPercentile` places the composite on the empirical CDF of a bundled per-language corpus distribution (`src/data/score_percentiles.json`). The shipped artifact is currently a placeholder with an empty `languages` map, so every lookup returns `null` and the renderer shows nothing; the mechanism is live, the data is pending.

## SCORING_VERSION: shipping score changes without gaslighting users

Scoring methodology changes make raw scores from different versions incomparable, and a user who sees their score drop 6 points wants to know whether their code got worse or the ruler changed. The engine's answer is `SCORING_VERSION` (currently `"v11"`), with three coordinated behaviors:

1. **Cross-version delta suppression.** History stores the `scoringVersion` alongside each scan's scores. When `computeScores` receives previous scores from a different version, it refuses to compute per-category deltas (they would be in different units) and returns `previousScoresMismatch: "scoring-version-mismatch"`, which downstream silently hides delta arrows.
2. **A one-time notice, never a banner.** `shouldShowScoringNotice` (`src/core/scoring-notice.ts`) shows a single line ("We refined how the Vibe Drift Score is calculated this release... What changed → https://vibedrift.ai/releases") exactly once per version change, then records `lastSeenScoringVersion`. Brand-new users with no history see nothing. Users never see the version string itself.
3. **A written history.** The version block in `engine.ts` records every methodology change:

| Version | Change |
|---|---|
| v1 | raw composite on a /80 scale, no normalization |
| v2 | composite normalized to /100 at the engine boundary (0.7.0) |
| v3 | all 14 drift detectors wired into the composite (was 3); single engine, dual-engine collapse |
| v4 | decompressed scoring: dominance-ratio magnitude, no per-analyzer cap, no sqrt-LOC dampener, multiplicative geometric-mean composite, real 0 to 100 range |
| v5 | evidence-weighted clean credit for no-finding categories; deep-scan dedup-aliasing fix |
| v6 | size-fair count normalization by per-function rate instead of per-KLOC density (trpc moved 69.6 to 81.6, TanStack 62.1 to 76.4) |
| v7 | concentrated reimplementation feeds the composite via the density gate |
| v10 | Express `.all()` and Flask `methods=[...]` mutating routes enter the security auth/validation votes |
| v11 | multi-language security auth (body-first route and auth extraction for Python/Go/Rust, cross-file hook resolution, conservative "unsure"); AST import graph with real module resolution |

(The comment records no v8 or v9 entries.)

## Why not a simple weighted sum

The first engine was one. Through v3 the score summed severity-derived weights over findings and mapped the sum through an exponential decay, `score = maxScore × e^(−K × weight)` with `K = ln(2)/15`, plus patches that accumulated around it: per-analyzer caps, a sqrt-LOC dampener, a correlation amplifier. That formula still appears in `ARCHITECTURE.md`'s scoring section, which predates v4; treat the engine source as authoritative. The v4 rewrite ("decompressed scoring") replaced the whole structure, and the reasons are the design rationale for everything above:

- **Finding counts scale with repo size; drift does not.** A weight sum grows with LOC, so big repos scored worse for being big. The sqrt-LOC dampener treated the symptom. The noisy-OR treats the cause: detectors contribute deviation rates and per-function rates, which are size-invariant.
- **Additive scores compress.** With per-analyzer caps and a shared decay constant, most real repos landed in a narrow high band and the score stopped discriminating. Removing the caps and letting bounded damages multiply restored a real 0 to 100 range.
- **A sum cannot express "one collapsed category matters."** An additive composite has a floor: four clean categories buy back a destroyed fifth. The geometric mean makes collapse visible in the headline while `HEALTH_FLOOR` keeps the rest of the report legible.
- **Firing is not magnitude.** In the old model a detector firing cost a fixed weight whether 5% or 45% of files deviated. The dominance deviation term makes the magnitude of inconsistency, not the fact of detection, carry the damage.

The trade-offs are real and accepted. The noisy-OR is sub-additive, so per-finding impacts do not sum to the total gain (hence `consistencyGain` and its documented bounds). A multiplicative composite is harder to explain than an average, which is partly why this chapter exists. And every one of these changes made old scores incomparable with new ones, which is exactly the problem the `SCORING_VERSION` mechanism absorbs.

> [!WARNING]
> If you change anything in this chapter's math (a constant, a factor, a gate threshold), bump `SCORING_VERSION` in `src/scoring/engine.ts` and add a history entry. The delta suppression and the one-time notice only work if the version string moves with the methodology.
