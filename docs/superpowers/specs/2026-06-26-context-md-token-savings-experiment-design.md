# Does VibeDrift's `context.md` lower AI-coding cost? — Pre-registered controlled benchmark (design)

**Status:** DRAFT design / pre-registration skeleton. Not yet executed. No metered spend committed.
**Date:** 2026-06-26
**Owner:** Sami
**Purpose:** Produce a publicly defensible measurement of whether inlining a VibeDrift `.vibedrift/context.md` into an agent's context lowers the dollar cost to reach a passing solution, to anchor a public blog on VibeDrift's value. Audit-first: only claims this design can actually support may reach a reader.

---

## 0. TL;DR of what this measures (and what it does NOT)

We test one narrow, honest claim:

> For a coding task in a repo, **inlining the content of that repo's `.vibedrift/context.md` into the agent's instructions** lowers the **dollar cost to produce a solution that passes the repo's own tests**, at **no loss of success rate**, versus (a) no primer and (b) a same-shape primer built from a *different* repo — under **Claude Code headless with one pinned model**, on a pre-registered set of repos.

We do **not** claim: "VibeDrift saves your tokens" (too broad), that the MCP tools save tokens (untested; the moat is separately argued), that results transfer to other agents/models or interactive sessions, or that a stale/low-quality `context.md` helps.

This document is the protocol. It is designed to be frozen and timestamped before the confirmatory run.

---

## 1. Background and audited facts

- `.vibedrift/context.md` is a real, shipped artifact written by `vibe-drift/src/output/context-md.ts` (`writeContextFiles()`), produced by the CLI flag `vibedrift --write-context` (and `vibedrift watch`). It is ~3 KB / ~38 lines: a "Dominant patterns" section, a "Drift items currently open" section (top 10 by impact), a "Recent trajectory" diff, and an "If you're an AI agent working on this codebase" section.
- It is **NOT** produced by any MCP tool, and the MCP `init` tool advertised in server instructions is not implemented in this workspace.
- The agent does **NOT** read `context.md` automatically today. Auto-injecting it into `CLAUDE.md` / `.cursorrules` is an unshipped backlog item (`vibe-drift/todo.md:369`).

**Decision (resolved with Sami):** we will **ship the auto-inject feature first**, so the measured treatment equals the genuinely shipped path, and the blog can describe a real user experience rather than a stand-in. See Section 3.

**Decision (resolved with Sami):** execution is **staged** — build harness, run an expanded pilot, gate the metered confirmatory spend on the pilot result, then run on Fly. See Section 9.

---

## 2. Hypotheses (pre-registered)

Let cost = USD per run, computed from pinned per-token rates with input / output / cache-write / cache-read broken out (Section 6). Let "pass" = the run's final committed state passes the deterministic acceptance gate (Section 7).

- **H1 (primary contrast: T vs P).** Inlined *repo-specific* `context.md` (T) lowers the expected cost to obtain one passing solution versus a same-shape *wrong-repo* `context.md` (P). This isolates "the content actually describes *this* repo" as the active ingredient.
- **H2 (secondary contrast: T vs C).** T lowers expected cost-to-pass versus no primer (C). This is the "total real-world delta," and it bundles the act of front-loading a primer with the repo-specific content; it is reported as such, not as the clean causal effect.
- **Co-primary guardrail (both contrasts).** Success rate under T is **non-inferior** to the comparator within a pre-set margin. A cost win with worse success does not count.

**The overall published claim requires:** non-inferiority on success rate AND a cost reduction, for **both** T-vs-P and T-vs-C (intersection-union; see Section 8).

---

## 3. Prerequisite feature work: `context.md` auto-inject (ship before the experiment)

The treatment must equal a shipped path. Build and release a minimal auto-inject in the CLI:

- New behavior (opt-in flag, e.g. `--inject-context`, composing with `--write-context` / `watch`): write `context.md`'s content into a **managed, clearly-delimited block** in `CLAUDE.md` (and optionally `.cursorrules` / `AGENTS.md`), e.g. between `<!-- vibedrift:context:start -->` and `<!-- vibedrift:context:end -->`, idempotently (re-running replaces the block, never duplicates it).
- Inlining content (not a pointer) is deliberate: it removes the uncontrolled "did the agent choose to Read the file" behavioral variable and the extra tool round-trip, and it matches what a context-injection feature should do.
- Tests: idempotency, block replacement, no corruption of surrounding `CLAUDE.md`, behavior when the file is absent. Follow `vibe-drift` commit + test conventions.
- This is a free/OSS CLI feature, which cuts against the current paid-tier focus; shipping it is an explicit, Sami-approved exception because it makes the public claim honest.

The experiment's Treatment arm uses exactly this mechanism.

