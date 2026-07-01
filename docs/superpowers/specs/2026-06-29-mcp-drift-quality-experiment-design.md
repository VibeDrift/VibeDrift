# MCP Drift-Quality Experiment — Design + Pre-Registration (DRAFT)

Date: 2026-06-29
Status: DRAFT. The pilot may run once the spend gate is cleared; the confirmatory run is gated on freezing the decision rules in section 9 after the pilot.
Location: extends `eval/context-token-benchmark/` in `vibedrift-public` (the harness is already an MCP A/B; we add the drift-quality outcome layer rather than duplicate it).

## 1. Question and claim

Does giving an AI coding agent VibeDrift's MCP make it write code that drifts less from a repository's established conventions?

Primary claim (H1): *An agent given the VibeDrift MCP and instructed to use it produces code that adheres more closely to a repository's established conventions than the same agent given only an instruction to follow those conventions, among solutions that pass the task's own tests.*

This is deliberately a hard claim: the comparator is a motivated, explicitly-instructed agent, not a strawman, and the metric is adherence among *working* solutions, not raw output.

What this is NOT: it is not a token-savings claim. The MCP adds a fixed token tax (tool schemas) and per-call tokens; cost is reported only as a secondary, honestly-framed endpoint. It is also scoped to the MCP, not to "VibeDrift" as a product.

## 2. Arms (within-task, fresh clone per trial)

- C — Control. The bare task prompt. No MCP, no nudge. Establishes that the task has drift headroom (an unaided agent actually does drift).
- P — Instruction-only (active placebo). The task plus a nudge telling the agent to reuse existing code, search the codebase for similar functions before writing new ones, and match the repo's conventions for naming, error handling, and imports. No MCP, no baseline warming. This is the strong baseline.
- T — Treatment. The same nudge, plus `.mcp.json` attaching the `vibedrift mcp` server and a warmed local baseline, with the nudge naming the MCP tools to call.

Design note on the contrast. The MCP gives the agent two things: the information (dominant patterns, similar functions) and the affordance (one tool call instead of reading many files). The P agent can still obtain the same information by exploring the repo by hand; it just has to work for it. T-vs-P therefore measures the *net* effect of the tool (information plus ease) over a motivated-but-unaided agent. That is the realistic "with the tool vs without it" question, and it is reported as such.

## 3. Primary endpoint and contrasts

- Primary endpoint: a per-run convention-adherence drift score from a blinded judge panel (section 5), computed ONLY among runs that pass the task gate (section 4). Lower = less drift = better.
- Primary contrast: T minus P (the MCP's marginal effect over the nudge).
- Secondary contrasts: T minus C and P minus C, to decompose the nudge effect from the MCP effect.
- Reported alongside, never hidden: pass rate per arm (so no arm can "win" on drift by doing nothing), MCP-usage rate in T, and USD cost per arm.

## 4. Validity gates

- Correctness gate. Each task carries the merged PR's own tests, reasserted after the agent runs (so the agent cannot weaken them). Drift is scored only among runs that pass. Pass rate is reported per arm separately.
- Headroom. A task is only informative if the Control arm sometimes drifts. Tasks where C never drifts across its trials are excluded by a pre-registered rule (section 9), because there is no room for the MCP to help.
- Treatment fidelity. A T run where the agent made zero `mcp__vibedrift__*` tool calls is degenerate. We report the MCP-usage rate, analyze as-randomized (intention-to-treat) as primary, and report a per-protocol secondary excluding zero-tool T runs.

## 5. Outcome instrument — blinded convention judge

The instrument is independent of VibeDrift's own detectors, to avoid the "grading its own homework" circularity. We never use VibeDrift's drift scan as the primary metric (only as an optional secondary cross-check).

- Ground truth. Each task is annotated with `conventionTargets`: concrete, checkable expectations derived from the real merged PR (for example: "reuses the existing `X` helper rather than reimplementing it"; "follows the `Result<T>`-style error return"; "matches the `xHandler` naming"; "uses the repo's import style"). Each target names an axis (reuse, naming, error-handling, imports, or other) and a rationale grounded in the repo.
- Blinding. The judge sees only the agent's source diff with all harness artifacts stripped (`.mcp.json`, the CLAUDE.md directive block, `.vibedrift/`, and the test patch). The diff carries no signal of which arm produced it. Arm labels are never shown.
- Panel. N independent judges (pre-registered; default 3) each score every target on a fixed scale (0 = violates, 1 = partial, 2 = matches) plus one holistic "fits the surrounding codebase" score. The judge model, rubric, and temperature are pinned in section 9. The judge model should differ from or be independent of the agent model to limit self-preference.
- Aggregation. Per-run drift score = mean over targets of (2 - adherence), averaged across judges (higher = more drift). Inter-judge agreement is reported. A human spot-checks a sample to validate the judge against human ratings.

## 6. Statistics

- Replication absorbs stochasticity: multiple trials per (task, arm).
- Clustering: observations are clustered by task; the primary effect (mean T-minus-P drift difference among passers) is estimated with a cluster bootstrap over tasks, reusing the analysis approach already in `analysis/analyze.py`.
- Pilot is for machinery validation and a directional signal and a variance estimate; it is not powered. The confirmatory n is computed from the pilot variance before the confirmatory run.

## 7. Procedure (per run)

Fresh clone at pinned SHA -> setup -> arm config (P/T write the nudge; T also writes `.mcp.json` and warms the local baseline) -> apply the PR test patch -> run `claude -p` (metered) -> capture the agent's blinded source diff -> reassert canonical tests -> run the acceptance gate. The judge runs as a separate, later, blinded pass over the stored diffs.

## 8. Staging and spend

Staged, mirroring the prior experiment. Build the rig (free) -> validate end to end with injected fakes (free) -> pilot (metered, gated on a real projection plus a balance top-up, run on Fly) -> freeze section 9 -> confirmatory run (metered, gated, on Fly). The balance is not API-queryable, so a top-up precedes any metered launch, and projected spend is stated before launching.

## 9. To freeze before the confirmatory run (decision rules)

Pinned model id; judge model, rubric, scale, panel size N, and temperature; max-turns; primary endpoint (drift among passers) and primary contrast (T-P); the minimum meaningful drift reduction (effect threshold) and the go / no-go rule; exclusion rules (headroom, flaky gate, degenerate T handling); and the confirmatory n derived from pilot variance.

## 10. Honest risks (these go in the writeup)

1. The marginal effect over a strong P arm may be small or null. Frontier agents already read the codebase and match conventions well when told to. A null is a real, reportable outcome.
2. The MCP can mislead. If it surfaces a wrong dominant pattern on some repo, T may drift more there. Reported if it happens.
3. Judge reliability is itself a risk; it is validated by inter-judge agreement and a human spot-check before any claim.
4. Blinding can leak if the agent writes VibeDrift-flavored comments in its diff. Mitigation: strip obvious tells; otherwise note as a limitation.
5. The secondary cost story is nuanced, not heroic. The likely shape is "the MCP costs somewhat more in-session but yields lower drift," which is the honest framing.
