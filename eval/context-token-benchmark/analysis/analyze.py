"""
PRE-REGISTERED FROZEN ANALYSIS SCRIPT — context.md token-savings benchmark.

This script implements the statistical analysis plan described in:
  docs/superpowers/specs/2026-06-26-context-md-token-savings-experiment-design.md (§6, §8)
  docs/superpowers/plans/2026-06-26-context-md-token-experiment.md (Phase 3)

DO NOT EDIT after the pre-registration freeze. The NI margin (default 0.05) and bootstrap
replications (default B=2000) are parameters set at freeze time; they must not be tuned on
confirmatory data. Run on confirmatory JSONL only — this script is the sole source of the
headline numbers in the blog.

Primary estimand (unconditional, collider-safe):
    expected_cost_per_pass(arm) = sum(costUsd, ALL runs in arm)
                                  -----------------------------------------------
                                  count(passed runs in arm)

This folds in failures and censored runs WITHOUT conditioning on success, avoiding the
collider bias that afflicts naive conditional-on-success cost comparisons.

Headline ratios: ratio(T, C) and ratio(T, P) = expected_cost_per_pass(T) / expected_cost_per_pass(comparator).
A ratio < 1 means T is cheaper per passing solution.

Cluster bootstrap: resample *taskIds* with replacement (tasks are the experimental unit of
replication; runs within a task are clustered). B=2000 by default.

Usage:
    python analyze.py <results.jsonl> [repos.json]

Input JSONL fields per row:
    runId, repoId, taskId, arm ("C"|"P"|"T"), replicate,
    costUsd (float), passed (bool), censored (bool), competingFailure (bool),
    modelId, compactionEvents, durationMs

Optional repos.json: { "<repoId>": { "postCutoff": true|false }, ... }
"""

from __future__ import annotations

import json
import sys
import warnings
from typing import Optional

import numpy as np
import pandas as pd


# ---------------------------------------------------------------------------
# Primary estimand
# ---------------------------------------------------------------------------


def expected_cost_per_pass(df: pd.DataFrame, arm: str) -> float:
    """Unconditional expected cost to obtain one passing solution for the given arm.

    Numerator = sum of costUsd over ALL runs (including failures and censored runs).
    Denominator = count of passing runs.

    Returns float('inf') if no passing runs exist.
    """
    arm_df = df[df["arm"] == arm]
    total_cost = arm_df["costUsd"].sum()
    n_pass = int(arm_df["passed"].sum())
    if n_pass == 0:
        return float("inf")
    return float(total_cost) / n_pass


def bootstrap_ratio(
    df: pd.DataFrame,
    armT: str,
    armComp: str,
    n_boot: int = 2000,
    rng: Optional[np.random.Generator] = None,
) -> dict:
    """Cluster-bootstrapped ratio of expected_cost_per_pass(armT) / expected_cost_per_pass(armComp).

    Clustering unit: taskId (tasks are resampled with replacement; all runs for a sampled task
    are included). This correctly accounts for within-task correlation.

    Returns a dict with keys: point, ci_lower, ci_upper, n_boot_used.
    A ratio < 1 means armT is cheaper per passing solution.
    """
    if rng is None:
        rng = np.random.default_rng()

    point_est = expected_cost_per_pass(df, armT) / expected_cost_per_pass(df, armComp)

    task_ids = df["taskId"].unique()
    n_tasks = len(task_ids)

    boot_ratios: list[float] = []
    for _ in range(n_boot):
        sampled = rng.choice(task_ids, size=n_tasks, replace=True)
        # Gather all runs for the resampled task set (tasks may appear multiple times)
        parts = [df[df["taskId"] == t] for t in sampled]
        boot_df = pd.concat(parts, ignore_index=True)
        r = expected_cost_per_pass(boot_df, armT) / expected_cost_per_pass(boot_df, armComp)
        if np.isfinite(r):
            boot_ratios.append(r)

    n_boot_used = len(boot_ratios)
    if n_boot_used < 0.99 * n_boot:
        drop_frac = (n_boot - n_boot_used) / n_boot
        warnings.warn(
            f"bootstrap_ratio: {n_boot - n_boot_used}/{n_boot} bootstrap draws "
            f"({drop_frac:.1%}) dropped due to non-finite ratio.",
            UserWarning,
            stacklevel=2,
        )

    arr = np.array(boot_ratios)
    ci_lower = float(np.percentile(arr, 2.5)) if len(arr) else float("nan")
    ci_upper = float(np.percentile(arr, 97.5)) if len(arr) else float("nan")

    return {
        "point": point_est,
        "ci_lower": ci_lower,
        "ci_upper": ci_upper,
        "n_boot_used": n_boot_used,
    }


# ---------------------------------------------------------------------------
# Success rate + non-inferiority
# ---------------------------------------------------------------------------


