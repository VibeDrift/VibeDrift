import { describe, it, expect } from "vitest";
import { applySecurityMinPeerFloor, MIN_SECURITY_PEERS, computeScores } from "../../../src/scoring/engine.js";
import type { Finding } from "../../../src/core/types.js";

function secFinding(totalRelevantFiles: number, analyzerId = "drift-security_posture"): Finding {
  return {
    analyzerId,
    severity: "warning",
    confidence: 0.75,
    message: "DRIFT: auth missing on 1 of N routes",
    locations: [{ file: "src/routes/a.ts", line: 1 }],
    tags: ["drift"],
    driftSignal: { consistencyScore: 50, dominantCount: totalRelevantFiles - 1, totalRelevantFiles },
  };
}

describe("applySecurityMinPeerFloor", () => {
  it("re-tags a thin (< MIN_SECURITY_PEERS) security finding to the advisory hygiene id", () => {
    const out = applySecurityMinPeerFloor([secFinding(2)]);
    expect(out[0].analyzerId).toBe("security_posture-advisory");
  });

  it("keeps a security finding at the floor as scored drift", () => {
    const out = applySecurityMinPeerFloor([secFinding(MIN_SECURITY_PEERS)]);
    expect(out[0].analyzerId).toBe("drift-security_posture");
  });

  it("never touches codedna-taint findings", () => {
    const out = applySecurityMinPeerFloor([secFinding(1, "codedna-taint")]);
    expect(out[0].analyzerId).toBe("codedna-taint");
  });

  it("a thin security finding does not move the drift composite (advisory → N/A)", () => {
    const { scores } = computeScores([secFinding(2)], 1000);
    // The only security drift finding was demoted → surface-specific category is N/A.
    expect(scores.securityPosture.applicable).toBe(false);
  });

  it("a security finding at the floor is scored", () => {
    const { scores } = computeScores([secFinding(MIN_SECURITY_PEERS)], 1000);
    expect(scores.securityPosture.applicable).toBe(true);
    expect(scores.securityPosture.score).toBeLessThan(20);
  });
});
