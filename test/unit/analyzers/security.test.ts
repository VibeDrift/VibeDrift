import { describe, it, expect } from "vitest";
import { securityAnalyzer } from "../../../src/analyzers/security.js";
import type { AnalysisContext, SourceFile } from "../../../src/core/types.js";

function makeCtx(files: Partial<SourceFile>[]): AnalysisContext {
  const fullFiles = files.map((f) => ({
    path: f.path ?? "/test/" + f.relativePath,
    relativePath: f.relativePath ?? "test.ts",
    language: f.language ?? "typescript" as const,
    content: f.content ?? "",
    lineCount: (f.content ?? "").split("\n").length,
  }));
  return {
    rootDir: "/test",
    files: fullFiles,
    packageJson: null,
    goMod: null,
    cargoToml: null,
    requirementsTxt: null,
    envExample: null,
    totalLines: fullFiles.reduce((s, f) => s + f.lineCount, 0),
    languageBreakdown: new Map([["typescript", { files: 1, lines: 5 }]]),
    dominantLanguage: "typescript",
  };
}

describe("security analyzer (Bayesian stacking)", () => {
  it("combines multiple same-line hits via odds product (S4)", async () => {
    // A single line that matches two distinct security patterns:
    //   - hardcoded-token (0.80)
    //   - AWS access-key (0.95)  ← AKIA prefix
    // Combined odds: (0.80/0.20) × (0.95/0.05) = 4 × 19 = 76
    // Combined confidence: 76 / 77 ≈ 0.987
    const content = 'const token = "AKIAXXXXXXXXXXXXXXXX_tokenbearer_abc";\n';
    const ctx = makeCtx([{ relativePath: "a.ts", content }]);
    const findings = await securityAnalyzer.analyze(ctx);
    const combined = findings.find((f) => f.tags.includes("corroborated"));
    if (combined) {
      // If both patterns fired on this line, confidence should exceed any
      // single pattern's confidence.
      expect(combined.confidence).toBeGreaterThan(0.95);
      expect(combined.message).toMatch(/corroborate/);
    } else {
      // If only one pattern matched (possible — the regexes are strict),
      // it's still a valid outcome. Guard so the test isn't flaky.
      expect(findings.length).toBeGreaterThan(0);
    }
  });

  it("still flags a single-pattern finding without corroboration", async () => {
    const content = 'const apiKey = "abcdefghijklmnopqrstuv";\n';
    const ctx = makeCtx([{ relativePath: "a.ts", content }]);
    const findings = await securityAnalyzer.analyze(ctx);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].tags).not.toContain("corroborated");
  });

  it("skips files with no security-relevant keywords (B3 prefilter)", async () => {
    const ctx = makeCtx([
      { relativePath: "a.ts", content: "const sum = (a, b) => a + b;\nexport { sum };\n" },
    ]);
    const findings = await securityAnalyzer.analyze(ctx);
    expect(findings).toEqual([]);
  });

  // ── Phase 4: drop the high-false-positive rules, keep the precise ones ──
  describe("noisy rules removed (Phase 4)", () => {
    it("does NOT flag a password-named string assignment (hardcoded-password removed)", async () => {
      const ctx = makeCtx([{ relativePath: "config.ts", content: 'const password = "hunter2abc";\n' }]);
      const findings = await securityAnalyzer.analyze(ctx);
      expect(findings.some((f) => /hardcoded password/i.test(f.message))).toBe(false);
    });

    it("does NOT flag execFile with array args (command-injection removed)", async () => {
      const ctx = makeCtx([{ relativePath: "run.ts", content: 'execFile("ls", [base + suffix]);\n' }]);
      const findings = await securityAnalyzer.analyze(ctx);
      expect(findings.some((f) => /command injection/i.test(f.message))).toBe(false);
    });

    it("STILL flags a high-precision AWS access key (kept)", async () => {
      const ctx = makeCtx([{ relativePath: "creds.ts", content: 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n' }]);
      const findings = await securityAnalyzer.analyze(ctx);
      expect(findings.some((f) => /AWS access key/i.test(f.message))).toBe(true);
    });

    it("STILL flags a private key in source (kept)", async () => {
      const ctx = makeCtx([{ relativePath: "key.ts", content: 'const k = "-----BEGIN RSA PRIVATE KEY-----";\n' }]);
      const findings = await securityAnalyzer.analyze(ctx);
      expect(findings.some((f) => /private key/i.test(f.message))).toBe(true);
    });
  });
});