def success_rate(df: pd.DataFrame, arm: str) -> float:
    """Fraction of runs in arm that passed (passes / total runs). 0.0 if no runs."""
    arm_df = df[df["arm"] == arm]
    if len(arm_df) == 0:
        return 0.0
    return float(arm_df["passed"].sum()) / len(arm_df)


def ni_success(
    df: pd.DataFrame,
    armT: str,
    armComp: str,
    margin: float,
    n_boot: int = 2000,
    rng: Optional[np.random.Generator] = None,
) -> dict:
    """Non-inferiority test: T is non-inferior on success rate iff the upper bound of the
    cluster-bootstrapped 95% CI on (rate_comp - rate_T) is <= margin.

    A positive difference means T's success rate is lower than the comparator.
    Non-inferiority holds when even the worst-case plausible difference is within margin.

    Returns: dict with ni (bool), diff_point, diff_ci_lower, diff_ci_upper, margin.
    """
    if rng is None:
        rng = np.random.default_rng()

    diff_point = success_rate(df, armComp) - success_rate(df, armT)

    task_ids = df["taskId"].unique()
    n_tasks = len(task_ids)

    boot_diffs: list[float] = []
    for _ in range(n_boot):
        sampled = rng.choice(task_ids, size=n_tasks, replace=True)
        parts = [df[df["taskId"] == t] for t in sampled]
        boot_df = pd.concat(parts, ignore_index=True)
        boot_diffs.append(success_rate(boot_df, armComp) - success_rate(boot_df, armT))

    arr = np.array(boot_diffs)
    ci_lower = float(np.percentile(arr, 2.5))
    ci_upper = float(np.percentile(arr, 97.5))

    return {
        "ni": bool(ci_upper <= margin),
        "diff_point": diff_point,
        "diff_ci_lower": ci_lower,
        "diff_ci_upper": ci_upper,
        "margin": margin,
    }


# ---------------------------------------------------------------------------
# Secondary estimators
# ---------------------------------------------------------------------------


def arithmetic_mean_cost_ratio(
    df: pd.DataFrame,
    armT: str,
    armComp: str,
    n_boot: int = 2000,
    rng: Optional[np.random.Generator] = None,
) -> dict:
    """SECONDARY: ratio of arithmetic mean(costUsd) among PASSING runs only, with cluster-
    bootstrap CI. Reported alongside the per-pass headline as supporting evidence.

    Note: this IS a conditional-on-success estimator and should NOT be used as the headline
    (it is subject to the collider described in the spec). Its value is as a cross-check on
    the magnitude of the per-unit-cost difference among successful attempts.

    Label: SECONDARY: arithmetic-mean cost ratio (passing runs only, conditional-on-success)
    """
    if rng is None:
        rng = np.random.default_rng()

    def _ratio(d: pd.DataFrame) -> float:
        t_costs = d[(d["arm"] == armT) & d["passed"]]["costUsd"]
        c_costs = d[(d["arm"] == armComp) & d["passed"]]["costUsd"]
        if len(t_costs) == 0 or len(c_costs) == 0:
            return float("inf")
        return float(t_costs.mean()) / float(c_costs.mean())

    point_est = _ratio(df)

    task_ids = df["taskId"].unique()
    n_tasks = len(task_ids)

    boot_ratios: list[float] = []
    for _ in range(n_boot):
        sampled = rng.choice(task_ids, size=n_tasks, replace=True)
        parts = [df[df["taskId"] == t] for t in sampled]
        boot_df = pd.concat(parts, ignore_index=True)
        r = _ratio(boot_df)
        if np.isfinite(r):
            boot_ratios.append(r)

    n_boot_used = len(boot_ratios)
    if n_boot_used < 0.99 * n_boot:
        drop_frac = (n_boot - n_boot_used) / n_boot
        warnings.warn(
            f"arithmetic_mean_cost_ratio: {n_boot - n_boot_used}/{n_boot} bootstrap draws "
            f"({drop_frac:.1%}) dropped due to non-finite ratio.",
            UserWarning,
            stacklevel=2,
        )

    arr = np.array(boot_ratios)
    ci_lower = float(np.percentile(arr, 2.5)) if len(arr) else float("nan")
    ci_upper = float(np.percentile(arr, 97.5)) if len(arr) else float("nan")

    return {
        "point": point_est,
        "ci_lower": ci_lower,
        "ci_upper": ci_upper,
        "label": "SECONDARY: arithmetic-mean cost ratio (passing runs only, conditional-on-success)",
    }


