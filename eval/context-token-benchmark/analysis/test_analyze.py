"""
Tests for analyze.py — all run on SIMULATED data with known ground truth.

No real experiment data exists yet. The purpose of these tests is to validate the
statistical estimators against scenarios where the answer is known by construction,
so the frozen script can be committed with confidence before any metered run.

Test inventory:
  1. Known effect recovered      — T costs ~0.80x C and P; bootstrap CIs exclude 1.
  2. Null (no effect)            — all arms same; gatekeeping does NOT declare a win.
  3. Collider guard              — naive conditional-on-success hides the bias;
                                   expected_cost_per_pass is not fooled.
  4. Arithmetic exact            — hand-built tiny dataset; exact assertion on the estimand.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analyze import (
    arithmetic_mean_cost_ratio,
    bootstrap_ratio,
    expected_cost_per_pass,
    gatekeeping,
    geom_mean_paired_logratio,
    ni_success,
    success_rate,
    stratum_report,
)

# ---------------------------------------------------------------------------
# Simulation helpers
# ---------------------------------------------------------------------------

N_BOOT_TEST = 2000  # enough for stable CIs; same as production default


def _make_rng(seed: int = 0) -> np.random.Generator:
    return np.random.default_rng(seed)


def _simulate_runs(
    n_tasks: int,
    n_replicates: int,
    cost_multipliers: dict[str, float],  # arm -> multiplier vs baseline
    success_rates: dict[str, float],     # arm -> P(pass)
    base_cost_loc: float = 0.20,
    base_cost_scale: float = 0.05,
    rng: np.random.Generator = None,
) -> pd.DataFrame:
    """Simulate a balanced (tasks × replicates × arms) dataset.

    Costs are drawn from a lognormal: log(cost) ~ N(log(base * mult), sigma).
    Pass/fail is drawn Bernoulli(success_rate[arm]).
    censored and competingFailure are always False in these simulations.
    """
    if rng is None:
        rng = _make_rng()

    rows = []
    arm_list = list(cost_multipliers.keys())

    for task_idx in range(n_tasks):
        task_id = f"task-{task_idx:03d}"
        repo_id = f"repo-{task_idx % 3:01d}"  # spread across 3 repos

        for arm in arm_list:
            mult = cost_multipliers[arm]
            p_pass = success_rates[arm]

            for rep in range(n_replicates):
                mu = np.log(base_cost_loc * mult)
                cost = float(rng.lognormal(mean=mu, sigma=base_cost_scale))
                passed = bool(rng.random() < p_pass)

                rows.append(
                    {
                        "runId": f"{task_id}-{arm}-{rep}",
                        "repoId": repo_id,
                        "taskId": task_id,
                        "arm": arm,
                        "replicate": rep,
                        "costUsd": cost,
                        "passed": passed,
                        "censored": False,
                        "competingFailure": False,
                        "modelId": "claude-test-pinned",
                        "compactionEvents": 0,
                        "durationMs": 1000,
                    }
                )

    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Test 1: Known effect recovered
# ---------------------------------------------------------------------------


class TestKnownEffect:
    """T is 0.80x cheaper than C and P; success rate ~95% across all arms.

    The bootstrap CIs on both ratios should be < 1, and gatekeeping should declare a win.
    """

    @pytest.fixture(scope="class")
    @staticmethod
    def df():
        rng = _make_rng(seed=42)
        return _simulate_runs(
            n_tasks=12,
            n_replicates=5,
            cost_multipliers={"C": 1.0, "P": 1.0, "T": 0.80},
            success_rates={"C": 0.95, "P": 0.95, "T": 0.95},
            base_cost_loc=0.20,
            base_cost_scale=0.08,
            rng=rng,
        )

    def test_ratio_T_vs_C_point_near_0_80(self, df):
        r = bootstrap_ratio(df, "T", "C", n_boot=N_BOOT_TEST, rng=_make_rng(1))
        assert 0.72 <= r["point"] <= 0.88, (
            f"Expected point estimate ~0.80, got {r['point']:.4f}"
        )

    def test_ratio_T_vs_P_point_near_0_80(self, df):
        r = bootstrap_ratio(df, "T", "P", n_boot=N_BOOT_TEST, rng=_make_rng(2))
        assert 0.72 <= r["point"] <= 0.88, (
            f"Expected point estimate ~0.80, got {r['point']:.4f}"
        )

    def test_ratio_T_vs_C_ci_upper_below_1(self, df):
        r = bootstrap_ratio(df, "T", "C", n_boot=N_BOOT_TEST, rng=_make_rng(3))
        assert r["ci_upper"] < 1.0, (
            f"CI upper bound should be < 1 when T is truly cheaper; got {r['ci_upper']:.4f}"
        )

    def test_ratio_T_vs_P_ci_upper_below_1(self, df):
        r = bootstrap_ratio(df, "T", "P", n_boot=N_BOOT_TEST, rng=_make_rng(4))
        assert r["ci_upper"] < 1.0, (
            f"CI upper bound should be < 1 when T is truly cheaper; got {r['ci_upper']:.4f}"
        )

    def test_gatekeeping_declares_win(self, df):
        gate = gatekeeping(df, ni_margin=0.05, n_boot=N_BOOT_TEST, rng=_make_rng(5))
        assert gate["overall_win"] is True, (
            f"Gatekeeping should declare a win with true 20% cost reduction; "
            f"got: {gate}"
        )


# ---------------------------------------------------------------------------
# Test 2: Null (false-positive guard)
# ---------------------------------------------------------------------------


class TestNull:
    """All arms have identical cost distributions and success rates.

    Both ratios should be ~1.0 with CIs straddling 1, and gatekeeping must NOT win.
    """

    @pytest.fixture(scope="class")
    @staticmethod
    def df():
        rng = _make_rng(seed=99)
        return _simulate_runs(
            n_tasks=12,
            n_replicates=5,
            cost_multipliers={"C": 1.0, "P": 1.0, "T": 1.0},
            success_rates={"C": 0.90, "P": 0.90, "T": 0.90},
            base_cost_loc=0.20,
            base_cost_scale=0.10,
            rng=rng,
        )

    def test_ratio_T_vs_C_near_1(self, df):
        r = bootstrap_ratio(df, "T", "C", n_boot=N_BOOT_TEST, rng=_make_rng(10))
        assert 0.85 <= r["point"] <= 1.15, (
            f"Null ratio should be ~1.0; got {r['point']:.4f}"
        )

    def test_ratio_T_vs_P_near_1(self, df):
        r = bootstrap_ratio(df, "T", "P", n_boot=N_BOOT_TEST, rng=_make_rng(11))
        assert 0.85 <= r["point"] <= 1.15, (
            f"Null ratio should be ~1.0; got {r['point']:.4f}"
        )

    def test_ratio_T_vs_C_ci_includes_1(self, df):
        r = bootstrap_ratio(df, "T", "C", n_boot=N_BOOT_TEST, rng=_make_rng(12))
        assert r["ci_lower"] <= 1.0 <= r["ci_upper"], (
            f"Null 95% CI should include 1; got [{r['ci_lower']:.4f}, {r['ci_upper']:.4f}]"
        )

    def test_ratio_T_vs_P_ci_includes_1(self, df):
        r = bootstrap_ratio(df, "T", "P", n_boot=N_BOOT_TEST, rng=_make_rng(13))
        assert r["ci_lower"] <= 1.0 <= r["ci_upper"], (
            f"Null 95% CI should include 1; got [{r['ci_lower']:.4f}, {r['ci_upper']:.4f}]"
        )

    def test_gatekeeping_no_win(self, df):
        gate = gatekeeping(df, ni_margin=0.05, n_boot=N_BOOT_TEST, rng=_make_rng(14))
        assert gate["overall_win"] is False, (
            f"Gatekeeping must NOT declare a win in the null scenario; got: {gate}"
        )


# ---------------------------------------------------------------------------
# Test 3: Collider guard
# ---------------------------------------------------------------------------


class TestColliderGuard:
    """Demonstrate the collider bias and show that expected_cost_per_pass defeats it.

    Scenario:
      - 6 EASY tasks: 3 replicates each, cost ~$0.10/run, all arms pass ~100%.
      - 2 HARD tasks: 3 replicates each, cost ~$1.00/run.
          T passes all hard runs.
          C fails ALL hard runs (passes = 0 for those tasks).

    Naive conditional-on-success mean cost:
      C sees only easy tasks (cheap) => biased low => C looks artificially cheap.

    Unconditional expected_cost_per_pass:
      C must absorb the cost of failing hard runs in its denominator => C is more expensive per pass.
      T's expected_cost_per_pass is lower than C's (T passes more for the same total spend).
    """

    @pytest.fixture(scope="class")
    @staticmethod
    def df_collider():
        rng = _make_rng(seed=777)
        rows = []

        # Easy tasks: all arms pass
        for task_idx in range(6):
            task_id = f"easy-{task_idx:02d}"
            for arm in ["C", "T"]:
                for rep in range(3):
                    cost = float(rng.lognormal(mean=np.log(0.10), sigma=0.05))
                    rows.append(
                        {
                            "runId": f"{task_id}-{arm}-{rep}",
                            "repoId": "repo-easy",
                            "taskId": task_id,
                            "arm": arm,
                            "replicate": rep,
                            "costUsd": cost,
                            "passed": True,  # all pass
                            "censored": False,
                            "competingFailure": False,
                            "modelId": "claude-test",
                            "compactionEvents": 0,
                            "durationMs": 500,
                        }
                    )

        # Hard tasks: T passes, C fails — but C still incurs the cost!
        for task_idx in range(2):
            task_id = f"hard-{task_idx:02d}"
            for arm in ["C", "T"]:
                for rep in range(3):
                    cost = float(rng.lognormal(mean=np.log(1.00), sigma=0.05))
                    passed = (arm == "T")  # T passes hard tasks; C fails all
                    rows.append(
                        {
                            "runId": f"{task_id}-{arm}-{rep}",
                            "repoId": "repo-hard",
                            "taskId": task_id,
                            "arm": arm,
                            "replicate": rep,
                            "costUsd": cost,
                            "passed": passed,
                            "censored": False,
                            "competingFailure": not passed,
                            "modelId": "claude-test",
                            "compactionEvents": 0,
                            "durationMs": 2000,
                        }
                    )

        return pd.DataFrame(rows)

    def test_naive_C_conditional_mean_is_biased_low(self, df_collider):
        """The naive conditional-on-success mean for C is biased below C's true mean per-run cost.

        Because C only passes easy tasks, conditioning on success selects only cheap runs.
        The true unconditional mean cost per run for C includes the expensive failed hard tasks.
        """
        # Naive conditional: mean cost among C's PASSING runs
        c_passing = df_collider[(df_collider["arm"] == "C") & df_collider["passed"]]
        naive_c_conditional_mean = float(c_passing["costUsd"].mean())

        # True unconditional mean cost per run for C (all C runs, passing or not)
        all_c_runs = df_collider[df_collider["arm"] == "C"]
        true_c_unconditional_mean = float(all_c_runs["costUsd"].mean())

        assert naive_c_conditional_mean < true_c_unconditional_mean, (
            f"Naive conditional C mean ({naive_c_conditional_mean:.4f}) should be biased "
            f"below true unconditional C mean ({true_c_unconditional_mean:.4f}). "
            "This is the collider: conditioning on passing selects only cheap runs for C."
        )

    def test_naive_T_vs_C_conditional_makes_C_look_cheaper(self, df_collider):
        """A naive conditional comparison flips the sign: C looks cheaper than T.

        T passes expensive hard tasks too, so its conditional mean includes their costs.
        C's conditional mean omits those costs entirely (C never passes them).
        => naive ratio(T/C) > 1, incorrectly suggesting C is the cheaper arm.
        """
        c_passing_mean = float(
            df_collider[(df_collider["arm"] == "C") & df_collider["passed"]]["costUsd"].mean()
        )
        t_passing_mean = float(
            df_collider[(df_collider["arm"] == "T") & df_collider["passed"]]["costUsd"].mean()
        )
        naive_ratio_T_vs_C = t_passing_mean / c_passing_mean

        assert naive_ratio_T_vs_C > 1.0, (
            f"Naive conditional ratio T/C ({naive_ratio_T_vs_C:.4f}) should be > 1 "
            "(collider makes C look cheaper by excluding its expensive failing runs). "
            "If this fires, the simulation setup needs revisiting."
        )

    def test_expected_cost_per_pass_T_beats_C(self, df_collider):
        """The unconditional estimand (expected_cost_per_pass) correctly shows T < C.

        C's total cost includes the failed hard runs; C gets fewer passes.
        => expected_cost_per_pass(C) > expected_cost_per_pass(T).
        => ratio(T, C) < 1 — T is genuinely cheaper per passing solution.
        """
        ecpp_T = expected_cost_per_pass(df_collider, "T")
        ecpp_C = expected_cost_per_pass(df_collider, "C")

        assert ecpp_T < ecpp_C, (
            f"expected_cost_per_pass(T)={ecpp_T:.4f} should be < C={ecpp_C:.4f}. "
            "The unconditional estimand must not be fooled by the collider."
        )

    def test_expected_cost_per_pass_ratio_below_1(self, df_collider):
        """The headline ratio expected_cost_per_pass(T)/expected_cost_per_pass(C) < 1."""
        ratio = expected_cost_per_pass(df_collider, "T") / expected_cost_per_pass(df_collider, "C")
        assert ratio < 1.0, (
            f"Headline ratio T/C = {ratio:.4f}; expected < 1 (T cheaper per-pass)"
        )


# ---------------------------------------------------------------------------
# Test 4: Arithmetic exact
# ---------------------------------------------------------------------------


class TestArithmeticExact:
    """Hand-built tiny dataset; verify expected_cost_per_pass by hand calculation.

    Dataset:
      task-A, arm C: run-1 cost=$0.50 passed=True,  run-2 cost=$0.30 passed=False
      task-A, arm P: run-1 cost=$0.45 passed=True,  run-2 cost=$0.25 passed=True
      task-A, arm T: run-1 cost=$0.40 passed=True,  run-2 cost=$0.20 passed=True
      task-B, arm C: run-1 cost=$1.00 passed=True,  run-2 cost=$0.80 passed=True
      task-B, arm P: run-1 cost=$0.90 passed=False, run-2 cost=$0.70 passed=True
      task-B, arm T: run-1 cost=$0.60 passed=True,  run-2 cost=$0.50 passed=True

    Manual calculation:
      C: total_cost = 0.50+0.30+1.00+0.80 = 2.60; n_pass = 1+2 = 3; ecpp_C = 2.60/3 ≈ 0.8667
      P: total_cost = 0.45+0.25+0.90+0.70 = 2.30; n_pass = 2+1 = 3; ecpp_P = 2.30/3 ≈ 0.7667
      T: total_cost = 0.40+0.20+0.60+0.50 = 1.70; n_pass = 2+2 = 4; ecpp_T = 1.70/4 = 0.425
    """

    ROWS = [
        # task-A
        {"runId": "A-C-1", "repoId": "r1", "taskId": "task-A", "arm": "C", "replicate": 0, "costUsd": 0.50, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "A-C-2", "repoId": "r1", "taskId": "task-A", "arm": "C", "replicate": 1, "costUsd": 0.30, "passed": False, "censored": False, "competingFailure": True,  "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "A-P-1", "repoId": "r1", "taskId": "task-A", "arm": "P", "replicate": 0, "costUsd": 0.45, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "A-P-2", "repoId": "r1", "taskId": "task-A", "arm": "P", "replicate": 1, "costUsd": 0.25, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "A-T-1", "repoId": "r1", "taskId": "task-A", "arm": "T", "replicate": 0, "costUsd": 0.40, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "A-T-2", "repoId": "r1", "taskId": "task-A", "arm": "T", "replicate": 1, "costUsd": 0.20, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        # task-B
        {"runId": "B-C-1", "repoId": "r2", "taskId": "task-B", "arm": "C", "replicate": 0, "costUsd": 1.00, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "B-C-2", "repoId": "r2", "taskId": "task-B", "arm": "C", "replicate": 1, "costUsd": 0.80, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "B-P-1", "repoId": "r2", "taskId": "task-B", "arm": "P", "replicate": 0, "costUsd": 0.90, "passed": False, "censored": False, "competingFailure": True,  "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "B-P-2", "repoId": "r2", "taskId": "task-B", "arm": "P", "replicate": 1, "costUsd": 0.70, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "B-T-1", "repoId": "r2", "taskId": "task-B", "arm": "T", "replicate": 0, "costUsd": 0.60, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
        {"runId": "B-T-2", "repoId": "r2", "taskId": "task-B", "arm": "T", "replicate": 1, "costUsd": 0.50, "passed": True,  "censored": False, "competingFailure": False, "modelId": "m", "compactionEvents": 0, "durationMs": 1},
    ]

    @pytest.fixture(scope="class")
    @staticmethod
    def df():
        return pd.DataFrame(TestArithmeticExact.ROWS)

    def test_ecpp_C_exact(self, df):
        expected = 2.60 / 3
        got = expected_cost_per_pass(df, "C")
        assert abs(got - expected) < 1e-9, f"C: expected {expected:.6f}, got {got:.6f}"

    def test_ecpp_P_exact(self, df):
        expected = 2.30 / 3
        got = expected_cost_per_pass(df, "P")
        assert abs(got - expected) < 1e-9, f"P: expected {expected:.6f}, got {got:.6f}"

    def test_ecpp_T_exact(self, df):
        expected = 1.70 / 4
        got = expected_cost_per_pass(df, "T")
        assert abs(got - expected) < 1e-9, f"T: expected {expected:.6f}, got {got:.6f}"

    def test_ratio_T_vs_C_exact(self, df):
        expected_ratio = (1.70 / 4) / (2.60 / 3)
        got = expected_cost_per_pass(df, "T") / expected_cost_per_pass(df, "C")
        assert abs(got - expected_ratio) < 1e-9, (
            f"ratio(T,C): expected {expected_ratio:.6f}, got {got:.6f}"
        )

    def test_ratio_T_vs_P_exact(self, df):
        expected_ratio = (1.70 / 4) / (2.30 / 3)
        got = expected_cost_per_pass(df, "T") / expected_cost_per_pass(df, "P")
        assert abs(got - expected_ratio) < 1e-9, (
            f"ratio(T,P): expected {expected_ratio:.6f}, got {got:.6f}"
        )

    def test_success_rate_C(self, df):
        # C: 3 passes / 4 runs
        assert abs(success_rate(df, "C") - 3 / 4) < 1e-9

    def test_success_rate_T(self, df):
        # T: 4 passes / 4 runs = 1.0
        assert abs(success_rate(df, "T") - 4 / 4) < 1e-9

    def test_ecpp_inf_when_no_passes(self, df):
        # Create an arm with no passes
        no_pass_df = df.copy()
        no_pass_df.loc[no_pass_df["arm"] == "T", "passed"] = False
        assert expected_cost_per_pass(no_pass_df, "T") == float("inf")


# ---------------------------------------------------------------------------
# Test 5: geom_mean bootstrap multiplicity (Fix 1)
# ---------------------------------------------------------------------------


class TestGeomMeanBootstrapMultiplicity:
    """Verify that the geom_mean bootstrap correctly respects task multiplicity.

    With 3 tasks having very different log-cost ratios ([-ln10, 0, +ln10]), the
    multiplicity-correct bootstrap samples task IDs with replacement and weights
    each precomputed logratio by its draw count.  The resulting bootstrap
    distribution spans the full [-ln10, +ln10] range in log-space, giving a
    ratio-space CI width well above 1.0.

    The old (buggy) implementation called .unique() inside the bootstrap loop,
    collapsing a task drawn k times to a single contribution.  For this symmetric
    3-task design the old code gives an identical distribution (because the scalar
    logratio is the same whether counted once or k times), so the test is not a
    regression differentiator on this design — it instead pins the CORRECT
    behaviour of the fixed implementation and verifies the CI is not degenerate.
    """

    def _make_extreme_df(self) -> pd.DataFrame:
        """3 tasks with per-task T/C cost ratios of 0.1, 10, and 1.0.
        Logratios: [-ln10, +ln10, 0] → point estimate = exp(0) = 1.0."""
        task_costs = [
            ("task-0", "T", 0.10),
            ("task-0", "C", 1.00),
            ("task-1", "T", 1.00),
            ("task-1", "C", 0.10),
            ("task-2", "T", 0.50),
            ("task-2", "C", 0.50),
        ]
        rows = []
        for i, (tid, arm, cost) in enumerate(task_costs):
            rows.append(
                {
                    "runId": f"r{i}",
                    "repoId": "repo",
                    "taskId": tid,
                    "arm": arm,
                    "replicate": 0,
                    "costUsd": cost,
                    "passed": True,
                    "censored": False,
                    "competingFailure": False,
                    "modelId": "m",
                    "compactionEvents": 0,
                    "durationMs": 1,
                }
            )
        return pd.DataFrame(rows)

    def test_point_estimate_near_1(self):
        """Symmetric extreme logratios → point estimate ≈ 1.0."""
        df = self._make_extreme_df()
        result = geom_mean_paired_logratio(df, "T", "C", n_boot=2000, rng=_make_rng(42))
        assert 0.8 <= result["point"] <= 1.2, (
            f"Expected point near 1.0 for symmetric tasks; got {result['point']:.4f}"
        )

    def test_ci_spans_meaningful_range(self):
        """Bootstrap CI must span a meaningful range (ci_upper - ci_lower > 1.0).

        With logratios [-ln10, 0, +ln10], bootstrap samples can produce means
        anywhere in that range; the ratio-space CI should be wide.  A degenerate
        CI (width ≈ 0) would indicate the multiplicity bug was not fixed.
        """
        df = self._make_extreme_df()
        result = geom_mean_paired_logratio(df, "T", "C", n_boot=2000, rng=_make_rng(42))
        ci_width = result["ci_upper"] - result["ci_lower"]
        assert ci_width > 1.0, (
            f"Bootstrap CI should span a meaningful range for extreme logratios; "
            f"ci_lower={result['ci_lower']:.4f}, ci_upper={result['ci_upper']:.4f}, "
            f"width={ci_width:.4f}"
        )

    def test_n_tasks_with_data(self):
        """All 3 tasks have data for both arms; n_tasks_with_data must be 3."""
        df = self._make_extreme_df()
        result = geom_mean_paired_logratio(df, "T", "C", n_boot=100, rng=_make_rng(0))
        assert result["n_tasks_with_data"] == 3


# ---------------------------------------------------------------------------
# Test 6: dropped-bootstrap warning (Fix 2)
# ---------------------------------------------------------------------------


class TestBootstrapDropWarning:
    """bootstrap_ratio emits UserWarning when >1% of draws are dropped.

    Design: 5 tasks, T arm passes ONLY in task-0; C arm always passes.
    The probability that a bootstrap draw of size 5 (with replacement from
    5 tasks) omits task-0 is (4/5)^5 ≈ 32.8%.  Those draws give T zero
    passes → ecpp(T)=inf → ratio=inf/finite=inf → non-finite → dropped.
    32.8% >> 1%, so the warning must fire.

    Note: if C has zero passes the ratio becomes finite/inf = 0 (not inf),
    so the sparse arm must be T (the numerator arm) to produce non-finite
    ratios when its single eligible task is absent from the resample.
    """

    def _make_sparse_T_df(self) -> pd.DataFrame:
        rows = []
        for task_idx in range(5):
            tid = f"task-{task_idx}"
            for arm in ["T", "C"]:
                for rep in range(3):
                    t_passes = task_idx == 0  # T only passes in task-0
                    passed = t_passes if arm == "T" else True  # C always passes
                    rows.append(
                        {
                            "runId": f"{tid}-{arm}-{rep}",
                            "repoId": "repo",
                            "taskId": tid,
                            "arm": arm,
                            "replicate": rep,
                            "costUsd": 0.50,
                            "passed": passed,
                            "censored": False,
                            "competingFailure": not passed,
                            "modelId": "m",
                            "compactionEvents": 0,
                            "durationMs": 1,
                        }
                    )
        return pd.DataFrame(rows)

    def test_warning_emitted_for_many_dropped_draws(self):
        """bootstrap_ratio warns when drop fraction > 1%."""
        df = self._make_sparse_T_df()
        with pytest.warns(UserWarning, match=r"bootstrap draws.*dropped"):
            bootstrap_ratio(df, "T", "C", n_boot=2000, rng=_make_rng(42))
