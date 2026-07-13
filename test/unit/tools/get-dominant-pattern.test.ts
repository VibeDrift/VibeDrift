import { describe, it, expect } from "vitest";
import { dominantPatternFor } from "../../../src/tools-core/tools/get-dominant-pattern.js";
import type { RepoDriftBaseline, CategoryVote } from "../../../src/core/baseline.js";

function vote(pattern: string, dom: number, total: number): CategoryVote {
  return { driftCategory: "security_posture", dominantPattern: pattern, dominantCount: dom, totalRelevantFiles: total, consistencyScore: Math.round((dom / total) * 100), dominantFiles: [], deviators: [] };
}

function baseline(over: Partial<RepoDriftBaseline>): RepoDriftBaseline {
  return {
    key: "k", rootDir: "/r", ctxFiles: [{ path: "a.ts", hash: "h" }],
    perCategoryVote: {}, securitySubVotes: {}, intentHints: [], minhashIndex: [], builtAt: 0,
    ...over,
  };
}

describe("dominantPatternFor — auth reads the auth sub-vote, not the collided slot", () => {
  it("returns the Auth middleware vote even when rate-limit has a wider denominator", () => {
    const b = baseline({
      // The collided perCategoryVote slot holds the WIDER rate-limit finding.
      perCategoryVote: { security_posture: vote("Rate limiting applied", 6, 12) },
      securitySubVotes: {
        "Auth middleware": vote("Auth middleware applied", 4, 5),
        "Rate limiting": vote("Rate limiting applied", 6, 12),
      },
    });
    const out = dominantPatternFor(b, "auth");
    expect(out.dominantPattern).toBe("Auth middleware applied");
    expect(out.consistency).toContain("4 of 5");
  });

  it("falls back to the consistent projection when securitySubVotes is absent (stale pre-upgrade baseline)", () => {
    // Simulates a v1 on-disk baseline served stale by getBaseline via
    // loadBaselineUnchecked: it predates the securitySubVotes field entirely,
    // so the field is undefined at runtime, not an empty object.
    const b = baseline({
      perCategoryVote: { security_posture: vote("Rate limiting applied", 6, 12) },
      securitySubVotes: undefined,
    });
    expect(() => dominantPatternFor(b, "auth")).not.toThrow();
    const out = dominantPatternFor(b, "auth");
    expect(out.dominantPattern).toBe("consistent");
    expect(out.consistency).toBe("100% — no deviations detected");
  });
});