def geom_mean_paired_logratio(
    df: pd.DataFrame,
    armT: str,
    armComp: str,
    n_boot: int = 2000,
    rng: Optional[np.random.Generator] = None,
) -> dict:
    """SECONDARY (CONDITIONAL-ON-SUCCESS): geometric-mean paired log-cost ratio.

    Per task: compute mean(log costUsd) for armT and armComp among PASSING runs.
    Overall: ratio = exp(mean over tasks of [meanlog_T - meanlog_comp]).
    Tasks where either arm has no passing runs are skipped.

    This is the location parameter of the paired log-cost distribution. It can diverge from
    the arithmetic headline due to Jensen's inequality — report both.

    Bootstrap: precompute each task's logratio as a scalar, then for each draw resample
    task IDs with replacement and average the precomputed logratios of the sampled IDs
    (a task drawn k times counts k times). This correctly respects cluster multiplicity;
    calling .unique() on the resampled task list would degenerate the bootstrap into a
    presence/absence draw and understate the CI width.

    Label: SECONDARY (CONDITIONAL-ON-SUCCESS): geometric-mean paired log-cost ratio
    """
    if rng is None:
        rng = np.random.default_rng()

    # Precompute per-task logratio scalars from the full (non-resampled) dataset.
    # These are the point contributions; bootstrap resampling weights them by multiplicity.
    task_logratios: dict[str, float] = {}
    for tid in df["taskId"].unique():
        task_df = df[df["taskId"] == tid]
        t_costs = task_df[(task_df["arm"] == armT) & task_df["passed"]]["costUsd"]
        c_costs = task_df[(task_df["arm"] == armComp) & task_df["passed"]]["costUsd"]
        if len(t_costs) == 0 or len(c_costs) == 0:
            continue
        # Exclude zero/negative costs which would break log
        t_pos = t_costs[t_costs > 0]
        c_pos = c_costs[c_costs > 0]
        if len(t_pos) == 0 or len(c_pos) == 0:
            continue
        lr = float(np.log(t_pos).mean()) - float(np.log(c_pos).mean())
        task_logratios[tid] = lr

    if not task_logratios:
        return {
            "point": float("inf"),
            "ci_lower": float("nan"),
            "ci_upper": float("nan"),
            "n_tasks_with_data": 0,
            "label": "SECONDARY (CONDITIONAL-ON-SUCCESS): geometric-mean paired log-cost ratio",
        }

    logratios = np.array(list(task_logratios.values()))
    point_est = float(np.exp(logratios.mean()))

    task_ids = df["taskId"].unique()
    n_tasks = len(task_ids)

    boot_geomeans: list[float] = []
    for _ in range(n_boot):
        sampled = rng.choice(task_ids, size=n_tasks, replace=True)
        # Multiplicity-correct: collect the precomputed logratio for each sampled ID.
        # A task drawn k times contributes its logratio k times to the mean.
        # Tasks with no eligible data (both arms need passing runs) are skipped.
        boot_lrs = [task_logratios[t] for t in sampled if t in task_logratios]
        if boot_lrs:
            boot_geomeans.append(float(np.exp(np.mean(boot_lrs))))

    n_boot_used = len(boot_geomeans)
    if n_boot_used < 0.99 * n_boot:
        drop_frac = (n_boot - n_boot_used) / n_boot
        warnings.warn(
            f"geom_mean_paired_logratio: {n_boot - n_boot_used}/{n_boot} bootstrap draws "
            f"({drop_frac:.1%}) dropped due to no eligible tasks in the resample.",
            UserWarning,
            stacklevel=2,
        )

    arr = np.array(boot_geomeans)
    ci_lower = float(np.percentile(arr, 2.5)) if len(arr) else float("nan")
    ci_upper = float(np.percentile(arr, 97.5)) if len(arr) else float("nan")

    return {
        "point": point_est,
        "ci_lower": ci_lower,
        "ci_upper": ci_upper,
        "n_tasks_with_data": int(len(logratios)),
        "label": "SECONDARY (CONDITIONAL-ON-SUCCESS): geometric-mean paired log-cost ratio",
    }


# ---------------------------------------------------------------------------
# Fixed-sequence gatekeeping
# ---------------------------------------------------------------------------


