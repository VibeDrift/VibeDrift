import { describe, it, expect } from "vitest";
import {
  FIX_PLAN_MIN_IMPACT,
  hasMeaningfulImpact,
  selectFixPlanFindings,
} from "../../../src/output/fix-plan-select.js";
import type { Finding } from "../../../src/core/types.js";

function mkFinding(consistencyImpact: number | undefined, id = "naming"): Finding {
  return {
    analyzerId: id,
    severity: "warning",
    confidence: 0.9,
    message: `finding @ ${consistencyImpact}`,
    locations: [{ file: "src/a.ts", line: 1 }],
    tags: [],
    consistencyImpact,
  };
}

/**
 * Bug B: the Fix Plan is framed as "highest-impact drifts to re-align first",
 * but impacts render to one decimal place (`+X.Xpts`). consistencyImpact is
 * stored to two decimals, so a finding with impact 0.01–0.04 passed the old
 * `> 0` filter yet displayed as `+0.0pts` — telling the user to fix something
 * for no visible gain. The selector must exclude anything that would render
 * as `+0.0pts`.
 */
describe("selectFixPlanFindings — excludes display-zero impact (Bug B)", () => {
  it("drops findings whose impact rounds to +0.0pts", () => {
    const findings = [
      mkFinding(2.0),
      mkFinding(0.8),
      mkFinding(0.04), // displays "+0.0pts"
      mkFinding(0.0),
      mkFinding(undefined),
    ];
    const picked = selectFixPlanFindings(findings, 5);
    const impacts = picked.map((f) => f.consistencyImpact);
    expect(impacts).toEqual([2.0, 0.8]);
  });

  it("keeps a finding right at the display threshold (0.05 → +0.1pts)", () => {
    const picked = selectFixPlanFindings([mkFinding(0.05)], 5);
    expect(picked.length).toBe(1);
  });

  it("sorts by descending impact and respects the limit", () => {
    const findings = [
      mkFinding(0.3),
      mkFinding(5.0),
      mkFinding(1.2),
      mkFinding(2.4),
    ];
    const picked = selectFixPlanFindings(findings, 2);
    expect(picked.map((f) => f.consistencyImpact)).toEqual([5.0, 2.4]);
  });

  it("returns an empty plan when every finding is display-zero", () => {
    const findings = [mkFinding(0.0), mkFinding(0.02), mkFinding(undefined)];
    expect(selectFixPlanFindings(findings, 5)).toEqual([]);
  });
});

describe("hasMeaningfulImpact", () => {
  it("is false below the threshold and true at/above it", () => {
    expect(hasMeaningfulImpact(mkFinding(0.04))).toBe(false);
    expect(hasMeaningfulImpact(mkFinding(0.05))).toBe(true);
    expect(hasMeaningfulImpact(mkFinding(0))).toBe(false);
    expect(hasMeaningfulImpact(mkFinding(undefined))).toBe(false);
  });

  it("threshold matches the one-decimal display rounding", () => {
    // Anything >= FIX_PLAN_MIN_IMPACT must render as at least +0.1pts.
    expect(FIX_PLAN_MIN_IMPACT.toFixed(1)).toBe("0.1");
  });
});
