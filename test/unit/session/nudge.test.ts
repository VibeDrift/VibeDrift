import { describe, it, expect } from "vitest";
import {
  isNewInteractiveSource,
  isNonInteractive,
  buildNudgeInstruction,
  buildNudgeOutput,
  buildLockNotice,
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
    expect(out.systemMessage).toContain("vibedrift upgrade");
  });

  it("claims nothing about prevention or deletion (honesty constraint)", () => {
    const msg = buildLockNotice({ entitlement: locked }).systemMessage ?? "";
    for (const banned of ["prevented", "blocked", "deleted", "erased"]) {
      expect(msg.toLowerCase()).not.toContain(banned);
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
