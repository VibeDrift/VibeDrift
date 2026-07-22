/**
 * Python import-style classifier — axes `py_path_style` and `py_wildcard`.
 *
 * `py_path_style`: intra-package imports written absolute (`from pkg.mod import
 * x`) vs relative (`from .mod import x`). Only intra-package imports count —
 * relative imports (leading dot) are always local, and an absolute from-import
 * counts only when its first segment matches a directory in the file's own path
 * (so third-party / stdlib imports never sway the vote). ≥2 local imports to decide.
 *
 * `py_wildcard`: `from x import *` vs explicit names — a universal style, so all
 * from-imports count. Decidable with a wildcard present or ≥2 from-imports.
 *
 * AST on a clean parse (`import_from_statement`), regex fallback otherwise. A
 * package-root-aware path-style pass (src-layout) is a later layer.
 */

import type { Tree } from "../../core/types.js";
import type { DriftFile, Evidence } from "../types.js";
import type { AxisClassification, ImportStyleClassifier } from "./types.js";
import { isAnalyzableSource } from "../utils.js";
import { PY_FROM_RELATIVE, PY_FROM_ABSOLUTE, PY_FROM_ANY, PY_WILDCARD } from "./patterns.js";

function pkgSegmentsOf(relativePath: string): Set<string> {
  return new Set(relativePath.split("/").slice(0, -1));
}

// ─── py_path_style ───

interface PathCounts { relative: number; absoluteLocal: number; evidence: Evidence[]; }

function decidePathStyle(c: PathCounts): AxisClassification | null {
  if (c.relative + c.absoluteLocal < 2) return null;
  const pattern =
    c.absoluteLocal === 0 ? "relative" :
    c.relative === 0 ? "absolute" :
    c.relative >= c.absoluteLocal ? "relative" : "absolute";
  return { axis: "py_path_style", pattern, evidence: c.evidence.slice(0, 3) };
}

function pathStyleFromAst(tree: Tree, pkg: Set<string>): AxisClassification | null {
  const c: PathCounts = { relative: 0, absoluteLocal: 0, evidence: [] };
  for (const node of tree.rootNode.descendantsOfType("import_from_statement")) {
    if (!node) continue;
    const mod = node.childForFieldName("module_name");
    if (!mod) continue;
    let kind: "relative" | "absoluteLocal" | null = null;
    if (mod.type === "relative_import") kind = "relative";
    else if (mod.type === "dotted_name" && pkg.has(mod.text.split(".")[0])) kind = "absoluteLocal";
    if (!kind) continue;
    if (kind === "relative") c.relative++; else c.absoluteLocal++;
    if (c.evidence.length < 3) c.evidence.push({ line: node.startPosition.row + 1, code: node.text.split("\n")[0].trim() });
  }
  return decidePathStyle(c);
}

function pathStyleFromRegex(lines: string[], pkg: Set<string>): AxisClassification | null {
  const c: PathCounts = { relative: 0, absoluteLocal: 0, evidence: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let kind: "relative" | "absoluteLocal" | null = null;
    if (PY_FROM_RELATIVE.test(line)) kind = "relative";
    else {
      const m = line.match(PY_FROM_ABSOLUTE);
      if (m && pkg.has(m[1].split(".")[0])) kind = "absoluteLocal";
    }
    if (!kind) continue;
    if (kind === "relative") c.relative++; else c.absoluteLocal++;
    if (c.evidence.length < 3) c.evidence.push({ line: i + 1, code: line.trim() });
  }
  return decidePathStyle(c);
}

// ─── py_wildcard ───

function decideWildcard(fromCount: number, wildcardCount: number, evidence: Evidence[]): AxisClassification | null {
  if (wildcardCount === 0 && fromCount < 2) return null;
  return { axis: "py_wildcard", pattern: wildcardCount > 0 ? "wildcard" : "explicit", evidence: evidence.slice(0, 3) };
}

function wildcardFromAst(tree: Tree): AxisClassification | null {
  let fromCount = 0;
  let wildcardCount = 0;
  const evidence: Evidence[] = [];
  for (const node of tree.rootNode.descendantsOfType("import_from_statement")) {
    if (!node) continue;
    fromCount++;
    if (node.descendantsOfType("wildcard_import").some((n) => n !== null)) wildcardCount++;
    if (evidence.length < 3) evidence.push({ line: node.startPosition.row + 1, code: node.text.split("\n")[0].trim() });
  }
  return decideWildcard(fromCount, wildcardCount, evidence);
}

function wildcardFromRegex(lines: string[]): AxisClassification | null {
  let fromCount = 0;
  let wildcardCount = 0;
  const evidence: Evidence[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!PY_FROM_ANY.test(lines[i])) continue;
    fromCount++;
    if (PY_WILDCARD.test(lines[i])) wildcardCount++;
    if (evidence.length < 3) evidence.push({ line: i + 1, code: lines[i].trim() });
  }
  return decideWildcard(fromCount, wildcardCount, evidence);
}

export const pythonImportClassifier: ImportStyleClassifier = {
  classify(file: DriftFile): AxisClassification[] {
    if (!isAnalyzableSource(file.relativePath)) return [];
    const pkg = pkgSegmentsOf(file.relativePath);
    const clean = !!file.tree && !file.tree.rootNode.hasError;
    const lines = clean ? [] : file.content.split("\n");

    const out: AxisClassification[] = [];
    const pathStyle = clean ? pathStyleFromAst(file.tree!, pkg) : pathStyleFromRegex(lines, pkg);
    if (pathStyle) out.push(pathStyle);
    const wildcard = clean ? wildcardFromAst(file.tree!) : wildcardFromRegex(lines);
    if (wildcard) out.push(wildcard);
    return out;
  },
};
