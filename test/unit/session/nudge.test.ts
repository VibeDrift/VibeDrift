import { describe, it, expect } from "vitest";
import {
  isNewInteractiveSource,
  isNonInteractive,
  buildNudgeInstruction,
  buildNudgeOutput,
  buildLockNotice,
  buildTrialLine,
} from "@/session/nudge";
import type { SessionEntitlement } from "@/session/entitlement";

const trial = (used: number): SessionEntitlement => ({
  entitled: true,
  reason: "trial",
  plan: "free",
  trialUsed: used,
  trialLimit: 5,
});
const pro: SessionEntitlement = { entitled: true, reason: "pro", plan: "pro", trialUsed: 0, trialLimit: 5 };

describe("isNewInteractiveSource", () => {
  it("only startup and clear count as a new interactive session", () => {
    expect(isNewInteractiveSource("startup")).toBe(true);
    expect(isNewInteractiveSource("clear")).toBe(true);
    expect(isNewInteractiveSource("resume")).toBe(false);
    expect(isNewInteractiveSource("compact")).toBe(false);
    expect(isNewInteractiveSource(undefined)).toBe(false);
    expect(isNewInteractiveSource("whatever")).toBe(false);
  });
});

describe("isNonInteractive", () => {
  it("reads the deterministic override", () => {
    expect(isNonInteractive({ VIBEDRIFT_HOOK_NONINTERACTIVE: "1" })).toBe(true);
    expect(isNonInteractive({ VIBEDRIFT_HOOK_NONINTERACTIVE: "true" })).toBe(true);
    expect(isNonInteractive({})).toBe(false);
    expect(isNonInteractive({ VIBEDRIFT_HOOK_NONINTERACTIVE: "0" })).toBe(false);
  });
});

describe("buildNudgeInstruction", () => {
  it("names the repo, asks once, and carries the soft-decline path", () => {
    const text = buildNudgeInstruction({ repoName: "my-api" });
    expect(text).toContain('"my-api"');
    expect(text).toContain("Want me to enable VibeDrift");
    expect(text).toContain("enable");
    expect(text).toContain('{"decline": true}');
    // soft-decline on a deflection
    expect(text.toLowerCase()).toContain("not now");
    // no trial line for a non-trial context
    expect(text).not.toContain("free trial");
  });

  it("adds the honest trial usage line only on a trial entitlement", () => {
    expect(buildNudgeInstruction({ repoName: "r", entitlement: trial(2) })).toContain("2 of 5 sessions used");
    expect(buildNudgeInstruction({ repoName: "r", entitlement: pro })).not.toContain("trial");
  });
});

describe("buildTrialLine", () => {
  it("renders the trial count for a trial entitlement", () => {
    expect(buildTrialLine(trial(2))).toBe("VibeDrift trial: 2 of 5 sessions used.");
  });

  it("returns null for a pro account (the meter is trial-only)", () => {
    expect(buildTrialLine(pro)).toBeNull();
  });

  it("returns null when the entitlement is unknown (never a fabricated count)", () => {
    expect(buildTrialLine(null)).toBeNull();
    expect(buildTrialLine(undefined)).toBeNull();
  });

  it("returns null when locked (the lock notice owns that path)", () => {
    expect(
      buildTrialLine({ entitled: false, reason: "locked", plan: "free", trialUsed: 5, trialLimit: 5 }),
    ).toBeNull();
  });

  it("returns null once the count reaches the limit (the lock notice owns spent)", () => {
    expect(buildTrialLine(trial(5))).toBeNull();
  });

  it("returns null on an absurd over-limit count from a corrupt cache", () => {
    expect(buildTrialLine(trial(6))).toBeNull();
  });

  it("flags the last free session at 4 of 5", () => {
    expect(buildTrialLine(trial(4))).toBe(
      "VibeDrift trial: 4 of 5 sessions used. This is your last free session.",
    );
  });

  it("keys the boundary on the real limit, not a hardcoded 4", () => {
    expect(buildTrialLine({ ...trial(4), trialLimit: 10 })).toBe(
      "VibeDrift trial: 4 of 10 sessions used.",
    );
  });
});

describe("buildNudgeOutput", () => {
  it("emits the SessionStart context-injection envelope", () => {
    const out = buildNudgeOutput({ repoName: "r" });
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("VibeDrift is installed");
    expect(out.systemMessage).toBeUndefined();
  });

  it("shows a trial systemMessage on a trial account", () => {
    const out = buildNudgeOutput({ repoName: "r", entitlement: trial(1) });
    expect(out.systemMessage).toBe("VibeDrift trial: 1 of 5 sessions used.");
  });

  it("carries the last-free-session notice at the boundary", () => {
    const out = buildNudgeOutput({ repoName: "r", entitlement: trial(4) });
    expect(out.systemMessage).toContain("This is your last free session.");
  });

  it("the final ask folds in the breadcrumb, overriding the trial line", () => {
    const out = buildNudgeOutput({ repoName: "r", entitlement: trial(1), lastAsk: true });
    expect(out.systemMessage).toContain("vibedrift enable");
    expect(out.systemMessage).not.toContain("trial:");
  });
});

