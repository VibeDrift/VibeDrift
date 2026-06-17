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
const TRY_CATCH_PATTERN = /\btry\s*\{/g;
const ASYNC_PATTERN = /\basync\s+(?:function|\(|[a-zA-Z])/g;

export const errorHandlingAnalyzer: Analyzer = {
  id: "error-handling",
  name: "Error Handling",
  category: "architecturalConsistency",
  requiresAST: false,
  applicableLanguages: ["javascript", "typescript"],

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

    const ASYNC_FN_PATTERN =
      /async\s+(?:function\s+\w+|\(\w*\)|\w+)\s*\([^)]*\)\s*(?::\s*[^{]*)?\s*\{/g;
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
        const openBrace = file.content.indexOf("{", fnMatch.index + fnMatch[0].length - 1);
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
