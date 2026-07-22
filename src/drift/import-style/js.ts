/**
 * JS/TS import-style classifier — axis `path_style` (relative vs alias).
 *
 * Ported verbatim from the original `analyzeImports` in `import-consistency.ts`
 * (behavior-preserving). Line-based; the AST rewrite is a later layer.
 */

import type { DriftFile, Evidence } from "../types.js";
import type { AxisClassification, ImportStyleClassifier } from "./types.js";
import { isAnalyzableSource } from "../utils.js";
import { JS_IMPORT_LINE, JS_FROM_SPECIFIER } from "./patterns.js";

export const jsImportClassifier: ImportStyleClassifier = {
  classify(file: DriftFile): AxisClassification[] {
    if (!isAnalyzableSource(file.relativePath)) return [];

    const lines = file.content.split("\n");
    let relativeCount = 0;
    let aliasCount = 0;
    const evidence: Evidence[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!JS_IMPORT_LINE.test(line)) continue;

      const fromMatch = line.match(JS_FROM_SPECIFIER);
      if (!fromMatch) continue;
      const importPath = fromMatch[1];

      // Skip node_modules / external packages.
      if (!importPath.startsWith(".") && !importPath.startsWith("@/") && !importPath.startsWith("~/")) continue;

      if (importPath.startsWith("./") || importPath.startsWith("../")) {
        relativeCount++;
      } else if (importPath.startsWith("@/") || importPath.startsWith("~/")) {
        aliasCount++;
      }

      if (evidence.length < 3) {
        evidence.push({ line: i + 1, code: line });
      }
    }

    const totalLocalImports = relativeCount + aliasCount;
    if (totalLocalImports < 3) return [];

    // Majority wins; a pure-alias file classifies as alias even with 0 relative.
    const pattern =
      aliasCount === 0 ? "relative" :
      relativeCount === 0 ? "alias" :
      relativeCount >= aliasCount ? "relative" : "alias";

    return [{ axis: "path_style", pattern, evidence }];
  },
};
