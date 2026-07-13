import { describe, it, expect } from "vitest";
import { CATEGORY_CONFIG } from "../../../src/scoring/categories.js";

describe("security dimension user-facing name", () => {
  it("renders as 'Security Consistency', not 'Security Posture'", () => {
    expect(CATEGORY_CONFIG.securityPosture.name).toBe("Security Consistency");
  });
  it("keeps the internal ScoringCategory key unchanged", () => {
    expect(CATEGORY_CONFIG.securityPosture).toBeDefined();
    expect(CATEGORY_CONFIG.securityPosture.analyzers.some((a) => a.id === "drift-security_posture")).toBe(true);
  });
});