---

## 4. Experimental design

**Paradigm:** controlled automated benchmark (not a field test).
**Structure:** within-task (paired), three arms. Each task is run under all three arms, R replicates per arm.

| Arm | What the agent's `CLAUDE.md` contains |
|-----|----------------------------------------|
| **C** (Control) | The repo's original `CLAUDE.md`, no injected block. |
| **P** (Placebo / wrong-repo) | A managed block containing a **real** `context.md` generated by `vibedrift --write-context` on a **different, unrelated, same-language repo**, identical in section structure and token count to T's block, placed at the identical position. |
| **T** (Treatment) | A managed block containing the **real** `context.md` for **this** repo. |

Rationale: P controls for "has an authoritative-looking, same-shape primer in context." The only difference between P and T is whether the patterns/drift items actually describe the repo under test. A generic prose primer is *not* used (it is not inert and confounds format with content); P is byte/token-comparable to T.

**Optional arms (decide at pilot sizing; see Section 11):** C′ = managed block pointing at a near-empty file (isolates the pure block-presence effect); a staleness arm (context.md generated N commits behind the task SHA); a messy/low-coherence repo stratum. These bolt on without redesign.

---

## 5. Corpus and task mining

**Repos (pre-registered, pinned to commit SHAs):** target 6–8 mid-size OSS repos spanning TS / Python / Rust / Go. Inclusion criteria fixed in advance: size band, has a runnable test suite, permissive license, observable internal conventions. Note explicitly: with ~6–8 repos, repo is a small cluster count; generalization targets the population these repos sample, not "repos in general," and per-language claims are out of scope at this scale (Section 8, Section 12).

**Pretraining-contamination stratification (pre-registered moderator):** include both (a) well-known pre-cutoff repos and (b) repos/commits/tasks created **after** the pinned model's training cutoff. Probe each repo for memorization (ask the model cold to recall structure/APIs, score it). Report the T effect separately for contaminated vs fresh strata. The mechanism (context.md short-circuits exploration) only bites where the model must explore, so this stratum is load-bearing for credibility.

**Tasks — mined from real history, not hand-authored:**
- Draw positive tasks from each repo's merged-PR / closed-issue history at the pinned SHA, via a pre-registered sampling rule (e.g. "last N merged PRs touching files that carry an open drift item, excluding trivial/format-only PRs").
- The **acceptance gate is the real merged PR's own tests** (deterministic, arm-independent).
- Tasks and rubrics are authored **before any `context.md` is generated** for that repo, by someone **blind to `context.md` content** (this is the relevant blinding, not "blind to which arm wins").
- Report the **selection funnel**: candidates considered vs included.
- **Negative-control tasks:** self-contained tasks where `context.md` should not help; verify their changed files do not overlap the patterns/drift items in `context.md`. Their expected null band is "T − C within the fixed token overhead of injecting the block" (estimated via `count_tokens` × expected turn count), **not zero**, because the block carries a real per-turn cost.

---

## 6. Endpoints and token/cost accounting

**Primary endpoint:** **USD cost per run**, computed as Σ (tokens_class × rate_class) over `input_tokens`, `cache_creation_input_tokens` (cache-write, billed at its TTL multiplier), `cache_read_input_tokens`, and `output_tokens`, summed across **every turn and tool iteration** of the run (not the final turn). The one-time `context.md` cache-write is counted as part of Treatment cost. Rates and exact model ID are pinned and recorded at run time.

**Minimum effect of interest (MEI):** set in **dollars**, on business grounds, **before** the pilot (so it is not chosen from observed effects). Token-percentage MEIs are forbidden as the headline because caching makes a token percentage and a dollar percentage diverge by up to ~50× (context.md sits in the cached prefix; savings are largely uncached exploration).

**"Run cost" definition (precise):** total billable cost of a run whose **final committed state** passes the gate. We drop the unmeasurable "tokens to *first* success" (gates only run after the agent stops). If time-to-success is wanted later, it requires per-turn checkpointing + per-checkpoint gate runs, which is out of scope for v1.

**Secondary / exploratory (clearly labeled, never headline):**
- Raw token counts (input and output separately).
- Geometric-mean cost ratio (the LMM location parameter) as inferential support for the arithmetic headline ratio.
- Net-effect decomposition: "context tokens added" vs "exploration tokens saved."
- Latency.
- **VibeDrift drift/convention-match score** on changed files — **explicitly circular** (the treatment is derived from the same pattern model this score uses); reported as descriptive color only, with the circularity disclosed in the same sentence, never in any victory condition.

