import { describe, it, expect } from "vitest";
import { loggingConsistency } from "../../../src/drift/logging-consistency.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function makeCtx(files: Partial<DriftFile>[]): DriftContext {
  const fullFiles: DriftFile[] = files.map((f) => ({
    relativePath: f.relativePath ?? "src/test.ts",
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
      relativePath: `src/svc${i}.ts`,
      language: "typescript" as const,
      content: `import winston from "winston";\nconst logger = winston.createLogger({});\nlogger.info("started");\n`,
    }));
    const consoleFile = {
      relativePath: "src/odd.ts",
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
      relativePath: `src/f${i}.ts`,
      language: "typescript" as const,
      content: `console.log("hi");\nconsole.error("bye");\n`,
    }));
    const ctx = makeCtx(files);
    expect(loggingConsistency.detect(ctx)).toHaveLength(0);
  });

  it("does not name absent libraries when the structured logger is a console wrapper", () => {
    // 5 files use a project-local `logger.*` wrapper (no winston/pino/etc
    // anywhere), 1 file uses raw console.* — mirrors the bandcamp repo where
    // createLogger() wraps console.* and NO third-party logger is installed.
    const wrapperFiles = Array.from({ length: 5 }, (_, i) => ({
      relativePath: `src/svc${i}.ts`,
      language: "typescript" as const,
      content: `import { logger } from "./debug";\nlogger.info("started");\nlogger.warn("careful");\n`,
    }));
    const consoleFile = {
      relativePath: "src/odd.ts",
      language: "typescript" as const,
      content: `console.log("hello");\nconsole.error("bad");\n`,
    };
    const ctx = makeCtx([...wrapperFiles, consoleFile]);
    const findings = loggingConsistency.detect(ctx);
    expect(findings).toHaveLength(1);
    const text = `${findings[0].finding} ${findings[0].recommendation} ${findings[0].dominantPattern}`;
    // The false positive: asserting libraries that are not in the project.
    expect(text).not.toMatch(/winston|pino|bunyan|log4js/i);
  });

  it("still names winston when it is actually present in the code", () => {
    const winstonFiles = Array.from({ length: 5 }, (_, i) => ({
      relativePath: `src/svc${i}.ts`,
      language: "typescript" as const,
      content: `import winston from "winston";\nconst logger = winston.createLogger({});\nlogger.info("started");\n`,
    }));
    const consoleFile = {
      relativePath: "src/odd.ts",
      language: "typescript" as const,
      content: `console.log("hello");\nconsole.error("bad");\n`,
    };
    const ctx = makeCtx([...winstonFiles, consoleFile]);
    const findings = loggingConsistency.detect(ctx);
    expect(findings).toHaveLength(1);
    const text = `${findings[0].finding} ${findings[0].recommendation} ${findings[0].dominantPattern}`;
    expect(text).toMatch(/winston/i);
  });

  describe("intent-hint seeding", () => {
    it("emits divergence when team declares winston but code uses console.log", () => {
      // 5 console.log files. CLAUDE.md declares structured logging.
      const consoleFiles = Array.from({ length: 5 }, (_, i) => ({
        relativePath: `src/f${i}.ts`,
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
        relativePath: `src/svc${i}.ts`,
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

describe("logging-consistency: the vote is partitioned by language", () => {
  it("does not flag TypeScript console files as deviating from Python's logging module", () => {
    // Three of the five families are language-exclusive: a TS file cannot use
    // `logging.getLogger`, and a .py file cannot use `console.log`. Pooling them
    // made the majority language's choice the "convention" and every file in the
    // other language a deviator — a language artifact, not a logger decision.
    const py = Array.from({ length: 10 }, (_, i) => ({
      relativePath: `app/svc${i}.py`,
      language: "python" as const,
      content: `import logging\nlog = logging.getLogger(__name__)\nlog.info("hi")\n`,
    }));
    const ts = Array.from({ length: 3 }, (_, i) => ({
      relativePath: `web/svc${i}.ts`,
      language: "typescript" as const,
      content: `export function go${i}() { console.log("hi"); }\n`,
    }));
    expect(loggingConsistency.detect(makeCtx([...py, ...ts]))).toHaveLength(0);
  });

  it("still flags a genuine mix inside one language", () => {
    const winston = Array.from({ length: 4 }, (_, i) => ({
      relativePath: `web/svc${i}.ts`,
      language: "typescript" as const,
      content: `import winston from "winston";\nconst logger = winston.createLogger({});\nlogger.info("started");\n`,
    }));
    const consoleFile = [{
      relativePath: "web/odd.ts",
      language: "typescript" as const,
      content: `export function odd() { console.log("nope"); }\n`,
    }];
    const py = Array.from({ length: 5 }, (_, i) => ({
      relativePath: `app/svc${i}.py`,
      language: "python" as const,
      content: `import logging\nlog = logging.getLogger(__name__)\nlog.info("hi")\n`,
    }));
    const findings = loggingConsistency.detect(makeCtx([...winston, ...consoleFile, ...py]));
    expect(findings).toHaveLength(1);
    expect(findings[0].deviatingFiles.map((d) => d.path)).toEqual(["web/odd.ts"]);
    // The Python files are not in the denominator of the TypeScript vote.
    expect(findings[0].totalRelevantFiles).toBe(5);
  });
});

describe("logging-consistency: intent-hint vocabulary guard", () => {
  function withHint(files: Partial<DriftFile>[], pattern: string): DriftContext {
    return {
      ...makeCtx(files),
      intentHints: [{
        category: "logging_consistency",
        pattern,
        label: "structured logger",
        source: "CLAUDE.md",
        line: 4,
        text: "- Use a structured logger",
        confidence: 0.95,
      }],
    };
  }

  // Three TypeScript files, one per logger family, so no real family's weight
  // exceeds 1. `seedDominanceVote` injects a declared pattern the distribution
  // does not hold with weight 1 + confidence (~1.95), which therefore wins the
  // vote outright with a count of ZERO.
  const oneEach = [
    { relativePath: "src/a.ts", language: "typescript" as const, content: `console.log("a");
` },
    { relativePath: "src/b.ts", language: "typescript" as const, content: `import pino from "pino";
const logger = pino();
logger.info("b");
` },
    { relativePath: "src/c.ts", language: "typescript" as const, content: `const debug = require("debug")("c");
debug("c");
` },
  ];

  it("an out-of-vocabulary declaration does not seed, so no phantom dominant is reported", () => {
    // `winston` is a LABEL a team writes, not a key of the detector's
    // LoggerFamily enum (`structured` is). Seeded, it out-weighed every real
    // family and produced a finding whose dominantPattern was
    // `familyNames["winston"]` — undefined — with consistencyScore 0.
    // Guarded, the hint is absent and the 1/3 plurality fails the 60% gate.
    expect(loggingConsistency.detect(withHint(oneEach, "winston"))).toHaveLength(0);
  });

  it("an in-vocabulary declaration binds without ever reporting a zero-count dominant", () => {
    for (const pattern of ["structured", "console", "debug_pkg"]) {
      const findings = loggingConsistency.detect(withHint(oneEach, pattern));
      for (const f of findings) {
        expect(f.dominantCount).toBeGreaterThan(0);
        expect(f.consistencyScore).toBeGreaterThan(0);
        expect(f.dominantPattern).toBeTruthy();
        expect(f.dominantPattern).not.toContain("undefined");
      }
    }
  });

});
