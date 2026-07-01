# Curating tasks for the MCP drift-quality experiment

Tasks live as `fixtures/tasks/<id>.json` (one TaskSpec each). The harness only
loads `tasks/*.json`, so `task.example.json` here is a TEMPLATE and is NOT run.

A task is only valid if it satisfies all three of these, each VERIFIED before use:

1. **Correctness gate exists.** The task carries the merged PR's own tests
   (`applyTestsPatch` + `gateTestCmd`), and the base repo at the pinned SHA
   builds and those tests FAIL before the change and PASS on the merged code.
2. **Drift headroom.** There is a real opportunity to drift (an existing helper
   to reuse, an established naming / error / import pattern). Confirm by running
   the Control arm: if an unaided agent never drifts on this task, discard it —
   there is no room for the MCP to help.
3. **Ground truth.** `conventionTargets` lists the concrete "native" choices the
   merged PR actually made (which helper it reused, which naming/error/import
   style), each grounded in the repo. This is what the blinded judge scores.

## Verification checklist (do this per task, do not skip)

- [ ] `git clone` the repo at the pinned `sha`; run `setupCmd`; confirm it builds.
- [ ] Confirm `gateTestCmd` passes on the merged implementation and fails on base.
- [ ] Confirm `applyTestsPatch` applies cleanly to the base SHA.
- [ ] Write `conventionTargets` from the ACTUAL merged diff (not from a guess).
- [ ] Sanity-check there is a tempting wrong way (a drift opportunity) the agent
      could take, so Control can plausibly drift.

## Honesty rule (audit-first)

Do not commit a task to `tasks/` until every box above is checked against the
real repo. An unverified task silently corrupts the result. `task.example.json`
is illustrative only and has NOT been verified against remeda.