**Caching configuration (pre-registered, verified empirically):** one caching mode chosen and documented (cold-start fresh-container vs warm-session — they give different dollar answers; the blog states which it represents). Identical `cache_control` breakpoint placement and TTL across arms. Verify from the `usage` object on a sample that `cache_creation` / `cache_read` on the shared prefix is identical across C/P/T. Account for the block possibly falling below the model's cache-write minimum (then it bills uncached per turn). Token-match P to T via `count_tokens` against the pinned model.

---

## 7. Quality / acceptance gate

A run "passes" iff its final committed state satisfies:

1. **Deterministic test suite passes** — ideally the real merged PR's tests. This is the hard gate.
2. **Coarse "attempted the task" check** by an LLM judge, used only to catch no-ops/garbage, not to grade quality.

Hardening:
- **Flake control:** characterize each repo's flake rate (run pristine suite ~20×, quarantine non-deterministic tests, pin the test selection). On a gate failure, re-run failing tests k times; count a hard failure only if it reproduces. Report per-repo flake rate.
- **Blinding:** the LLM judge sees only the final diff + task spec with all arm/context/block markers stripped, in randomized order. A human auditor reviews a pre-registered, sufficiently powered sample, also blinded. Report judge-vs-human inter-rater agreement **by arm** (differential leniency would invalidate "equal success").

---

## 8. Statistical analysis plan (frozen before the confirmatory run)

- **Unit / model:** analyze the **within-task paired log-cost ratios** per task (log T − log C, and log T − log P) as the unit of analysis. This exactly exploits the pairing and sidesteps fragile random-slope covariance estimation. Equivalent maximal-model alternative: mixed model with `(arm | repo/task)` and Kenward-Roger / Satterthwaite df. Back all inference with a **cluster/parametric bootstrap** given the small number of clusters.
- **Repo:** treated as fixed effects, or as a random effect whose variance is reported as an acknowledged-imprecise nuisance (profile CI). No "generalizes to all repos" language. **No per-language claims** (language is aliased with ~2 repos each).
- **Handling failures (the collider fix):** the primary estimand is defined over **all runs**, not the conditional-on-success mean:
  - **Success rate** per arm: binomial GLMM with a pre-set **non-inferiority margin** (co-primary).
  - **Cost-to-pass:** accelerated-failure-time / survival model where budget- or max-turn-exhausted runs are **right-censored** at consumed cost, and "finished-but-wrong" runs are a **competing terminal outcome** (cure/mixture term), **not** Tobit-censored. Report the unconditional **expected cost to obtain one passing solution** as the headline.
  - The conditional-on-success geometric-mean ratio is a labeled secondary only.
- **Arithmetic vs geometric:** also estimate the **ratio of arithmetic means** (Gamma GLM / log-link, or bootstrapped ratio of totals), since the headline is a cost/total-dollars claim and the geometric-mean ratio can diverge from it (Jensen).
- **Multiplicity (no alpha spent):** fixed-sequence gatekeeping — (1) non-inferiority on success rate, then (2) superiority on the single pre-committed cost metric; the overall claim requires **both** T-vs-P and T-vs-C to pass (intersection-union test, conservative at 0.05 each, no correction needed).
- **One frozen primary analysis:** estimand, population (all runs, censored), cost metric (one caching mode), model ID, contrast (T-vs-P primary), estimator, and the single headline number are all locked. A frozen analysis notebook/script is committed **before** the confirmatory batch; results are reported from that script. Everything else is explicitly secondary/exploratory.

---

## 9. Execution, staging, and metered-spend gate

**Staged plan (Sami-approved):**
1. **Build** the harness (Section 10) + ship auto-inject (Section 3).
2. **Expanded pilot:** ≥6 repos × ~4 tasks × R replicates × 3 arms. Its **only deliverables** are (a) the within-task SD / CV of log(cost), (b) a per-run cost distribution, (c) a feasibility verdict: is the dollar-MEI detectable above trajectory noise at a practical run count? Pilot runs are **excluded** from the confirmatory dataset.
3. **Gate:** I compute the projected confirmatory spend (per-run cost distribution × pinned rates × required runs, sized off the **upper bound** of the pilot variance CI inflated ~25–40%, including cache-write multipliers and re-run/censoring overhead). If the SNR implies an impractical run count, we raise the MEI or stop before spending.
4. **Top up first, then launch.** State the projected USD range explicitly; Sami tops up the Claude balance with margin (balance is not API-queryable, and a mid-batch exhaustion corrupts the run). No metered confirmatory run launches without this.
5. **Confirmatory batch on Fly** (cloud, unattended — consistent with the long-run policy and the prior corpus run pattern). Results stream to a Fly volume **and** push to a results repo / object storage on an interval (survives machine recycling; watchable remotely). Batch exits on completion (no idle spend). Optional push notification at completion.

