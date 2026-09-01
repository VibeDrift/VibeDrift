import { describe, it, expect } from "vitest";
import { formatCount, scoreBar } from "../../../src/output/format.js";

/**
 * formatCount must be byte-stable across machine locales. `Number#toLocaleString()`
 * (the thing this replaces) inserts locale-specific separators — "1,234" in en-US,
 * "1.234" in de-DE, "1 234" in fr-FR — so two machines produce non-identical reports
 * for the same scan, and a report near the upload size cap can cross it purely from
 * separator width. formatCount pins en-US grouping regardless of the host locale.
 */
describe("formatCount", () => {
  it("groups thousands with a comma, deterministically", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("leaves sub-thousand values ungrouped", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });

  it("handles exactly one thousand", () => {
    expect(formatCount(1000)).toBe("1,000");
  });

  it("is independent of the process locale env", () => {
    const prev = process.env.LANG;
    process.env.LANG = "de_DE.UTF-8";
    try {
      expect(formatCount(1234567)).toBe("1,234,567");
    } finally {
      if (prev === undefined) delete process.env.LANG;
      else process.env.LANG = prev;
    }
  });
});

/**
 * P3: scoreBar computed `filled = Math.round((score / max) * width)` with no
 * clamp. A score above max (a real possibility — e.g. a projected/"after
 * fixes" score, or a caller passing an already-summed delta) pushes `filled`
 * past `width`, and `width - filled` goes negative — String#repeat throws a
 * RangeError on a negative count. Clamp `filled` to [0, width].
 */
describe("scoreBar", () => {
  it("renders a fully-filled bar at score === max", () => {
    expect(scoreBar(20, 20, 10)).toBe("█".repeat(10));
  });

  it("does not throw when score > max, and clamps to a fully-filled bar", () => {
    expect(() => scoreBar(25, 20, 10)).not.toThrow();
    expect(scoreBar(25, 20, 10)).toBe("█".repeat(10));
  });

  it("does not throw and clamps to empty when score is negative", () => {
    expect(() => scoreBar(-5, 20, 10)).not.toThrow();
    expect(scoreBar(-5, 20, 10)).toBe("░".repeat(10));
  });

  it("renders a partially-filled bar within range", () => {
    expect(scoreBar(10, 20, 10)).toBe("█".repeat(5) + "░".repeat(5));
  });
});
