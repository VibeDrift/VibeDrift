import { describe, it, expect } from "vitest";
import { securityAnalyzer } from "../../../src/analyzers/security.js";
import { computeScores } from "../../../src/scoring/engine.js";
import type { AnalysisContext, Finding, SourceFile, SupportedLanguage } from "../../../src/core/types.js";

function makeCtx(files: (Partial<SourceFile> & { language?: SupportedLanguage })[]): AnalysisContext {
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

describe("security analyzer: floor subset + demoted subset", () => {
  describe("floor rules emit under the security-floor analyzer id (D1)", () => {
    it("private-key finding is analyzerId 'security-floor'", async () => {
      const ctx = makeCtx([
        { relativePath: "key.ts", content: 'const k = "-----BEGIN RSA PRIVATE KEY-----";\n' },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /private key/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security-floor");
    });

    it("aws-key finding is analyzerId 'security-floor'", async () => {
      const ctx = makeCtx([
        { relativePath: "creds.ts", content: 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n' },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /AWS access key/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security-floor");
    });

    it("hardcoded-api-key finding is analyzerId 'security-floor'", async () => {
      const ctx = makeCtx([
        { relativePath: "a.ts", content: 'const apiKey = "abcdefghijklmnopqrstuv";\n' },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /hardcoded API key/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security-floor");
    });

    it("hardcoded-token finding is analyzerId 'security-floor'", async () => {
      const ctx = makeCtx([
        { relativePath: "auth.ts", content: 'const token = "abcdefghijklmnopqrstuvwxyz0123456789";\n' },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /hardcoded authentication token/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security-floor");
    });

    it("go-tls-skip-verify finding is analyzerId 'security-floor'", async () => {
      const ctx = makeCtx([
        {
          relativePath: "client.go",
          language: "go",
          content: "tlsConfig := &tls.Config{InsecureSkipVerify: true}\n",
        },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /TLS certificate verification disabled/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security-floor");
    });
  });

  describe("demoted rules stay under 'security' but drop to info + 'demoted' tag", () => {
    it("innerHTML assignment is demoted (analyzerId stays 'security')", async () => {
      const ctx = makeCtx([
        { relativePath: "view.ts", content: "el.innerHTML = userInput;\n" },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /innerHTML assignment/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security");
      expect(hit!.severity).toBe("info");
      expect(hit!.tags).toContain("demoted");
    });

    it("ssrf-risk is demoted", async () => {
      const ctx = makeCtx([
        { relativePath: "data.ts", content: "fetch(`/api/data/${id}`);\n" },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /URL constructed from variable/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security");
      expect(hit!.severity).toBe("info");
      expect(hit!.tags).toContain("demoted");
    });

    it("math-random-crypto is demoted", async () => {
      const ctx = makeCtx([
        {
          relativePath: "session.ts",
          content: "function generateSessionToken() {\n  return Math.random().toString(36).slice(2);\n}\n",
        },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /Math\.random\(\) is not cryptographically secure/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security");
      expect(hit!.severity).toBe("info");
      expect(hit!.tags).toContain("demoted");
    });

    it("path-traversal is demoted", async () => {
      const ctx = makeCtx([
        { relativePath: "files.ts", content: "fs.readFileSync(basePath + userInput);\n" },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /path traversal/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security");
      expect(hit!.severity).toBe("info");
      expect(hit!.tags).toContain("demoted");
    });

    it("rust-unsafe is demoted", async () => {
      const ctx = makeCtx([
        {
          relativePath: "mem.rs",
          language: "rust",
          content: "fn foo() {\n    unsafe { ptr::read(x) };\n}\n",
        },
      ]);
      const findings = await securityAnalyzer.analyze(ctx);
      const hit = findings.find((f) => /Unsafe block/i.test(f.message));
      expect(hit).toBeDefined();
      expect(hit!.analyzerId).toBe("security");
      expect(hit!.severity).toBe("info");
      expect(hit!.tags).toContain("demoted");
    });
  });

  describe("composite invariance (constraint: hygiene never dents the Vibe Drift composite)", () => {
    function driftFinding(): Finding {
      // A real drift-kind finding so the composite starts below 100 — makes
      // the invariance assertion meaningful rather than a vacuous 100 === 100.
      return {
        analyzerId: "naming",
        severity: "error",
        confidence: 0.9,
        message: "naming drift",
        locations: [{ file: "src/a.ts", line: 1 }],
        tags: [],
      };
    }

    function floorFinding(): Finding {
      return {
        analyzerId: "security-floor",
        severity: "error",
        confidence: 0.95,
        message: "AWS access key ID detected in creds.ts:1",
        locations: [{ file: "creds.ts", line: 1 }],
        tags: ["security", "secrets", "aws"],
      };
    }

    it("adding a security-floor finding does not change compositeScore", () => {
      const base = [driftFinding(), driftFinding()];
      const without = computeScores(base, 30000);
      const withFloor = computeScores([...base, floorFinding()], 30000);

      expect(without.compositeScore).toBeLessThan(without.maxCompositeScore);
      expect(withFloor.compositeScore).toBe(without.compositeScore);
      expect(withFloor.scores.securityPosture.score).toBe(without.scores.securityPosture.score);

      // Sanity: the security-floor finding IS being processed (proves the
      // invariance above isn't vacuous — it lands on the hygiene track).
      expect(withFloor.hygieneScore).toBeLessThan(without.hygieneScore);
    });

    it("a security-floor-only finding set still scores 100 on the drift composite", () => {
      const { compositeScore, maxCompositeScore } = computeScores([floorFinding()], 30000);
      expect(compositeScore).toBe(maxCompositeScore);
    });
  });
});
