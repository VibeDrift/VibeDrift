import { describe, it, expect } from "vitest";

import { misroutedSubcommandHint } from "../../../src/cli/commands/scan.js";

describe("misroutedSubcommandHint", () => {
  it("hints when a bare subcommand name was swallowed as a scan path (stale CLI)", () => {
    const hint = misroutedSubcommandHint("mcp");
    expect(hint).not.toBeNull();
    expect(hint).toContain("mcp");
    expect(hint).toMatch(/out of date|update|upgrade|latest/i);
  });

  it("covers other subcommands a stale build would lack", () => {
    expect(misroutedSubcommandHint("login")).not.toBeNull();
    expect(misroutedSubcommandHint("doctor")).not.toBeNull();
  });

  it("returns null for a real (non-subcommand) path so normal scans are unaffected", () => {
    expect(misroutedSubcommandHint("./my-project")).toBeNull();
    expect(misroutedSubcommandHint("src")).toBeNull();
    expect(misroutedSubcommandHint(".")).toBeNull();
  });

  it("does not false-positive on a real path that merely ends in a subcommand name", () => {
    // `packages/mcp` is a legitimate directory; only a bare `mcp` token is suspect.
    expect(misroutedSubcommandHint("./packages/mcp")).toBeNull();
    expect(misroutedSubcommandHint("packages/login")).toBeNull();
  });
});
