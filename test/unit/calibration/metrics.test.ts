import { describe, it, expect } from "vitest";
import { findingCategory, classify } from "../../calibration/metrics.js";

describe("findingCategory", () => {
  it("reads the drift category from tags[1] for drift findings", () => {
    expect(findingCategory({ analyzerId: "drift-naming_conventions", tags: ["drift", "naming_conventions", "cross-file"] })).toBe("naming_conventions");
  });
  it("maps the static naming analyzer to naming_conventions", () => {
    expect(findingCategory({ analyzerId: "naming", tags: ["naming", "inconsistency"] })).toBe("naming_conventions");
  });
  it("returns the analyzerId for anything else", () => {
    expect(findingCategory({ analyzerId: "complexity", tags: [] })).toBe("complexity");
  });
});

describe("classify (synthetic ground truth → precision/recall/F1)", () => {
  it("perfect catch: a category finding on the injected file", () => {
    const labels = [{ category: "naming_conventions", file: "a.ts" }];
    const findings = [{ category: "naming_conventions", files: ["a.ts"] }];
    const m = classify(findings, labels).find((x) => x.category === "naming_conventions")!;
    expect(m).toMatchObject({ tp: 1, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 });
  });

  it("wrong file: the injected file is missed (FN) and the spurious fire is a FP", () => {
    const labels = [{ category: "naming_conventions", file: "a.ts" }];
    const findings = [{ category: "naming_conventions", files: ["b.ts"] }];
    const m = classify(findings, labels).find((x) => x.category === "naming_conventions")!;
    expect(m).toMatchObject({ tp: 0, fn: 1, fp: 1, precision: 0, recall: 0 });
  });

  it("missed entirely: injected drift with no finding → recall 0, precision N/A (null)", () => {
    const labels = [{ category: "architectural_consistency", file: "a.ts" }];
    const m = classify([], labels).find((x) => x.category === "architectural_consistency")!;
    expect(m.tp).toBe(0);
    expect(m.fn).toBe(1);
    expect(m.recall).toBe(0);
    expect(m.precision).toBeNull(); // no findings emitted → precision undefined
  });

  it("clean-baseline false positive: a finding with no matching label → FP, recall N/A", () => {
    const findings = [{ category: "naming_conventions", files: ["clean.ts"] }];
    const m = classify(findings, []).find((x) => x.category === "naming_conventions")!;
    expect(m.fp).toBe(1);
    expect(m.tp).toBe(0);
    expect(m.recall).toBeNull(); // no injected instances → recall undefined
    expect(m.precision).toBe(0);
  });
});
