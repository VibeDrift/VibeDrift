import { describe, it, expect } from "vitest";
import { computeRunCostUsd } from "../src/pricing.js";

const rates = { input: 1e-6, output: 5e-6, cacheWrite: 1.25e-6, cacheRead: 0.1e-6 };

describe("computeRunCostUsd", () => {
  it("sums each token class at its own rate", () => {
    const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 400, cache_read_input_tokens: 5000 };
    const cost = computeRunCostUsd(usage, rates);
    // 1000*1e-6 + 200*5e-6 + 400*1.25e-6 + 5000*0.1e-6
    expect(cost).toBeCloseTo(0.001 + 0.001 + 0.0005 + 0.0005, 10);
  });
  it("is zero for an empty run", () => {
    expect(computeRunCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, rates)).toBe(0);
  });
});
