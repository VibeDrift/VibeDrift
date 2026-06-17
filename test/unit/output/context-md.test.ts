import { describe, it, expect } from "vitest";

import { buildContextMarkdown } from "../../../src/output/context-md.js";

function minimalResult() {
  return {
    compositeScore: 80,
    maxCompositeScore: 100,
    context: { dominantLanguage: "typescript", files: [{}, {}], totalLines: 1000 },
    driftFindings: [],
    findings: [],
  } as any;
}

describe("buildContextMarkdown referral link", () => {
  it("includes a vibedrift.ai link so a committed context.md is a silent referral", () => {
    const md = buildContextMarkdown(minimalResult(), "acme-app");
    expect(md).toContain("https://vibedrift.ai");
  });

  it("still renders the project name and score", () => {
    const md = buildContextMarkdown(minimalResult(), "acme-app");
    expect(md).toContain("acme-app");
    expect(md).toContain("Vibe Drift Score");
  });
});
