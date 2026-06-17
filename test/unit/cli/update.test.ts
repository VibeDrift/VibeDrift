import { describe, it, expect } from "vitest";

import {
  npmGlobalInstallSpawn,
  isSafeVersionToken,
} from "../../../src/cli/commands/update.js";

describe("npmGlobalInstallSpawn", () => {
  it("routes through the shell so Windows can resolve npm.cmd (fixes spawn npm ENOENT)", () => {
    const { command, args, options } = npmGlobalInstallSpawn("@vibedrift/cli@0.9.3");
    expect(command).toBe("npm");
    expect(args).toEqual(["i", "-g", "@vibedrift/cli@0.9.3"]);
    // The bug was shell:false — npm is npm.cmd on Windows and Node refuses to
    // spawn a .cmd without a shell. shell:true is the cross-platform fix.
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
