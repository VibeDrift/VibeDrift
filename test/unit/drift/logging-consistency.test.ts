import { describe, it, expect } from "vitest";
import { loggingConsistency } from "../../../src/drift/logging-consistency.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function makeCtx(files: Partial<DriftFile>[]): DriftContext {
  const fullFiles: DriftFile[] = files.map((f) => ({
    path: f.path ?? "src/test.ts",
    language: f.language ?? "typescript",
    content: f.content ?? "",
    lineCount: (f.content ?? "").split("\n").length,
  }));
  return {
    files: fullFiles,
    totalLines: fullFiles.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

describe("logging-consistency detector", () => {
  it("flags the single console.log file in a winston-dominated project", () => {
    const winstonFiles = Array.from({ length: 4 }, (_, i) => ({
      path: `src/svc${i}.ts`,
      language: "typescript" as const,
      content: `import winston from "winston";\nconst logger = winston.createLogger({});\nlogger.info("started");\n`,
    }));
    const consoleFile = {
      path: "src/odd.ts",
      language: "typescript" as const,
      content: `console.log("hello");\nconsole.error("bad");\n`,
    };
    const ctx = makeCtx([...winstonFiles, consoleFile]);
    const findings = loggingConsistency.detect(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].deviatingFiles.some((d) => d.path.includes("odd.ts"))).toBe(true);
    expect(findings[0].dominantPattern).toContain("structured");
  });

  it("returns no finding when only console.log is used across the project", () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      path: `src/f${i}.ts`,
      language: "typescript" as const,
      content: `console.log("hi");\nconsole.error("bye");\n`,
    }));
    const ctx = makeCtx(files);
    expect(loggingConsistency.detect(ctx)).toHaveLength(0);
  });

  describe("intent-hint seeding", () => {
    it("emits divergence when team declares winston but code uses console.log", () => {
      // 5 console.log files. CLAUDE.md declares structured logging.
      const consoleFiles = Array.from({ length: 5 }, (_, i) => ({
        path: `src/f${i}.ts`,
        language: "typescript" as const,
        content: `console.log("hi");\nconsole.error("bye");\n`,
      }));
      const ctx: DriftContext = {
        ...makeCtx(consoleFiles),
        intentHints: [{
          category: "logging_consistency",
          pattern: "structured",
          label: "structured logger",
          source: "CLAUDE.md",
          line: 5,
          text: "use winston for all logging",
          confidence: 0.9,
        }],
      };

      const findings = loggingConsistency.detect(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0].finding).toContain("declared");
      expect(findings[0].finding).toContain("CLAUDE.md");
    });

    it("no finding when code unanimously matches the declared logger", () => {
      const winstonFiles = Array.from({ length: 5 }, (_, i) => ({
        path: `src/svc${i}.ts`,
        language: "typescript" as const,
        content: `import winston from "winston";\nlogger.info("hi");\n`,
      }));
      const ctx: DriftContext = {
        ...makeCtx(winstonFiles),
        intentHints: [{
          category: "logging_consistency",
          pattern: "structured",
          label: "structured logger",
          source: "CLAUDE.md",
          line: 5,
          text: "use winston",
          confidence: 0.9,
        }],
      };

      // Everyone agrees with the declaration → no deviators, no divergence.
      expect(loggingConsistency.detect(ctx)).toHaveLength(0);
    });
  });
});
