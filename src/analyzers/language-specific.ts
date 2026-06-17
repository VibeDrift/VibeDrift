import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding } from "../core/types.js";
import { getLineNumber } from "../utils/text.js";

export const languageSpecificAnalyzer: Analyzer = {
  id: "language-specific",
  name: "Language-Specific Patterns",
  category: "architecturalConsistency",
  requiresAST: false,
  applicableLanguages: "all",

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const goFiles = ctx.files.filter((f) => f.language === "go");
    const pyFiles = ctx.files.filter((f) => f.language === "python");
    const rsFiles = ctx.files.filter((f) => f.language === "rust");

    if (goFiles.length > 0) findings.push(...analyzeGo(goFiles));
    if (pyFiles.length > 0) findings.push(...analyzePython(pyFiles));
    if (rsFiles.length > 0) findings.push(...analyzeRust(rsFiles));

    return findings;
  },
};

// ===== Go Analysis =====

function detectGoUncheckedErrors(
  files: any[],
): { count: number; locations: { file: string; line: number; snippet: string }[] } {
  let count = 0;
  const locations: { file: string; line: number; snippet: string }[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Unchecked error: line assigns to err (or _) but next non-blank line doesn't check it
      if (/\berr\s*[:=]/.test(trimmed) && !trimmed.startsWith("//")) {
        // Look at the next non-empty, non-comment line
        let nextLine = "";
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const next = lines[j].trim();
          if (next && !next.startsWith("//")) {
            nextLine = next;
            break;
          }
        }
        if (nextLine && !nextLine.includes("err") && !nextLine.startsWith("return")) {
          count++;
          locations.push({
            file: file.relativePath,
            line: i + 1,
            snippet: trimmed.slice(0, 80),
          });
        }
      }
    }
  }

  return { count, locations };
}

function detectGoNakedGoroutines(
  files: any[],
): { count: number; locations: { file: string; line: number }[] } {
  let count = 0;
  const locations: { file: string; line: number }[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Goroutine: go func() without context.Context in nearby scope
      if (/^\s*go\s+func\s*\(/.test(line) || /^\s*go\s+\w+\s*\(/.test(line)) {
        // Check if context is passed (heuristic: "ctx" in the go call or surrounding 3 lines)
        const nearby = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
        if (!/\bctx\b/.test(nearby) && !/context\./.test(nearby)) {
          count++;
          locations.push({ file: file.relativePath, line: i + 1 });
        }
      }
    }
  }

  return { count, locations };
}

function detectGoUnsafeMutex(
  files: any[],
): { count: number; locations: { file: string; line: number }[] } {
  let count = 0;
  const locations: { file: string; line: number }[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Mutex: .Lock() without defer .Unlock() within next 3 lines
      if (/\.Lock\(\)/.test(trimmed)) {
        const nextLines = lines.slice(i + 1, i + 4).join(" ");
        if (!/defer\s+.*\.Unlock\(\)/.test(nextLines) && !/\.Unlock\(\)/.test(trimmed)) {
          count++;
          locations.push({ file: file.relativePath, line: i + 1 });
        }
      }
    }
  }

  return { count, locations };
}

function analyzeGo(files: any[]): Finding[] {
  const findings: Finding[] = [];

  const uncheckedErrors = detectGoUncheckedErrors(files);
  const nakedGoroutines = detectGoNakedGoroutines(files);
  const unsafeMutex = detectGoUnsafeMutex(files);

  if (uncheckedErrors.count > 0) {
    findings.push({
      analyzerId: "language-specific",
      severity: uncheckedErrors.count > 10 ? "error" : "warning",
      confidence: 0.7,
      message: `${uncheckedErrors.count} potentially unchecked errors in Go code`,
      locations: uncheckedErrors.locations.slice(0, 10),
      tags: ["go", "error-handling", "unchecked-error"],
    });
  }

  if (nakedGoroutines.count > 0) {
    findings.push({
      analyzerId: "language-specific",
      severity: "warning",
      confidence: 0.6,
      message: `${nakedGoroutines.count} goroutines launched without context — potential leak risk`,
      locations: nakedGoroutines.locations.slice(0, 10),
      tags: ["go", "goroutine", "leak"],
    });
  }

  if (unsafeMutex.count > 0) {
    findings.push({
      analyzerId: "language-specific",
      severity: "warning",
      confidence: 0.75,
      message: `${unsafeMutex.count} mutex locks without defer Unlock — risk of deadlock`,
      locations: unsafeMutex.locations.slice(0, 10),
      tags: ["go", "mutex", "concurrency"],
    });
  }

  return findings;
}

