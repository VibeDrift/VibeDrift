import { describe, it, expect } from "vitest";
import { shouldShowScoringNotice, scoringNoticeLine } from "../../../src/core/scoring-notice.js";

/**
 * One-time "scoring refined" notice. Replaces the rejected per-scan
 * version-mismatch banner. The rule: announce ONCE when the scoring version
 * the user last saw differs from the current one — but never spam a
 * brand-new user (who has nothing to be re-aligned), and never repeat.
 */
describe("shouldShowScoringNotice", () => {
  it("does not show when the user already saw the current version", () => {
    expect(shouldShowScoringNotice({ lastSeen: "v3", current: "v3", hasPriorHistory: true })).toBe(false);
  });

  it("does not show for a brand-new user (no version seen, no prior scans)", () => {
    expect(shouldShowScoringNotice({ lastSeen: undefined, current: "v3", hasPriorHistory: false })).toBe(false);
  });

  it("shows for an existing user crossing into versioning (no version seen, but has prior scans)", () => {
    expect(shouldShowScoringNotice({ lastSeen: undefined, current: "v3", hasPriorHistory: true })).toBe(true);
  });

  it("shows once when the version changed", () => {
    expect(shouldShowScoringNotice({ lastSeen: "v2", current: "v3", hasPriorHistory: false })).toBe(true);
    expect(shouldShowScoringNotice({ lastSeen: "v2", current: "v3", hasPriorHistory: true })).toBe(true);
  });
});

describe("scoringNoticeLine", () => {
  it("links the release notes and never exposes an internal version string", () => {
    const line = scoringNoticeLine();
    expect(line).toMatch(/vibedrift\.ai\/releases/);
    // Users must stay agnostic of internal versions — no "v2"/"v3"/"version N".
    expect(line).not.toMatch(/\bv\d\b/);
    expect(line.toLowerCase()).not.toContain("scoring version");
  });
});
