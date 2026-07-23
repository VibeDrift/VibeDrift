/**
 * JS/TS import-style classifier — axis `path_style` (relative `./` vs alias `@/`).
 *
 * Handles both ES modules (`import … from "spec"`) and CommonJS
 * (`require("spec")`). ES-module behavior matches the original `analyzeImports`
 * (existing findings unchanged); CommonJS specifiers are now counted too.
 * Line-based; comment lines are skipped. An AST rewrite is a later layer.
 */

import type { DriftFile, Evidence } from "../types.js";
import type { AxisClassification, ImportStyleClassifier } from "./types.js";
import { isAnalyzableSource } from "../utils.js";
import { JS_IMPORT_LINE, JS_FROM_SPECIFIER, JS_REQUIRE } from "./patterns.js";
import { EVIDENCE_LIMIT, binaryMajority } from "./shared.js";
import { isCommentLine, C_STYLE_COMMENT_MARKERS } from "../comment-markers.js";

export const jsImportClassifier: ImportStyleClassifier = {
  classify(file: DriftFile): AxisClassification[] {
    if (!isAnalyzableSource(file.relativePath)) return [];

    const lines = file.content.split("\n");
    let relativeCount = 0;
    let aliasCount = 0;
    const evidence: Evidence[] = [];

    // Count a single specifier: relative (./ ../) vs alias (@/ ~/); external /
    // bare packages have no local path-style choice and are skipped.
    const record = (spec: string, code: string, lineNo: number) => {
      if (spec.startsWith("./") || spec.startsWith("../")) relativeCount++;
      else if (spec.startsWith("@/") || spec.startsWith("~/")) aliasCount++;
      else return;
      if (evidence.length < EVIDENCE_LIMIT) evidence.push({ line: lineNo, code });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (isCommentLine(line, C_STYLE_COMMENT_MARKERS)) continue;
      if (JS_IMPORT_LINE.test(line)) {
        // ES module: import … from "spec"
        const fromMatch = line.match(JS_FROM_SPECIFIER);
        if (fromMatch) record(fromMatch[1], line, i + 1);
      } else {
        // CommonJS: any number of require("spec") on the line.
        for (const m of line.matchAll(JS_REQUIRE)) record(m[1], line, i + 1);
      }
    }

    const totalLocalImports = relativeCount + aliasCount;
    if (totalLocalImports < 3) return [];

    // Majority wins; a pure-alias file classifies as alias even with 0 relative.
    const pattern = binaryMajority(relativeCount, "relative", aliasCount, "alias");

    return [{ axis: "path_style", pattern, evidence }];
  },
};
