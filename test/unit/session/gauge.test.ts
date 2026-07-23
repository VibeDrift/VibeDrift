import { describe, it, expect } from "vitest";
import { computeDrift, classifyZone, applyHysteresis, gaugeSignals } from "@/session/gauge";
import type { SessionEvent } from "@/session/types";

let seq = 0;
const ev = (type: SessionEvent["type"], over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1, sid: "s", aid: `e${seq++}`, ts: new Date().toISOString(), agent: "claude-code",
  projectHash: "h", channel: "hook", type, mode: "passive", detail: {}, ...over,
});

describe("computeDrift (noisy-OR)", () => {
  it("is 0 when no signal fires", () => {
    expect(computeDrift(0, 0, 0)).toBe(0);
  });
  it("matches the D = 1-(1-0.5a)(1-0.35b)(1-0.4c) family", () => {
    // all three fully on: 1 - 0.5*0.65*0.6 = 1 - 0.195 = 0.805
    expect(computeDrift(1, 1, 1)).toBeCloseTo(0.805, 3);
    // only redundancy fully on: 1 - (1-0.4) = 0.4
    expect(computeDrift(0, 0, 1)).toBeCloseTo(0.4, 3);
  });
  it("is monotonic in each signal", () => {
    expect(computeDrift(0.5, 0, 0)).toBeGreaterThan(computeDrift(0.2, 0, 0));
  });
});

describe("classifyZone", () => {
  it("splits green/yellow/red at 0.25 and 0.5", () => {
    expect(classifyZone(0.1)).toBe("green");
    expect(classifyZone(0.3)).toBe("yellow");
    expect(classifyZone(0.6)).toBe("red");
  });
});

describe("applyHysteresis", () => {
  it("does not flap on a value hovering right at a boundary", () => {
    // in green, a value just over 0.25 should not immediately jump to yellow
    expect(applyHysteresis("green", 0.26)).toBe("green");
    // but a clear move past the margin does switch
    expect(applyHysteresis("green", 0.34)).toBe("yellow");
  });
  it("is sticky coming back down too", () => {
    expect(applyHysteresis("yellow", 0.24)).toBe("yellow"); // within margin, stays
    expect(applyHysteresis("yellow", 0.16)).toBe("green"); // clears margin, drops
  });
  it("holds the yellow<->red boundary with margin", () => {
    expect(applyHysteresis("yellow", 0.52)).toBe("yellow"); // just over 0.5, within margin
    expect(applyHysteresis("yellow", 0.58)).toBe("red"); // clears margin
    expect(applyHysteresis("red", 0.48)).toBe("red"); // within margin, stays red
    expect(applyHysteresis("red", 0.42)).toBe("yellow"); // clears margin, drops
  });
  it("jumps multiple zones on a large move", () => {
    expect(applyHysteresis("green", 0.9)).toBe("red");
    expect(applyHysteresis("red", 0.0)).toBe("green");
  });
});

describe("gaugeSignals", () => {
  it("computes fractions over the last window of edits", () => {
    const events = [
      ev("edit"),
      ev("flag", { detail: { category: "async_patterns" } }),
      ev("edit"),
      ev("flag", { detail: { category: "redundancy" } }),
      ev("edit"),
      ev("flag", { detail: { category: "scope" } }),
    ];
    const { a, b, c } = gaugeSignals(events, 3);
    // 3 edits in window, 1 scope, 1 convention, 1 redundancy
    expect(a).toBeCloseTo(1 / 3, 3);
    expect(b).toBeCloseTo(1 / 3, 3);
    expect(c).toBeCloseTo(1 / 3, 3);
  });
  it("is all-zero with no edits", () => {
    expect(gaugeSignals([ev("session_start")], 5)).toEqual({ a: 0, b: 0, c: 0 });
  });
});
