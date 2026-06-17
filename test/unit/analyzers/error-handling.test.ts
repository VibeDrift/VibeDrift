import { describe, it, expect } from "vitest";
import { errorHandlingAnalyzer } from "../../../src/analyzers/error-handling.js";
import type { AnalysisContext } from "../../../src/core/types.js";

const BASE: Omit<AnalysisContext, "files" | "totalLines"> = {
  rootDir: "/test",
  packageJson: null,
  goMod: null,
  cargoToml: null,
  requirementsTxt: null,
  envExample: null,
  languageBreakdown: new Map(),
  dominantLanguage: null,
};

describe("error-handling analyzer", () => {
  it("detects empty catch blocks", async () => {
    const ctx: AnalysisContext = {
      ...BASE,
      files: [{
        path: "/test/a.ts", relativePath: "a.ts", language: "typescript",
        content: "try { foo(); } catch (e) {}\ntry { bar(); } catch (e) {}\n",
        lineCount: 2,
      }],
      totalLines: 2,
    };
    const findings = await errorHandlingAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("empty-catch"))).toBeDefined();
    expect(findings[0].message).toContain("2 empty catch");
  });
});
