import { describe, it, expect } from "vitest";
import { decideNudge, type NudgeState } from "../../../src/mcp/nudge.js";

const now = Date.parse("2026-06-14T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(now - ms).toISOString();

// A baseline state that WOULD nudge (signed in, active session, stale deep scan,
// not recently nudged). Each test overrides the one field under examination.
const base: NudgeState = {
  signedIn: true,
  callsThisSession: 10,
  lastDeepScanAt: isoAgo(5 * DAY),
  lastNudgedAt: undefined,
  nowMs: now,
};

describe("decideNudge", () => {
  it("does not nudge a signed-out user", () => {
    expect(decideNudge({ ...base, signedIn: false })).toBeNull();
  });

  it("stays quiet early in a session (below the activity floor)", () => {
    expect(decideNudge({ ...base, callsThisSession: 3 })).toBeNull();
  });

  it("nudges to run the FIRST deep scan when there has never been one", () => {
    const hint = decideNudge({ ...base, lastDeepScanAt: undefined });
    expect(hint?.reason).toBe("never_deep_scanned");
    expect(hint?.type).toBe("deep_scan");
    expect(hint?.action).toContain("deep: true");
  });

  it("does not nudge when the last deep scan is recent", () => {
    expect(decideNudge({ ...base, lastDeepScanAt: isoAgo(1 * DAY) })).toBeNull();
  });

  it("nudges when the last deep scan is stale and the session is active", () => {
    const hint = decideNudge(base);
    expect(hint?.reason).toBe("stale_deep_scan");
    expect(hint?.message.toLowerCase()).toContain("deep scan");
  });

  it("respects the cooldown (no second nudge within a day)", () => {
    expect(decideNudge({ ...base, lastNudgedAt: isoAgo(1 * HOUR) })).toBeNull();
  });

  it("nudges again once the cooldown has elapsed", () => {
    const hint = decideNudge({ ...base, lastNudgedAt: isoAgo(2 * DAY) });
    expect(hint?.reason).toBe("stale_deep_scan");
  });
});
