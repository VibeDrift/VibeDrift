# MCP Drift-Quality Experiment — Status, Spend Projection, and Gate

Date: 2026-06-29. Design: `docs/superpowers/specs/2026-06-29-mcp-drift-quality-experiment-design.md`.

## TOKEN PILOT RESULT (2026-06-29, 6 runs, subscription quota, ~$12.50 cost-equiv)

C-vs-T token A/B on one task (remeda `hasProp`), 3 reps each, `--strict-mcp-config`
(Control = zero MCP, Treatment = vibedrift only). All 6 passed the gate; every T
run used the MCP (3-5 calls).

- Mean total tokens: **T (MCP) 1,579,092 vs C (no MCP) 1,738,641 -> T ~9% lower.** Mean cost-equiv: T $2.09 vs C $2.41 (~13% lower).
- Paired by replicate (T-C): r0 -21.8%, r1 +17.0%, r2 -14.7%. **2 of 3 favor the MCP; one flipped.** Mean paired diff -9.2%.
- **The mean advantage is fragile:** it is driven mostly by ONE expensive Control run (r0 = 2.09M). Drop it and C averages ~1.56M, basically tied with T.
- **More robust signal = variance:** T spread is tight (sd 64k) vs C wide (sd 293k). The MCP appears to prevent the expensive over-exploration tail (tokens are ~95% cache-read, i.e. how much code the agent pulled in). Whether that tail effect is real needs more data.

Verdict: hypothesis is ALIVE but the effect is small (~10%) and noisy at n=3 on one task; not conclusive. Next step is an intermediate expansion (a few more tasks, ~5 reps) before any hundreds-of-dollars confirmatory run. Raw rows: `eval/context-token-benchmark/pilot-results.jsonl`.

## What is BUILT and VALIDATED (free, no metered spend)

The existing `context-token-benchmark` harness (a working C/T MCP cost A/B with a
validated `claude -p` usage parser, gate, and orchestrator) was extended into a
drift-quality experiment:

- **3 arms** (`Arm = C | P | T`): Control, Instruction-only (nudge, no MCP), Treatment (nudge + MCP). Primary contrast T-vs-P.
- **Blinded diff capture** (`captureDiff`): the agent's source diff with `.mcp.json`, the injected CLAUDE.md directive, `.vibedrift/`, and the task's tests excluded. Verified against a real git repo — the judged diff leaks no arm signal and the working tree stays intact for the gate.
- **Blinded convention judge** (`judge.ts`, `judge-real.ts`): an N-judge panel scores each diff against per-task ground-truth `conventionTargets`; pure logic unit-tested, metered `claude -p` boundary isolated.
- **Drift analysis** (`analyze-drift.ts`): per-arm pass rate + mean drift, MCP-fidelity (degenerate-T) diagnostics, and task-clustered T-P / T-C / P-C contrasts with a seeded (reproducible) cluster bootstrap CI.
- **CLIs**: `dist/cli.js` (run, metered), `dist/judge-cli.js` (judge, metered), `dist/analyze-cli.js` (analyze, free).
- **Gates**: 110 unit tests pass; typecheck + build clean. An **end-to-end dry run** (`test/dry-run.test.ts`) drives the real orchestrate -> capture -> judge -> analyze pipeline with faked metered boundaries and recovers a planted T<P<C effect (primary T-P = -0.500, CI entirely < 0).
- Fixed a latent build-path bug (compiled CLI now resolves `fixtures/` correctly).

**Mechanism probe (free, live MCP on this harness):** `get_dominant_pattern(naming)` -> `camelCase`, 82% consistent; `find_similar_function` on a `mean` body -> found the real duplicate in `analyze-drift.ts` AND `judge.ts` (0.919). The MCP returns concrete, arm-distinguishing signal the no-MCP arms would have to find by hand.

## What is NOT done (the remaining path to an empirical result)

1. **Curated, VERIFIED tasks.** `fixtures/tasks/` already holds one pre-curated task (`remeda-1`: add `hasProp` to remeda, with a real `hasProp.test.ts` patch at `fixtures/patches/remeda-1-tests.patch`) — enough to run a token A/B, though it lacks `conventionTargets` (needed only for the drift study, not the token comparison). A second patch (`kong-1-tests.patch`) exists but has no task JSON / repo entry yet. Scaling to the full pilot still needs several more tasks, each run through the TASKS.md checklist against the real repo (base builds, PR tests gate, patch applies, conventionTargets from the actual merged diff, Control-drifts headroom check). This is careful work, not fakeable.
2. **One live calibration run.** The harness's full `claude -p` coding-task path has never actually executed (only the usage parser was validated on a short call). One real run is needed to (a) ground per-run cost and (b) confirm the live path + captureDiff-on-real-clone + the usage parser's long-run/compaction branches.
3. **Freeze pre-reg §9** (judge model + N, max-turns, effect threshold, go/no-go, exclusions).
4. **Top up the Claude balance** (not API-queryable) and run on **Fly**, not the laptop.

## Spend projection (Opus 4.8, validated rates: $5 in / $25 out / $6.25 cache-write / $0.50 cache-read per MTok)

Per-run cost is genuinely **uncertain** until one real run is measured. A real coding
session over up to 30 turns plausibly runs **$1-4** (the validated short non-task
call was $0.05; a real task with exploration + edits is much larger). Judge calls are
single-shot, **~$0.02-0.05** each.

| Stage | Agent runs | Judge calls | Est. spend (plan / range) |
|---|---|---|---|
| Calibration (1 task x 3 arms) | 3 | ~9 | **~$8** ($5-15) |
| Pilot (5 tasks x 3 arms x 3 trials) | 45 | <=135 | **~$115** ($50-190) |
| Confirmatory (30 tasks x 3 arms x 5 trials) | 450 | <=1350 | **~$1,200** ($700-1,900) |

## Recommended gate sequence

1. **Calibration run first (~$8).** Cheapest way to replace the per-run estimate with a measured number and validate the never-run live path before committing to 45 runs. Requires 1 verified task + a small top-up.
2. Reprice the pilot from the calibration, freeze pre-reg §9, top up, run the pilot on Fly.
3. Gate the confirmatory run on the pilot's signal + variance.

Nothing metered runs without explicit per-message approval + a confirmed top-up.
