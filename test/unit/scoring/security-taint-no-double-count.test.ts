import { describe, it, expect } from "vitest";
import { computeScores } from "../../../src/scoring/engine.js";
import type { Finding } from "../../../src/core/types.js";

// The route-consistency detector (`drift-security_posture`) and taint analysis
// (`codedna-taint`) both live under the securityPosture category. They are
// distinct analyzerIds, so `categoryHealth` groups them as separate detectors
// in its noisy-OR — they COMPOUND (two distinct problems lower the score more
// than one) but never double-count the same evidence.
describe("securityPosture: route-consistency and taint are separate detector groups", () => {
  function secDrift(): Finding {
    return {
      analyzerId: "drift-security_posture", severity: "warning", confidence: 0.9,
      message: "auth inconsistency", locations: [{ file: "a.ts", line: 1 }], tags: ["drift"],
      driftSignal: { consistencyScore: 60, dominantCount: 6, totalRelevantFiles: 10 },
    };
  }
  function taint(): Finding {
    return {
      analyzerId: "codedna-taint", severity: "error", confidence: 0.9,
      message: "tainted flow", locations: [{ file: "a.ts", line: 2 }], tags: ["drift"],
      driftSignal: { consistencyScore: 50, dominantCount: 5, totalRelevantFiles: 10 },
    };
  }

  it("both findings compound (lower the score more together than route-consistency alone)", () => {
    const only1 = computeScores([secDrift()], 5000).scores.securityPosture.score;
    const both = computeScores([secDrift(), taint()], 5000).scores.securityPosture.score;
    expect(both).toBeLessThan(only1);
  });

  it("taint alone still scores securityPosture (separate, independent detector)", () => {
    const taintOnly = computeScores([taint()], 5000).scores.securityPosture;
    expect(taintOnly.applicable).toBe(true);
    expect(taintOnly.score).toBeLessThan(20);
  });
});
