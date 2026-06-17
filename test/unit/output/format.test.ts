import { describe, it, expect } from "vitest";
import { formatCount } from "../../../src/output/format.js";

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
