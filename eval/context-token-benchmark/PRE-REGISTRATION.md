# Pilot Pre-Registration — does `.vibedrift/context.md` lower AI-coding cost?

**Status:** DRAFT. Becomes **binding** only when frozen (a timestamped commit + tag) AFTER: (a) Sami confirms the decisions in §3, (b) the Phase-2 wiring in §5 is done, (c) the usage parser is validated against real `claude -p` output. **No metered run starts before freeze + balance top-up.** Pilot runs are EXCLUDED from the confirmatory dataset.

Companion docs: design spec `docs/superpowers/specs/2026-06-26-context-md-token-savings-experiment-design.md`; analysis script `analysis/analyze.py` (frozen estimator, already implemented + tested on simulated data).

---

## 1. Hypotheses (frozen)

- **H1 (primary, T vs P):** inlining a repo's *own* `.vibedrift/context.md` into the agent's instructions lowers the expected USD cost to reach a passing solution, versus a **same-format wrong-repo** `context.md` (the placebo). This isolates *repo-specific distillation* as the active ingredient.
- **H2 (secondary, T vs C):** T lowers cost versus no primer (the total real-world delta, which also bundles "having any block").
- **Guardrail:** success rate under T is **non-inferior** to the comparator within a pre-set margin. A cost win with worse success does not count.
- **Overall claim requires BOTH contrasts (T-vs-P AND T-vs-C) to pass non-inferior-success AND a cost reduction** (intersection-union; no alpha spent).

Scope of every claim: "Claude Code headless + `<pinned model>` on these repos." Never "VibeDrift saves your tokens."

## 2. Frozen primary analysis (implemented in `analysis/analyze.py`)

- **Primary endpoint:** expected USD **cost to obtain one passing solution** per arm = `sum(costUsd over ALL runs) / count(passing runs)`. This is unconditional (does not condition on success), so it is immune to the collider bias that conditioning-on-passing would introduce. Tested via the collider-guard simulation.
- **Headline statistics:** ratio T/P (primary) and T/C (secondary), each with a **95% cluster bootstrap CI** (resample tasks, B and seed fixed at freeze).
- **USD** computed from broken-out token classes (`input`, `output`, `cache_creation`, `cache_read`) × pinned per-token rates. Claude's own `total_cost_usd` is also persisted per run (`reportedCostUsd`) as a cross-check.
- **Guardrail:** per-arm success rate + non-inferiority test at the §3 margin.
- **Secondary (labeled):** arithmetic-mean cost ratio; conditional-on-success geometric-mean ratio.
- **Moderator:** effect split by contaminated vs fresh (post-training-cutoff) stratum.
- **Decision:** the intersection-union gate above, computed by `gatekeeping()`.

## 3. Decisions to CONFIRM before freeze (these are Sami's calls — proposed defaults shown)

| # | Decision | Proposed default | Why it matters |
|---|---|---|---|
| 1 | **Pinned model id** | `claude-opus-4-8` (exact id, never an alias) | Reproducibility; the harness currently has a `claude-opus-4-5` placeholder that must be replaced. |
| 2 | **Per-token USD rates** | FILL from official pricing for the pinned model at freeze date (input / output / cache-write 5m+1h / cache-read) | Every `costUsd` depends on these; set in `src/cli.ts`. Not guessed here. |
| 3 | **Caching mode** | Cold-start (fresh clone per run, no warm cross-run cache) | Cold vs warm give different dollar answers; the blog states which. |
| 4 | **Dollar MEI** | ≥ 15% reduction in expected cost-per-passing-solution | Set on business grounds BEFORE the pilot so it can't be chosen from observed effects. |
| 5 | **NI margin (success)** | 5 percentage points | A cost win with success worse by more than this does not count. |
| 6 | **Pilot dimensions** | ≥6 repos × ~4 tasks × R=5 × 3 arms (~360 runs) | Big enough to estimate between-task variance; small enough to be cheap. |
| 7 | **Max-turns cap / run** | 40 (record; cap hits = censored) | Bounds runaway runs; feeds the censoring logic. |
| 8 | **Harness scope** | Single (Claude Code headless); aider parked | v1 scope; aider is the top Tier-C add at pilot sizing. |

