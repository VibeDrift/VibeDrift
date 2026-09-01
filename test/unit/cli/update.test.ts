import { describe, it, expect } from "vitest";

import {
  npmGlobalInstallSpawn,
  isSafeVersionToken,
  semverGreater,
} from "../../../src/cli/commands/update.js";

describe("npmGlobalInstallSpawn", () => {
  it("routes through the shell as one command string (Windows npm.cmd + avoids DEP0190)", () => {
    const { command, options } = npmGlobalInstallSpawn("@vibedrift/cli@0.9.3");
    // One command string (not command + args array): a shell is needed so
    // Windows resolves npm.cmd, and passing args alongside shell:true triggers
    // Node's DEP0190 deprecation. A single string avoids it.
    expect(command).toBe("npm i -g @vibedrift/cli@0.9.3");
    expect(options.shell).toBe(true);
    expect(options.stdio).toBe("inherit");
  });
});

describe("isSafeVersionToken", () => {
  it("accepts plain semver and prerelease/build tokens", () => {
    expect(isSafeVersionToken("0.9.3")).toBe(true);
    expect(isSafeVersionToken("1.2.3-beta.1")).toBe(true);
    expect(isSafeVersionToken("1.2.3+build.5")).toBe(true);
  });

  it("rejects anything with shell metacharacters (we interpolate into a shell command)", () => {
    expect(isSafeVersionToken("0.9.3; rm -rf /")).toBe(false);
    expect(isSafeVersionToken("0.9.3 && curl evil")).toBe(false);
    expect(isSafeVersionToken("$(whoami)")).toBe(false);
    expect(isSafeVersionToken("")).toBe(false);
  });
});

describe("semverGreater", () => {
  it("compares plain semver as before", () => {
    expect(semverGreater("1.2.4", "1.2.3")).toBe(true);
    expect(semverGreater("1.2.3", "1.2.4")).toBe(false);
    expect(semverGreater("2.0.0", "1.9.9")).toBe(true);
    expect(semverGreater("1.2.3", "1.2.3")).toBe(false);
  });

  // Regression: Number("3-beta") is NaN, which used to make every comparison
  // touching a prerelease-suffixed segment silently no-op — a real update to
  // a prerelease build reported "Nothing to do".
  it("a higher core version wins even when the higher side carries a prerelease tag", () => {
    // 1.2.4-beta is a newer BUILD than 1.2.3 — the core version moved forward.
    expect(semverGreater("1.2.4-beta", "1.2.3")).toBe(true);
    expect(semverGreater("1.2.3", "1.2.4-beta")).toBe(false);
  });

  it("does not false-negative when only the current (lower) side has a prerelease tag", () => {
    // Current build is a prerelease of 1.2.3; the registry has moved on to
    // the real 1.2.4 — must still report an update is available.
    expect(semverGreater("1.2.4", "1.2.3-beta")).toBe(true);
  });

  it("a real release outranks a prerelease of the SAME core version", () => {
    expect(semverGreater("1.2.3", "1.2.3-beta")).toBe(true);
    expect(semverGreater("1.2.3-beta", "1.2.3")).toBe(false);
  });

  it("two prereleases of the same core are not treated as equal-and-stuck", () => {
    expect(semverGreater("1.2.3-beta", "1.2.3-beta")).toBe(false);
    expect(semverGreater("1.2.3-rc", "1.2.3-beta")).toBe(true);
  });

  it("ignores build metadata for precedence", () => {
    expect(semverGreater("1.2.3+build.5", "1.2.3")).toBe(false);
    expect(semverGreater("1.2.4+build.5", "1.2.3")).toBe(true);
  });
});
