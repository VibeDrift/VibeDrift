import { describe, it, expect } from "vitest";
import { formatTimeSince } from "../../../src/core/time-format.js";

describe("formatTimeSince", () => {
  const now = Date.parse("2026-06-14T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("reports sub-minute gaps as 'just now'", () => {
    expect(formatTimeSince(ago(30 * SEC), now)).toBe("just now");
  });

  it("pluralizes minutes", () => {
    expect(formatTimeSince(ago(1 * MIN), now)).toBe("1 minute ago");
    expect(formatTimeSince(ago(5 * MIN), now)).toBe("5 minutes ago");
  });

  it("pluralizes hours", () => {
    expect(formatTimeSince(ago(3 * HOUR), now)).toBe("3 hours ago");
  });

  it("pluralizes days", () => {
    expect(formatTimeSince(ago(1 * DAY), now)).toBe("1 day ago");
    expect(formatTimeSince(ago(5 * DAY), now)).toBe("5 days ago");
  });

  it("rolls up to months past 30 days", () => {
    expect(formatTimeSince(ago(45 * DAY), now)).toBe("1 month ago");
    expect(formatTimeSince(ago(75 * DAY), now)).toBe("2 months ago");
  });

  it("treats a future or unparseable timestamp safely", () => {
    expect(formatTimeSince(ago(-5 * MIN), now)).toBe("just now");
    expect(formatTimeSince("not-a-date", now)).toBe("unknown");
  });
});