Confirmatory dimensions (R, K) are **not** fixed now — they are sized from the pilot's measured log-cost variance (upper CI bound, inflated ~25-40%).

## 4. Corpus + task sampling (finalize at freeze — candidates, not yet verified)

- **Repo inclusion criteria:** mid-size, a runnable deterministic test suite, permissive license, observable internal conventions, pinned to a commit SHA.
- **Languages:** TS, Python, Rust, Go (≥1 repo each; per-language claims are out of scope at this cluster count).
- **Contamination stratum (pre-registered moderator):** include BOTH well-known pre-cutoff repos AND repos/commits created AFTER the pinned model's training cutoff; run a cold memorization probe per repo and record it.
- **Repo list:** to be filled as a table of `repoId | language | gitUrl | sha | testCmd | placeboFrom | postCutoff`, each entry marked "verify: tests run clean, license OK, SHA pinned" — **none verified yet**.
- **Task sampling rule:** the last N=4 merged PRs per repo touching files that carry an open VibeDrift drift item, excluding format-only/trivial PRs; plus ≥1 negative-control task per repo (self-contained, conventions-irrelevant). The acceptance gate is the **PR's own tests**. Tasks + rubrics authored BEFORE any `context.md` is generated, by someone who has not read `context.md` content. Record the full selection funnel (candidates considered vs included).

## 5. Pre-launch wiring checklist — the "one go" gate

1. **Confirm §3 decisions; freeze** (timestamp commit + tag this file and `analyze.py`).
2. **Wire Phase-2 code** (currently placeholders, all flagged in code):
   - `src/real-deps.ts`: placebo **repo registry** keyed by `RepoSpec.placeboFrom` so the placebo arm clones the correct *different* repo (today it placeholders the own repo).
   - `src/cli.ts`: set the pinned model id (#1) and real per-token rates (#2).
   - Build `fixtures/repos.json` + `fixtures/tasks/` from §4.
3. **Validate the usage parser** against ONE real `claude -p --output-format stream-json --verbose` invocation — confirm `parseClaudeUsage` extracts usage / turns / model / compaction correctly (the current fixtures are synthetic). This is the first, tiny metered touch.
4. **Flake-characterize** each repo's gate command (~20 pristine runs; quarantine non-deterministic tests; pin the selection; record per-repo flake rate).
5. **Run the pilot on Fly** (metered, unattended). Deliverables: within-task SD/CV of `log(cost)`, the per-run cost distribution, per-arm compaction rates, and the confirmatory run count needed to detect the dollar MEI at 80% power (sized off the variance upper CI bound). **Decision gate:** if the detectable run count is impractical, raise the MEI or stop. Pilot runs are excluded from the confirmatory dataset.
6. I give you the **calibrated confirmatory USD projection**. You **top up the Claude balance** with margin (balance is not API-queryable; mid-run exhaustion corrupts the batch).
7. **Confirmatory run on Fly** (gated). Then `analyze.py` emits the real synopsis: cost-per-passing-solution ratios T-vs-P and T-vs-C with 95% CIs, the success-rate NI verdict, the secondary ratios, the contaminated/fresh split, and the gate decision.

## 6. Reproducibility package (published with results, spec §13)

Harness + Docker image; `repos.json` + tasks + selection funnel; SHAs; exact prompts + the injected `CLAUDE.md` blocks; per-run transcripts + `usage` logs; raw cost data; frozen `analyze.py` + bootstrap seed; exact model id + Claude Code version + pricing-snapshot date; 1-2 sample generated `context.md` artifacts.

## 7. Residual risks to disclose in the blog lede (spec §12)

Vendor-run benchmark; single harness + one model generation; synthetic/headless tasks differ from interactive coding; pretraining contamination; effect conditional on fresh, coherent `context.md`; `context.md` is a CLI side-artifact distinct from the MCP tools; the VibeDrift drift-score secondary is circular (descriptive only).

---

**One-line status:** infrastructure built + tested (auto-inject shipped to branch; harness 84 tests; analysis 26 tests). We are one `go` from real numbers: confirm §3, do the §5 wiring, top up, run the pilot.
