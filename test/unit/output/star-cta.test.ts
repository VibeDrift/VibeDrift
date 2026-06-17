import { describe, it, expect } from "vitest";

import { renderStarCta } from "../../../src/output/terminal.js";

describe("renderStarCta", () => {
  it("is hidden (no lines) when no public repo is configured — gated until the OSS repo is live", () => {
    expect(renderStarCta("")).toEqual([]);
  });

  it("renders one star line linking to the repo when a URL is configured", () => {
    const lines = renderStarCta("https://github.com/acme/vibedrift");
    expect(lines.length).toBe(1);
    expect(lines.join("\n")).toContain("https://github.com/acme/vibedrift");
    expect(lines.join("\n")).toMatch(/star/i);
  });

  it("defaults to the gated (empty) constant, so the CTA stays off until enabled", () => {
    // No argument → uses GITHUB_REPO_URL, which is empty today.
    expect(renderStarCta()).toEqual([]);
  });
});
