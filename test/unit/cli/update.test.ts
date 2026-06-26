import { describe, it, expect } from "vitest";

import {
  npmGlobalInstallSpawn,
  isSafeVersionToken,
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
