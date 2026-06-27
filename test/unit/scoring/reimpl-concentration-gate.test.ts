import { describe, it, expect } from "vitest";
import {
  applyReimplementationConcentrationGate,
  computeScores,
  REIMPL_CONCENTRATION_DENSITY_MIN,
  REIMPL_CONCENTRATION_MIN_COUNT,
} from "../../../src/scoring/engine.js";
import type { Finding } from "../../../src/core/types.js";

function reimpl(n: number): Finding[] {
  return Array.from({ length: n }, (_, i) => ({
    analyzerId: "ml-reimplementation",
    severity: "warning" as const,
    message: `reimpl ${i}`,
    locations: [{ file: `a${i}.py` }],
    tags: ["ml", "reimplementation"],
  }));
}

const other: Finding = {
  analyzerId: "naming",
  severity: "warning",
  message: "naming",
  locations: [{ file: "x.py" }],
};

function tags(findings: Finding[], id: string): number {
  return findings.filter((f) => f.analyzerId === id).length;
}

describe("applyReimplementationConcentrationGate", () => {
  it("re-tags reimplementation findings to the drift id when dense (>=1/KLOC and >=3 findings)", () => {
    // 5 findings in 1000 LOC = 5.0/KLOC, count 5 — clears both bars.
    const out = applyReimplementationConcentrationGate([...reimpl(5), other], 1000);
    expect(tags(out, "ml-reimplementation-concentrated")).toBe(5);
    expect(tags(out, "ml-reimplementation")).toBe(0);
    // unrelated findings are untouched
    expect(tags(out, "naming")).toBe(1);
  });

  it("leaves findings as hygiene when the count is below the minimum", () => {
    // 2 findings in 100 LOC = 20/KLOC (very dense) but only 2 findings.
    const out = applyReimplementationConcentrationGate(reimpl(2), 100);
    expect(tags(out, "ml-reimplementation")).toBe(2);
    expect(tags(out, "ml-reimplementation-concentrated")).toBe(0);
  });

  it("leaves findings as hygiene when density is below the threshold", () => {
    // 3 findings in 10000 LOC = 0.3/KLOC — sparse (the elite baseline shape).
    const out = applyReimplementationConcentrationGate(reimpl(3), 10000);
    expect(tags(out, "ml-reimplementation")).toBe(3);
    expect(tags(out, "ml-reimplementation-concentrated")).toBe(0);
  });

  it("does not divide by zero on empty/zero LOC", () => {
    const out = applyReimplementationConcentrationGate(reimpl(5), 0);
    expect(tags(out, "ml-reimplementation")).toBe(5);
    expect(tags(out, "ml-reimplementation-concentrated")).toBe(0);
  });

  it("fires exactly at the calibrated boundary", () => {
    // count == MIN_COUNT and density == DENSITY_MIN exactly.
    const n = REIMPL_CONCENTRATION_MIN_COUNT;
    const loc = (n / REIMPL_CONCENTRATION_DENSITY_MIN) * 1000; // density == DENSITY_MIN
    const out = applyReimplementationConcentrationGate(reimpl(n), loc);
    expect(tags(out, "ml-reimplementation-concentrated")).toBe(n);
  });
});

describe("reimplementation concentration gate — scoring impact", () => {
  it("below-gate reimplementation is informational (does not move the composite)", () => {
    const clean = computeScores([], 1000).compositeScore;
    const belowGate = computeScores(reimpl(2), 1000).compositeScore; // count < 3
    expect(belowGate).toBe(clean);
  });

  it("concentrated reimplementation lowers the composite", () => {
    const belowGate = computeScores(reimpl(2), 1000).compositeScore; // hygiene
    const dense = computeScores(reimpl(4), 1000).compositeScore; // 4/KLOC → drift
    expect(dense).toBeLessThan(belowGate);
  });
});
