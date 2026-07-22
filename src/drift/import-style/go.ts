/**
 * Go import-style classifier — axis `go_grouping`.
 *
 * Shallow first pass: within a block `import ( … )`, is the file's stdlib vs
 * external imports separated by a blank line (`grouped`) or run together in one
 * flat block (`flat`)? Only classifies files that import from **≥2 origin
 * categories** (stdlib vs dotted-external), so a pure-stdlib file is never a
 * false deviator. Category is inferred without go.mod ("dot in first path
 * segment" ⇒ external); local-module paths look like stdlib, which only causes
 * safe under-detection. A go.mod-aware, boundary-precise pass is a later layer.
 *
 * AST on a clean parse (tree-sitter `import_spec_list`), regex fallback otherwise.
 */

import type { Tree, SyntaxNode } from "../../core/types.js";
import type { DriftFile } from "../types.js";
import type { AxisClassification, ImportStyleClassifier } from "./types.js";
import { isAnalyzableSource } from "../utils.js";
import { GO_IMPORT_BLOCK_START, GO_IMPORT_BLOCK_END, GO_IMPORT_PATH } from "./patterns.js";

interface Spec { row: number; category: "stdlib" | "external"; code: string; }

/** stdlib import paths have no `.` in their first segment (`fmt`, `net/http`);
 *  a dotted first segment (`github.com/...`) is external. Local-module paths
 *  (no dot) read as stdlib here — deliberate: it only drops a category, never
 *  invents one. */
function goCategory(path: string): "stdlib" | "external" {
  return path.split("/")[0].includes(".") ? "external" : "stdlib";
}

function stripGoQuotes(text: string): string {
  const t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("`") && t.endsWith("`"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Decide grouped/flat from the specs of one block. Requires ≥2 specs across
 *  ≥2 categories; a blank line (row gap > 1) anywhere in the block ⇒ grouped. */
function classifyBlock(specs: Spec[]): AxisClassification | null {
  if (specs.length < 2) return null;
  const categories = new Set(specs.map((s) => s.category));
  if (categories.size < 2) return null; // single origin — grouping isn't meaningful

  const sorted = [...specs].sort((a, b) => a.row - b.row);
  let grouped = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].row - sorted[i - 1].row > 1) { grouped = true; break; }
  }
  const evidence = sorted.slice(0, 3).map((s) => ({ line: s.row + 1, code: s.code }));
  return { axis: "go_grouping", pattern: grouped ? "grouped" : "flat", evidence };
}

function fromAst(tree: Tree): AxisClassification | null {
  for (const list of tree.rootNode.descendantsOfType("import_spec_list")) {
    if (!list) continue;
    const specs: Spec[] = [];
    for (const spec of list.namedChildren) {
      if (!spec || spec.type !== "import_spec") continue;
      const pathNode = spec.childForFieldName("path");
      if (!pathNode) continue;
      const path = stripGoQuotes(pathNode.text);
      specs.push({ row: spec.startPosition.row, category: goCategory(path), code: spec.text.trim() });
    }
    const res = classifyBlock(specs);
    if (res) return res;
  }
  return null;
}

function fromRegex(content: string): AxisClassification | null {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (GO_IMPORT_BLOCK_START.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return null;

  const specs: Spec[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (GO_IMPORT_BLOCK_END.test(lines[i])) break;
    const m = lines[i].match(GO_IMPORT_PATH);
    if (!m) continue; // blank line or comment — not a spec (its absence leaves a row gap)
    const path = m[1] ?? m[2];
    specs.push({ row: i, category: goCategory(path), code: lines[i].trim() });
  }
  return classifyBlock(specs);
}

export const goImportClassifier: ImportStyleClassifier = {
  classify(file: DriftFile): AxisClassification[] {
    if (!isAnalyzableSource(file.relativePath)) return [];
    if (file.tree && !file.tree.rootNode.hasError) {
      const r = fromAst(file.tree);
      return r ? [r] : [];
    }
    const r = fromRegex(file.content);
    return r ? [r] : [];
  },
};
