import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding, SourceFile } from "../core/types.js";
import { getLineNumber } from "../utils/text.js";

export const languageSpecificAnalyzer: Analyzer = {
  id: "language-specific",
  name: "Language-Specific Patterns",
  category: "architecturalConsistency",
  requiresAST: false,
  applicableLanguages: "all",
  // Bumped when detection logic changes — invalidates the S1 findings cache.
  version: 2,

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
  files: SourceFile[],
): { count: number; locations: { file: string; line: number; snippet: string }[] } {
  let count = 0;
  const locations: { file: string; line: number; snippet: string }[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // Unchecked error: line assigns to err but nothing in a bounded window
      // afterward references it. Two things keep this from over-flagging:
      //
      //   1. The same-line init form — `if err := f(); err != nil {` (and the
      //      `for`/`switch` equivalents) — IS the check; the assignment line
      //      itself contains the comparison, so it is never a candidate.
      //   2. ANY following non-comment line that mentions `err` counts as
      //      handling it. Idiomatic Go handles errors in many shapes beyond
      //      `if err != nil` — `log.Fatal(err)`, `t.Fatal(err)`, `panic(err)`,
      //      `errors.Is(err, ...)`, `return nil, err` inside a wrapped call —
      //      and requiring the handling line to START with if/switch/return
      //      false-flagged every one of them (measured +41% flags on real Go
      //      code, all false). This is the original "does a later line mention
      //      err, or is an immediately-following return" rule; we
      //      intentionally add no new flag conditions.
      //
      // The only change from the old single-line lookahead is the window:
      // scanning ~5 lines instead of 1 stops the common
      // `n, err := f(); _ = n; if err != nil { ... }` shape — an unrelated
      // statement between the assignment and the check — from being flagged.
      if (/\berr\s*[:=]/.test(trimmed) && !trimmed.startsWith("//")) {
        if (/\berr\s*[!=]=\s*nil\b/.test(trimmed)) continue;
        let checked = false;
        let hasFollowingContent = false;
        let isFirstFollowingLine = true;
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const next = lines[j].trim();
          if (!next || next.startsWith("//")) continue;
          hasFollowingContent = true;
          if (/\berr\b/.test(next)) {
            checked = true;
            break;
          }
          // An IMMEDIATELY following `return` counts as handling, which is
          // what the original heuristic's `!nextLine.startsWith("return")`
          // exclusion did. It covers Go's named-return idiom —
          // `func f() (err error) { _, err = w.Write(b); return }` — where
          // assigning the named result and returning IS how the error
          // propagates. Only the FIRST following line, deliberately: a
          // `return` further down the window is a different statement, and
          // treating it as handling would silence a genuinely dropped error
          // (`err := f(); fmt.Println("done"); return nil`).
          //
          // Measured on three real Go repos (gin, consul-template, and a gin
          // example app): this removes 12 flags, all of them the named-return
          // idiom, 9 of which were half of gin's entire flag set.
          if (isFirstFollowingLine && next.startsWith("return")) {
            checked = true;
            break;
          }
          isFirstFollowingLine = false;
        }
        if (hasFollowingContent && !checked) {
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

// Minimum sample size before we trust a project-wide context-threading
// convention exists at all (per AGENTS.md: drift needs a baseline — below
// this we have no norm to measure deviation from).
const NAKED_GOROUTINE_MIN_SAMPLE = 3;
// A convention only counts as "dominant" once a clear majority follows it.
const NAKED_GOROUTINE_DOMINANCE_THRESHOLD = 0.6;

/**
 * Naked goroutines — `go func()` / `go someFunc()` launched without a
 * context.Context threaded through nearby scope.
 *
 * This used to be a raw heuristic (flag every goroutine lacking `ctx`
 * nearby), which false-flagged idiomatic WaitGroup worker-pool code that
 * never threads context at all. Per AGENTS.md, a finding needs a baseline
 * it deviates from — so this now requires a dominance signal: only flag the
 * naked goroutines when a clear majority of OTHER goroutines in the project
 * DO thread context. If most goroutines in this codebase never use context,
 * that's this project's own convention, not drift.
 */
function detectGoNakedGoroutines(
  files: SourceFile[],
): { count: number; locations: { file: string; line: number }[] } {
  const goroutines: { file: string; line: number; hasContext: boolean }[] = [];

  for (const file of files) {
    const lines = file.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Goroutine: go func() or go someFunc(...)
      if (/^\s*go\s+func\s*\(/.test(line) || /^\s*go\s+\w+\s*\(/.test(line)) {
        // Heuristic: "ctx" in the go call or surrounding 3 lines
        const nearby = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
        const hasContext = /\bctx\b/.test(nearby) || /context\./.test(nearby);
        goroutines.push({ file: file.relativePath, line: i + 1, hasContext });
      }
    }
  }

  if (goroutines.length < NAKED_GOROUTINE_MIN_SAMPLE) {
    return { count: 0, locations: [] };
  }

  const withContext = goroutines.filter((g) => g.hasContext).length;
  const dominanceRatio = withContext / goroutines.length;
  if (dominanceRatio < NAKED_GOROUTINE_DOMINANCE_THRESHOLD) {
    // No established convention — most goroutines in this project don't
    // thread context, so the ones that don't aren't deviating from anything.
    return { count: 0, locations: [] };
  }

  const naked = goroutines.filter((g) => !g.hasContext);
  return {
    count: naked.length,
    locations: naked.map((g) => ({ file: g.file, line: g.line })),
  };
}

function detectGoUnsafeMutex(
  files: SourceFile[],
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

function analyzeGo(files: SourceFile[]): Finding[] {
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

function analyzePython(files: SourceFile[]): Finding[] {
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

function analyzeRust(files: SourceFile[]): Finding[] {
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
