import { describe, it, expect } from "vitest";
import { buildEmbeddedPrompts } from "../../../src/output/html.js";

function resultWithFinding() {
  return {
    context: { rootDir: "/r/proj", dominantLanguage: "typescript", files: [{}, {}] },
    findings: [
      {
        analyzerId: "drift-architectural_consistency",
        severity: "warning",
        confidence: 0.8,
        message: "DRIFT: src/order.ts uses raw SQL while peers use a repository",
        locations: [{ file: "src/order.ts", line: 1 }],
        tags: [],
        consistencyImpact: 1.2,
        metadata: { dominantPattern: "repository", dominantFiles: ["src/repo.ts"], recommendation: "Use the repository." },
      },
    ],
  } as any;
}

describe("buildEmbeddedPrompts — paid gate", () => {
  it("FREE: same keys, but every value is an upsell (no fix-prompt markdown in source)", () => {
    const map = JSON.parse(buildEmbeddedPrompts(resultWithFinding(), false)) as Record<string, string>;
    const values = Object.values(map);
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) {
      expect(v).toMatch(/Pro\/Scale feature/);
      expect(v).toContain("vibedrift upgrade");
      expect(v).not.toContain("## VibeDrift"); // no real prompt header leaks
      expect(v).not.toContain("What's drifting"); // no real prompt body leaks
    }
    expect(Object.keys(map)).toContain("__full_fix_plan__"); // keys preserved so buttons resolve
  });

  it("PAID: emits the real fix prompts", () => {
    const map = JSON.parse(buildEmbeddedPrompts(resultWithFinding(), true)) as Record<string, string>;
    expect(map.__full_fix_plan__).toContain("VibeDrift Fix Plan");
    const perFinding = Object.entries(map).find(([k]) => k !== "__full_fix_plan__")?.[1] as string;
    expect(perFinding).toMatch(/What's drifting|VibeDrift Drift Finding/);
  });
});
