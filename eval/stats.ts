/**
 * Sample statistics for the drift-delta eval — turns a set of per-task deltas
 * into a mean and a 95% confidence interval, so a run reports "delta X ± Y"
 * instead of a bare point estimate. Pure and deterministic; unit-tested in
 * test/eval/stats.test.ts. No dependency on the harness or the network.
 *
 * We treat the TASK as the unit of observation (n = number of tasks), not the
 * trial — trials within a task are not independent observations of the effect,
 * so a per-task t-interval is the conservative, honest choice for small n.
 */

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Sample standard deviation (Bessel's n-1 correction). 0 when n < 2. */
export function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, b) => a + (b - m) ** 2, 0);
  return Math.sqrt(ss / (xs.length - 1));
}

// Two-sided 95% Student-t critical values by degrees of freedom. Small table
// (the eval uses 5–10 tasks → df 4–9); df ≥ 30 falls back to the normal z.
const T95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145,
  15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045,
};

/** Two-sided 95% t critical value for `df` degrees of freedom. */
export function tCrit95(df: number): number {
  if (df < 1) return Infinity;
  if (df >= 30) return 1.96;
  return T95[df] ?? 1.96;
}

export interface CI {
  mean: number;
  lo: number;
  hi: number;
  n: number;
  se: number;
  halfWidth: number;
}

/**
 * 95% t-interval for the mean of `xs`. With n < 2 the interval is undefined,
 * so lo/hi collapse to the mean (halfWidth 0) — callers should treat n < 2 as
 * "not enough data to claim significance".
 */
export function meanCI95(xs: number[]): CI {
  const m = mean(xs);
  const n = xs.length;
  if (n < 2) return { mean: m, lo: m, hi: m, n, se: 0, halfWidth: 0 };
  const se = sampleStdev(xs) / Math.sqrt(n);
  const halfWidth = tCrit95(n - 1) * se;
  return { mean: m, lo: m - halfWidth, hi: m + halfWidth, n, se, halfWidth };
}
