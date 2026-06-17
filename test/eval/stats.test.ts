import { describe, it, expect } from "vitest";
import { mean, sampleStdev, tCrit95, meanCI95 } from "../../eval/stats.js";

describe("eval stats — sample statistics for drift-delta confidence intervals", () => {
  it("mean of a sample", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    expect(mean([])).toBe(0);
  });

  it("sampleStdev uses Bessel's correction (n-1), 0 for n<2", () => {
    // Classic worked example: [2,4,4,4,5,5,7,9] → population sd 2, sample sd 2.138.
    expect(sampleStdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(sampleStdev([5])).toBe(0);
    expect(sampleStdev([])).toBe(0);
  });

  it("tCrit95 returns the two-sided 95% t critical value by df", () => {
    expect(tCrit95(4)).toBeCloseTo(2.776, 3); // n=5 tasks
    expect(tCrit95(9)).toBeCloseTo(2.262, 3); // n=10 tasks
    // Large df → normal approximation.
    expect(tCrit95(100)).toBeCloseTo(1.96, 2);
  });

  it("meanCI95 produces a t-interval around the mean", () => {
    // mean 3, sampleStdev sqrt(2.5)=1.58114, se=0.70711, t(df4)=2.776,
    // halfWidth=1.9629 → [1.0371, 4.9629].
    const ci = meanCI95([1, 2, 3, 4, 5]);
    expect(ci.mean).toBeCloseTo(3, 6);
    expect(ci.n).toBe(5);
    expect(ci.lo).toBeCloseTo(1.037, 2);
    expect(ci.hi).toBeCloseTo(4.963, 2);
  });

  it("a confidently-positive sample has lo > 0 (significant); a noisy one straddles 0", () => {
    // Tight, all-positive deltas → CI stays above 0.
    const tight = meanCI95([1.0, 0.9, 1.1, 1.0, 1.0]);
    expect(tight.lo).toBeGreaterThan(0);
    // Deltas centered near 0 with spread → CI includes 0.
    const noisy = meanCI95([1.0, -1.0, 0.5, -0.5, 0.0]);
    expect(noisy.lo).toBeLessThan(0);
    expect(noisy.hi).toBeGreaterThan(0);
  });
});