def gatekeeping(
    df: pd.DataFrame,
    ni_margin: float,
    n_boot: int = 2000,
    rng: Optional[np.random.Generator] = None,
) -> dict:
    """Fixed-sequence intersection-union gatekeeping decision.

    The overall published claim holds iff BOTH contrasts (T-vs-P AND T-vs-C) satisfy:
      1. non-inferiority on success rate (ni_success True), AND
      2. the per-pass cost-ratio bootstrap 95% CI upper bound < 1 (cost reduction with CI
         strictly excluding 1).

    Multiplicity: conservative intersection-union at 0.05 each — no alpha correction needed.

    Returns a dict with per-contrast booleans and the overall_win verdict.
    """
    if rng is None:
        rng = np.random.default_rng()

    results: dict = {}
    overall = True

    for armComp, label in [("P", "T_vs_P"), ("C", "T_vs_C")]:
        ni = ni_success(df, "T", armComp, ni_margin, n_boot=n_boot, rng=rng)
        ratio = bootstrap_ratio(df, "T", armComp, n_boot=n_boot, rng=rng)

        cost_reduction_ci_excludes_1 = (
            np.isfinite(ratio["ci_upper"]) and ratio["ci_upper"] < 1.0
        )
        contrast_win = bool(ni["ni"]) and cost_reduction_ci_excludes_1

        results[label] = {
            "ni_success": ni["ni"],
            "ni_diff_ci_upper": ni["diff_ci_upper"],
            "ni_margin": ni_margin,
            "ratio_point": ratio["point"],
            "ratio_ci_lower": ratio["ci_lower"],
            "ratio_ci_upper": ratio["ci_upper"],
            "cost_reduction_ci_excludes_1": cost_reduction_ci_excludes_1,
            "contrast_win": contrast_win,
        }
        overall = overall and contrast_win

    results["overall_win"] = overall
    return results


# ---------------------------------------------------------------------------
# Stratum report (contamination moderator)
# ---------------------------------------------------------------------------


def stratum_report(
    df: pd.DataFrame,
    repos_map: dict,
    ni_margin: float,
    n_boot: int = 2000,
    rng: Optional[np.random.Generator] = None,
) -> dict:
    """Split by pretraining-contamination stratum and report the headline ratio per stratum.

    repos_map: { repoId: { "postCutoff": bool, ... }, ... }
    contaminated = postCutoff False (repo was in training data; model may have memorized it).
    fresh        = postCutoff True  (repo/commits created after training cutoff).

    The mechanism (context.md short-circuits exploration) is expected to be stronger in the
    fresh stratum where the model cannot rely on memorized knowledge.
    """
    if rng is None:
        rng = np.random.default_rng()

    df = df.copy()
    df["postCutoff"] = df["repoId"].map(
        lambda rid: repos_map.get(rid, {}).get("postCutoff", None)
    )

    report: dict = {}
    for stratum_name, flag in [("contaminated_pre_cutoff", False), ("fresh_post_cutoff", True)]:
        stratum_df = df[df["postCutoff"] == flag]
        if len(stratum_df) == 0:
            report[stratum_name] = {"note": "no data in this stratum"}
            continue

        stratum_result: dict = {}
        for armComp, label in [("P", "T_vs_P"), ("C", "T_vs_C")]:
            stratum_result[label] = bootstrap_ratio(
                stratum_df, "T", armComp, n_boot=n_boot, rng=rng
            )
        stratum_result["success_rate_T"] = success_rate(stratum_df, "T")
        stratum_result["success_rate_C"] = success_rate(stratum_df, "C")
        stratum_result["success_rate_P"] = success_rate(stratum_df, "P")
        report[stratum_name] = stratum_result

    return report


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    """Read a JSONL results file and optional repos.json; print a JSON report of all estimators."""
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {"error": "Usage: python analyze.py <results.jsonl> [repos.json]"}
            ),
            flush=True,
        )
        sys.exit(1)

    results_path = sys.argv[1]
    repos_map: dict = {}
    if len(sys.argv) >= 3:
        with open(sys.argv[2]) as fh:
            repos_map = json.load(fh)

    rows: list[dict] = []
    with open(results_path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))

    df = pd.DataFrame(rows)

    # Fixed seed for reproducibility of the confirmatory run's report
    rng = np.random.default_rng(42)

    report: dict = {
        "headline": {},
        "secondary": {},
        "success_rates": {arm: success_rate(df, arm) for arm in ["C", "P", "T"]},
        "expected_cost_per_pass": {
            arm: expected_cost_per_pass(df, arm) for arm in ["C", "P", "T"]
        },
    }

    for armComp, label in [("P", "T_vs_P"), ("C", "T_vs_C")]:
        rng_sub = np.random.default_rng(rng.integers(2**31))
        report["headline"][label] = bootstrap_ratio(df, "T", armComp, n_boot=2000, rng=rng_sub)

    for armComp, label in [("P", "T_vs_P"), ("C", "T_vs_C")]:
        rng_sub = np.random.default_rng(rng.integers(2**31))
        report["secondary"][f"{label}_arith_mean"] = arithmetic_mean_cost_ratio(
            df, "T", armComp, n_boot=2000, rng=rng_sub
        )
        rng_sub2 = np.random.default_rng(rng.integers(2**31))
        report["secondary"][f"{label}_geom_mean"] = geom_mean_paired_logratio(
            df, "T", armComp, n_boot=2000, rng=rng_sub2
        )

    report["gatekeeping"] = gatekeeping(df, ni_margin=0.05, n_boot=2000, rng=rng)

    if repos_map:
        report["stratum_report"] = stratum_report(
            df, repos_map, ni_margin=0.05, n_boot=2000, rng=rng
        )

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
