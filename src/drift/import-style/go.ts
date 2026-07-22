/**
 * Go import-style classifier — axes `go_grouping` and `go_ordering`.
 *
 * `go_grouping`: within a block `import ( … )`, are stdlib vs external imports
 * separated by a blank line (`grouped`) or run together (`flat`)? Only files
 * with ≥2 origin categories (stdlib vs dotted-external) are classified, so a
 * pure-stdlib file is never a false deviator. go.mod-aware grouping is a later layer.
 *
 * `go_ordering`: are imports sorted (`ordered`) within each blank-line group, the
 * way gofmt/goimports leaves them (byte-ascending), or not (`unordered`)? Checked
 * per group so a correctly-grouped file isn't judged across group boundaries.
 * ≥3 imports to decide.
 *
 * AST on a clean parse (`import_spec_list`), regex fallback otherwise.
 */

import type { Tree } from "../../core/types.js";
import type { DriftFile } from "../types.js";
import type { AxisClassification, ImportStyleClassifier } from "./types.js";
import { isAnalyzableSource } from "../utils.js";
import { GO_IMPORT_BLOCK_START, GO_IMPORT_BLOCK_END, GO_IMPORT_PATH } from "./patterns.js";
import { cleanTree, capEvidence } from "./shared.js";

interface Spec { row: number; path: string; category: "stdlib" | "external"; code: string; }

/** stdlib import paths have no `.` in their first segment (`fmt`, `net/http`);
 *  a dotted first segment (`github.com/...`) is external. Local-module paths
 *  read as stdlib here — deliberate: it drops a category, never invents one. */
function goCategory(path: string): "stdlib" | "external" {
  return path.split("/")[0].includes(".") ? "external" : "stdlib";
}

function stripGoQuotes(text: string): string {
  const t = text.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("`") && t.endsWith("`"))) return t.slice(1, -1);
  return t;
}

/** Specs of the first block import in the file, in source order. */
function collectAst(tree: Tree): Spec[] {
  for (const list of tree.rootNode.descendantsOfType("import_spec_list")) {
    if (!list) continue;
    const specs: Spec[] = [];
    for (const spec of list.namedChildren) {
      if (!spec || spec.type !== "import_spec") continue;
      const pathNode = spec.childForFieldName("path");
      if (!pathNode) continue;
      const path = stripGoQuotes(pathNode.text);
      specs.push({ row: spec.startPosition.row, path, category: goCategory(path), code: spec.text.trim() });
    }
    if (specs.length > 0) return specs.sort((a, b) => a.row - b.row);
  }
  return [];
}

function collectRegex(content: string): Spec[] {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (GO_IMPORT_BLOCK_START.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return [];
  const specs: Spec[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (GO_IMPORT_BLOCK_END.test(lines[i])) break;
    const m = lines[i].match(GO_IMPORT_PATH);
    if (!m) continue;
    const path = m[1] ?? m[2];
    specs.push({ row: i, path, category: goCategory(path), code: lines[i].trim() });
  }
  return specs;
}

function evidenceOf(specs: Spec[]): { line: number; code: string }[] {
  return capEvidence(specs.map((s) => ({ line: s.row + 1, code: s.code })));
}

function grouping(specs: Spec[]): AxisClassification | null {
  if (specs.length < 2) return null;
  if (new Set(specs.map((s) => s.category)).size < 2) return null;
  let grouped = false;
  for (let i = 1; i < specs.length; i++) {
    if (specs[i].row - specs[i - 1].row > 1) { grouped = true; break; }
  }
  return { axis: "go_grouping", pattern: grouped ? "grouped" : "flat", evidence: evidenceOf(specs) };
}

function ordering(specs: Spec[]): AxisClassification | null {
  if (specs.length < 3) return null;
  // Check each blank-line-delimited group is byte-ascending on its own.
  let ordered = true;
  let groupStart = 0;
  for (let i = 1; i <= specs.length && ordered; i++) {
    const boundary = i === specs.length || specs[i].row - specs[i - 1].row > 1;
    if (!boundary) continue;
    for (let j = groupStart + 1; j < i; j++) {
      if (specs[j].path < specs[j - 1].path) { ordered = false; break; }
    }
    groupStart = i;
  }
  return { axis: "go_ordering", pattern: ordered ? "ordered" : "unordered", evidence: evidenceOf(specs) };
}

export const goImportClassifier: ImportStyleClassifier = {
  classify(file: DriftFile): AxisClassification[] {
    if (!isAnalyzableSource(file.relativePath)) return [];
    const tree = cleanTree(file);
    const specs = tree ? collectAst(tree) : collectRegex(file.content);
    const out: AxisClassification[] = [];
    const g = grouping(specs);
    if (g) out.push(g);
    const o = ordering(specs);
    if (o) out.push(o);
    return out;
  },
};
