import { describe, it, expect } from "vitest";
import { isPaidPlan } from "../../../src/auth/plan.js";

describe("isPaidPlan", () => {
  it("is true only for pro and scale", () => {
    expect(isPaidPlan("pro")).toBe(true);
    expect(isPaidPlan("scale")).toBe(true);
  });
  it("is false for free / null / undefined", () => {
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan(null)).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
  });
});
