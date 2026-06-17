import { describe, it, expect } from "vitest";

import { referralFooter } from "../../../src/output/fix-prompt.js";

describe("referralFooter", () => {
  it("links to vibedrift.ai (with a project name)", () => {
    const footer = referralFooter("acme-app");
    expect(footer).toContain("https://vibedrift.ai");
    expect(footer).toContain("acme-app");
  });

  it("links to vibedrift.ai (without a project name)", () => {
    expect(referralFooter()).toContain("https://vibedrift.ai");
  });
});