describe("buildLockNotice (the native path's paywall signal)", () => {
  const locked = {
    entitled: false,
    reason: "locked" as const,
    plan: "free" as const,
    trialUsed: 5,
    trialLimit: 5,
  };

  it("tells the user, in one user-visible line, that capture is paused", () => {
    const out = buildLockNotice({ entitlement: locked });
    expect(out.systemMessage).toContain("5-session trial");
    expect(out.systemMessage?.toLowerCase()).toContain("not being recorded");
  });

  it("names the upgrade path", () => {
    const out = buildLockNotice({ entitlement: locked });
    expect(out.systemMessage).toContain("Pro");
    expect(out.systemMessage).toContain("$15/mo");
    expect(out.systemMessage).toContain("vibedrift.ai/dashboard/billing");
  });

  it("recaps real totals, machine-scoped, when the watch caught drift", () => {
    const out = buildLockNotice({ entitlement: locked, totals: { flagged: 14, resolved: 9, complete: true } });
    expect(out.systemMessage).toContain(
      "On this machine, VibeDrift flagged 14 drifts; your agent fixed 9 on the spot, re-verified. Keep it in the loop: Pro, $15/mo. vibedrift.ai/dashboard/billing",
    );
    // local ledgers are not the trial ledger: never attribute the sums to it
    expect(out.systemMessage).not.toContain("Across your");
  });

  it("pluralizes a single caught drift", () => {
    const out = buildLockNotice({ entitlement: locked, totals: { flagged: 1, resolved: 1, complete: true } });
    expect(out.systemMessage).toContain("VibeDrift flagged 1 drift; your agent fixed 1 on the spot");
    expect(out.systemMessage).not.toContain("1 drifts");
  });

  it("says none were fixed instead of fixed 0", () => {
    const out = buildLockNotice({ entitlement: locked, totals: { flagged: 3, resolved: 0, complete: true } });
    expect(out.systemMessage).toContain(
      "VibeDrift flagged 3 drifts; none were fixed in-session. Keep it in the loop:",
    );
    expect(out.systemMessage).not.toContain("fixed 0");
  });

  it("recaps totals at a non-default server limit", () => {
    const out = buildLockNotice({
      entitlement: { ...locked, trialUsed: 12, trialLimit: 12 },
      totals: { flagged: 3, resolved: 2, complete: true },
    });
    expect(out.systemMessage).toContain("12-session trial is used up");
    expect(out.systemMessage).toContain(
      "On this machine, VibeDrift flagged 3 drifts; your agent fixed 2 on the spot, re-verified.",
    );
  });

  it("claims a clean run only when every ledger was read in full", () => {
    const out = buildLockNotice({ entitlement: locked, totals: { flagged: 0, resolved: 0, complete: true } });
    expect(out.systemMessage).toContain(
      "Your watched sessions on this machine ran clean. Pro keeps the watch on: $15/mo. vibedrift.ai/dashboard/billing",
    );
    expect(out.systemMessage).not.toContain("On this machine, VibeDrift flagged");
  });

  it("claims nothing when a partial read found no drift", () => {
    const out = buildLockNotice({ entitlement: locked, totals: { flagged: 0, resolved: 0, complete: false } });
    expect(out.systemMessage).not.toContain("ran clean");
    expect(out.systemMessage).not.toContain("flagged");
    expect(out.systemMessage).toContain("Keep it in the loop: Pro, $15/mo. vibedrift.ai/dashboard/billing");
  });

  it("claims nothing when no ledgers were readable (never invented copy)", () => {
    const out = buildLockNotice({ entitlement: locked, totals: null });
    expect(out.systemMessage).toBe(
      "VibeDrift: your 5-session trial is used up, so this session is not being recorded. " +
        "Keep it in the loop: Pro, $15/mo. vibedrift.ai/dashboard/billing",
    );
  });

  it("claims nothing about prevention or deletion (honesty constraint)", () => {
    for (const totals of [null, { flagged: 3, resolved: 2, complete: true }, { flagged: 0, resolved: 0, complete: false }]) {
      const msg = buildLockNotice({ entitlement: locked, totals }).systemMessage ?? "";
      for (const banned of ["prevented", "blocked", "deleted", "erased"]) {
        expect(msg.toLowerCase()).not.toContain(banned);
      }
    }
  });

  it("carries no model-facing instruction — this is a user notice, not a nudge", () => {
    expect(buildLockNotice({ entitlement: locked })).not.toHaveProperty("hookSpecificOutput");
  });

  it("uses the server's real trial limit rather than a hardcoded 5", () => {
    const out = buildLockNotice({ entitlement: { ...locked, trialUsed: 12, trialLimit: 12 } });
    expect(out.systemMessage).toContain("12-session trial");
  });
});
