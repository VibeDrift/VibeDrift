import { describe, it, expect, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { vibedriftHome, isSandboxHome } from "@/core/vibedrift-home";
import { entitlementDir } from "@/session/entitlement";
import { defaultSessionsDir } from "@/session/repo";

const ORIGINAL = process.env.VIBEDRIFT_HOME;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.VIBEDRIFT_HOME;
  else process.env.VIBEDRIFT_HOME = ORIGINAL;
});

describe("vibedriftHome", () => {
  it("defaults to ~/.vibedrift when the override is unset", () => {
    delete process.env.VIBEDRIFT_HOME;
    expect(vibedriftHome()).toBe(join(homedir(), ".vibedrift"));
    expect(isSandboxHome()).toBe(false);
  });

  it("honors VIBEDRIFT_HOME and trims whitespace", () => {
    process.env.VIBEDRIFT_HOME = "  /tmp/vd-sandbox  ";
    expect(vibedriftHome()).toBe("/tmp/vd-sandbox");
    expect(isSandboxHome()).toBe(true);
  });

  it("resolves a relative override to an absolute path (never cwd-anchored state)", () => {
    process.env.VIBEDRIFT_HOME = "sandbox-rel";
    const got = vibedriftHome();
    expect(got.startsWith("/") || /^[A-Za-z]:[\\/]/.test(got)).toBe(true);
    expect(got.endsWith("sandbox-rel")).toBe(true);
  });

  it("treats a blank override as unset (no accidental relative-path state)", () => {
    process.env.VIBEDRIFT_HOME = "   ";
    expect(vibedriftHome()).toBe(join(homedir(), ".vibedrift"));
    expect(isSandboxHome()).toBe(false);
  });

  it("moves the call-time state dirs with the override", () => {
    process.env.VIBEDRIFT_HOME = "/tmp/vd-sandbox";
    expect(entitlementDir()).toBe("/tmp/vd-sandbox");
    expect(defaultSessionsDir()).toBe(join("/tmp/vd-sandbox", "sessions"));
  });

  it("reads the env at call time, not import time", () => {
    delete process.env.VIBEDRIFT_HOME;
    const before = vibedriftHome();
    process.env.VIBEDRIFT_HOME = "/tmp/vd-late";
    expect(vibedriftHome()).toBe("/tmp/vd-late");
    expect(vibedriftHome()).not.toBe(before);
  });
});
