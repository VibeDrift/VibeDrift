/**
 * Error handling consistency analyzer for JavaScript/TypeScript.
 *
 * Detects two anti-patterns: (1) empty catch blocks that silently swallow
 * errors, and (2) async functions using `await` without any try/catch or
 * .catch() — a common source of unhandled promise rejections.
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding } from "../core/types.js";
import { getLineNumber } from "../utils/text.js";

const EMPTY_CATCH_PATTERN = /catch\s*\([^)]*\)\s*\{\s*\}/g;

/**
 * Locate the function body's opening `{` by scanning forward from just
 * after the parameter list's closing `)`, tracking bracket depth across
 * `<>`, `()`, `[]`, and `{}`.
 *
 * The old approach folded the optional return-type annotation into the
 * same regex as the body brace (`(?::\s*[^{]*)?\s*\{`), which stops at the
 * FIRST `{` it sees — but an inline object return type like
 * `Promise<{ ok: boolean }>` has a `{` of its own, so the regex matched
 * that type's brace instead of the real body brace. The function's actual
 * body then got mislocated (or missed): brace-depth counting started from
 * the type literal, not the real body, and closed early at the type's `}`.
 *
 * Bracket-depth tracking sidesteps this: whatever nesting the return type
 * introduces (`<...>`, `(...)`, `[...]`, `{...}`) is balanced away, and the
 * first `{` seen at depth 0 is guaranteed to be the body.
 */
function findFunctionBodyBrace(content: string, fromIndex: number): number {
  let depth = 0;
  // Bound the scan — a real return-type annotation is short; if we haven't
  // found the body within a generous window, this isn't a function with a
  // body here (e.g. an ambient/overload declaration with no `{` at all).
  const limit = Math.min(content.length, fromIndex + 500);
  for (let i = fromIndex; i < limit; i++) {
    const c = content[i];
    if (c === "{" && depth === 0) return i;
    // A `;` at depth 0 ends a body-less declaration — a TS overload
    // signature (`async load(id: string): Promise<User>;`) or an abstract
    // method. Without this stop the scan would keep walking and return the
    // NEXT function's body brace, so that body was analyzed twice (once for
    // the overload, once for the real implementation) and its await counted
    // double. `;` inside `<...>`/`(...)`/`[...]` (e.g. an inline object type
    // `Promise<{ a: string; b: number }>`) is a separator, not a terminator,
    // and is skipped by the depth check.
    if (c === ";" && depth === 0) return -1;
    if (c === "<" || c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth = Math.max(0, depth - 1);
    } else if (c === ">" && content[i - 1] !== "=") {
      // Skip the `>` of an arrow (`=>`) inside a function-type return
      // annotation (e.g. `Promise<{ cb: () => void }>`) — it isn't a
      // generic close and decrementing on it would unbalance the real
      // `<...>` depth before its true closing `>`.
      depth = Math.max(0, depth - 1);
    }
  }
  return -1;
}

export const errorHandlingAnalyzer: Analyzer = {
  id: "error-handling",
  name: "Error Handling",
  category: "architecturalConsistency",
  requiresAST: false,
  applicableLanguages: ["javascript", "typescript"],
  // Bumped when detection logic changes — invalidates the S1 findings cache.
  version: 2,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const jsFiles = ctx.files.filter(
      (f) => f.language === "javascript" || f.language === "typescript",
    );

    let totalEmptyCatches = 0;
    const emptyCatchLocations: { file: string; line: number; snippet?: string }[] = [];

    for (const file of jsFiles) {
      const emptyRegex = new RegExp(EMPTY_CATCH_PATTERN.source, "g");
      let match;
      while ((match = emptyRegex.exec(file.content)) !== null) {
        totalEmptyCatches++;
        const line = getLineNumber(file.content, match.index);
        emptyCatchLocations.push({
          file: file.relativePath,
          line,
          snippet: match[0],
        });
      }
    }

    if (totalEmptyCatches > 0) {
      findings.push({
        analyzerId: "error-handling",
        severity: totalEmptyCatches > 5 ? "error" : "warning",
        confidence: 0.95,
        message: `${totalEmptyCatches} empty catch blocks found`,
        locations: emptyCatchLocations.slice(0, 10),
        tags: ["error-handling", "empty-catch"],
      });
    }

    // Matches only through the parameter list's closing `)` — the optional
    // return-type annotation and the body's opening `{` are then located by
    // findFunctionBodyBrace, which tracks bracket depth instead of stopping
    // at the first `{` (which may belong to an inline object return type).
    const ASYNC_FN_PATTERN =
      /async\s+(?:function\s+\w+|\(\w*\)|\w+)\s*\([^)]*\)/g;
    const ERROR_HANDLING_PATTERNS = [
      /\btry\s*\{/,
      /\.catch\s*\(/,
      /\bcatch\s*\(/,
      /\b(?:Result|Either)\s*[<(]/,
    ];

    // Aggregate unhandled async counts per directory to avoid flooding
    // the report with one finding per function
    const dirUnhandled = new Map<string, number>();

    for (const file of jsFiles) {
      const dir = file.relativePath.includes("/")
        ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/"))
        : ".";

      const asyncRegex = new RegExp(ASYNC_FN_PATTERN.source, "g");
      let fnMatch;
      while ((fnMatch = asyncRegex.exec(file.content)) !== null) {
        // Extract the function body via brace-depth counting so we can
        // check if error handling exists within this specific function scope
        const openBrace = findFunctionBodyBrace(file.content, fnMatch.index + fnMatch[0].length);
        if (openBrace === -1) continue;
        let depth = 1;
        let pos = openBrace + 1;
        while (pos < file.content.length && depth > 0) {
          if (file.content[pos] === "{") depth++;
          else if (file.content[pos] === "}") depth--;
          pos++;
        }
        const body = file.content.slice(openBrace + 1, pos - 1);

        // Only flag if the body uses await but has no error handling
        if (!/\bawait\b/.test(body)) continue;
        const hasHandling = ERROR_HANDLING_PATTERNS.some((p) => p.test(body));
        if (!hasHandling) {
          dirUnhandled.set(dir, (dirUnhandled.get(dir) ?? 0) + 1);
        }
      }
    }

    for (const [dir, count] of dirUnhandled) {
      if (count > 3) {
        findings.push({
          analyzerId: "error-handling",
          severity: "info",
          confidence: 0.6,
          message: `${count} async functions without error handling in ${dir}/`,
          locations: [{ file: dir }],
          tags: ["error-handling", "unhandled-async"],
        });
      }
    }

    return findings;
  },
};