**Determinism reality:** seed/temperature are unavailable on current models; adaptive thinking and tool-loop iteration count are stochastic. We frame the result as a **distribution shift, not a deterministic delta**, and never claim seed/temperature control. Pin the **exact model ID string** (never an alias), exact Claude Code version, compaction/context settings, and an explicit `--max-turns` cap (cap hits counted as censored). Log full per-turn transcripts and cumulative usage. Report per-arm compaction rates (a differing rate is a finding, not noise).

**Cost anchor (rough, pilot will replace):** agentic Claude Code runs on mid-size repos commonly consume hundreds of thousands of effective tokens each, with output billed several× input on Opus-tier. With ~20–75 tasks × R replicates × 3 arms, the confirmatory phase is plausibly **300–1100+ metered runs**, i.e. low-hundreds to low-thousands of USD. This is an order-of-magnitude placeholder, explicitly gated on the pilot.

---

## 10. Harness (to be built; detailed in the implementation plan)

Containerized runner (Docker image: `claude` CLI + git + node/python/rust/go toolchains), `ANTHROPIC_API_KEY` as a Fly secret (metered API key, not subscription, for clean per-run accounting). For each (repo × task × arm × replicate): fresh clone at pinned SHA, apply the arm's `CLAUDE.md` block, run `claude -p --output-format json` with `--max-turns` cap, capture full per-turn `usage`, run the acceptance gate (with flake re-tests), record a structured result row (JSONL). Arm order randomized; cache isolation enforced. Idempotent and resumable.

---

## 11. Out of scope for v1 (candidate Tier C follow-ups)

A second agent harness (e.g. aider) on a task subset to blunt "it's just a Claude Code artifact"; section-level ablations of `context.md` (which section carries the effect); the C′ pointer-to-empty arm; staleness / messy-repo strata; per-language forest plots; a funded independent replication with a published fixed-cost reproduction recipe. Several are cheap insurance and may be promoted at pilot sizing.

---

## 12. Residual risks — to be disclosed plainly in the blog lede, not buried

1. Vendor-run benchmark: VibeDrift selects the repos, authors the harness, and runs it; pre-registration + open data reduce but cannot remove this, and few will spend the metered budget to replicate.
2. Scope is one harness (Claude Code headless) and one model generation; may not transfer to Cursor/aider/Codex or to interactive, human-steered sessions.
3. Exact reproduction has a shelf life tied to model retirement and alias drift; only artifact-level auditability (raw per-run logs) persists after the pinned model is deprecated.
4. No run-to-run determinism (no seed/temperature control); the result is a distribution shift with irreducible residual variance.
5. Generalization rests on ~6–8 repo clusters; inference targets the sampled population, and per-language claims are not identifiable at this scale.
6. The effect is conditional on freshly-generated `context.md` on repos with coherent conventions, and on the realized quality of those particular files; stale or low-quality `context.md` may not help or may hurt unless a staleness/messy stratum is added.
7. `context.md` is a CLI side-artifact (`--write-context` + the new auto-inject), distinct from the in-loop MCP tools the product is principally sold on; the measured effect must not be generalized to "VibeDrift" as a whole.
8. The VibeDrift drift/convention-match secondary is circular and descriptive only.

---

## 13. Reproducibility / pre-registration package

Before the confirmatory batch: a **timestamped pre-registration** (this protocol, frozen) committed/tagged. Published with results: harness code, Docker image, task definitions + selection funnel, repo SHAs, exact prompts and `CLAUDE.md` blocks, per-run transcripts and `usage` logs, raw cost data, the frozen analysis script, exact model ID + Claude Code version + pricing-snapshot date, and 1–2 representative generated `context.md` artifacts.

---

## 14. Decisions resolved / still open

**Resolved:** paradigm (controlled benchmark); corpus (diverse OSS, real-PR convention tasks + negative controls); primary endpoint (cost-to-pass, joint with success rate); harness (Claude Code headless); rigor (Tier B, 3-arm with wrong-repo placebo); treatment fidelity (ship auto-inject, inline content); path (staged, pilot-gated spend, Fly).

**Open (to settle in the implementation plan / at pilot sizing):** exact repo list + SHAs; exact PR-sampling rule and N; the pinned model ID; R (replicates) vs K (tasks) split; the dollar MEI; caching mode (cold vs warm); which optional arms (Section 11) to include; the non-inferiority margin.

---

## 15. Next step

Hand this spec to the writing-plans skill to produce the ordered implementation plan: (Phase 0) ship auto-inject; (Phase 1) build + locally smoke-test the harness; (Phase 2) expanded pilot + variance/feasibility report; (Phase 3) freeze pre-registration + analysis script; (Phase 4) gated confirmatory run on Fly; (Phase 5) analysis + blog with residual risks in the lede.