// ===== Python Analysis =====

function analyzePython(files: any[]): Finding[] {
  const findings: Finding[] = [];

  let bareExcepts = 0;
  const bareExceptLocations: { file: string; line: number }[] = [];

  let mutableDefaults = 0;
  const mutableDefaultLocations: { file: string; line: number; snippet: string }[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Bare except (catches everything including SystemExit, KeyboardInterrupt)
      if (/^except\s*:/.test(trimmed)) {
        bareExcepts++;
        bareExceptLocations.push({ file: file.relativePath, line: i + 1 });
      }

      // Mutable default arguments
      if (/^def\s+\w+\s*\(/.test(trimmed)) {
        // Check for mutable defaults: list=[], dict={}, set()
        if (/=\s*\[\s*\]|=\s*\{\s*\}|=\s*set\s*\(\s*\)/.test(trimmed)) {
          mutableDefaults++;
          mutableDefaultLocations.push({
            file: file.relativePath,
            line: i + 1,
            snippet: trimmed.slice(0, 80),
          });
        }
      }
    }
  }

  if (bareExcepts > 0) {
    findings.push({
      analyzerId: "language-specific",
      severity: "error",
      confidence: 0.95,
      message: `${bareExcepts} bare except clauses — catches SystemExit and KeyboardInterrupt`,
      locations: bareExceptLocations.slice(0, 10),
      tags: ["python", "error-handling", "bare-except"],
    });
  }

  if (mutableDefaults > 0) {
    findings.push({
      analyzerId: "language-specific",
      severity: "warning",
      confidence: 0.9,
      message: `${mutableDefaults} functions with mutable default arguments`,
      locations: mutableDefaultLocations.slice(0, 10),
      tags: ["python", "mutable-default"],
    });
  }

  return findings;
}

// ===== Rust Analysis =====

function analyzeRust(files: any[]): Finding[] {
  const findings: Finding[] = [];

  let unwrapCount = 0;
  const unwrapLocations: { file: string; line: number; snippet: string }[] = [];

  let unsafeCount = 0;
  const unsafeLocations: { file: string; line: number }[] = [];

  for (const file of files) {
    // Count .unwrap() calls
    const unwrapPattern = /\.unwrap\(\)/g;
    let match;
    while ((match = unwrapPattern.exec(file.content)) !== null) {
      unwrapCount++;
      const line = getLineNumber(file.content, match.index);
      const lineStart = file.content.lastIndexOf("\n", match.index) + 1;
      const lineEnd = file.content.indexOf("\n", match.index);
      const snippet = file.content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
      unwrapLocations.push({
        file: file.relativePath,
        line,
        snippet: snippet.slice(0, 80),
      });
    }

    // Count unsafe blocks
    const unsafePattern = /\bunsafe\s*\{/g;
    while ((match = unsafePattern.exec(file.content)) !== null) {
      unsafeCount++;
      unsafeLocations.push({
        file: file.relativePath,
        line: getLineNumber(file.content, match.index),
      });
    }
  }

  if (unwrapCount > 2) {
    findings.push({
      analyzerId: "language-specific",
      severity: unwrapCount > 20 ? "error" : "warning",
      confidence: 0.8,
      message: `${unwrapCount} .unwrap() calls — consider using ? operator or expect() with context`,
      locations: unwrapLocations.slice(0, 10),
      tags: ["rust", "unwrap", "error-handling"],
    });
  }

  if (unsafeCount > 0) {
    findings.push({
      analyzerId: "language-specific",
      severity: unsafeCount > 5 ? "error" : "warning",
      confidence: 0.85,
      message: `${unsafeCount} unsafe blocks in Rust code`,
      locations: unsafeLocations.slice(0, 10),
      tags: ["rust", "unsafe"],
    });
  }

  return findings;
}
