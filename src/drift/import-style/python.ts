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
 * AST on a clean parse (`import_from_statement`), regex fallback otherwise (the
 * fallback skips `#` comments and triple-quoted docstring bodies). A
 * package-root-aware path-style pass (src-layout) is a later layer.
 */

import type { Tree } from "../../core/types.js";
import type { DriftFile, Evidence } from "../types.js";
import type { AxisClassification, ImportStyleClassifier } from "./types.js";
import { isAnalyzableSource } from "../utils.js";
import { PY_FROM_RELATIVE, PY_FROM_ABSOLUTE, PY_FROM_ANY, PY_WILDCARD } from "./patterns.js";
import { EVIDENCE_LIMIT, capEvidence, cleanTree, binaryMajority } from "./shared.js";
import { isCommentLine, PYTHON_COMMENT_MARKERS } from "../comment-markers.js";

/**
 * Blank out `#` comment lines and triple-quoted docstring bodies so the
 * from-import regexes never match an import that only appears inside a comment
 * or a docstring. Regex-fallback only — the AST path is already immune
 * (a docstring is a string literal, not an `import_from_statement`).
 */
function stripPyNonCode(lines: string[]): string[] {
  let inDoc = false;
  return lines.map((line) => {
    const triples = (line.match(/"""|'''/g) ?? []).length;
    if (inDoc) {
      if (triples % 2 === 1) inDoc = false; // an odd count closes the docstring
      return "";
    }
    if (triples % 2 === 1) { inDoc = true; return ""; } // opens a multi-line docstring
    if (triples >= 2) return ""; // a `"""one-line"""` docstring
    if (isCommentLine(line, PYTHON_COMMENT_MARKERS)) return "";
    return line;
  });
}

function pkgSegmentsOf(relativePath: string): Set<string> {
  return new Set(relativePath.split("/").slice(0, -1));
}

// ─── py_path_style ───

interface PathCounts { relative: number; absoluteLocal: number; evidence: Evidence[]; }

function decidePathStyle(c: PathCounts): AxisClassification | null {
  if (c.relative + c.absoluteLocal < 2) return null;
  const pattern = binaryMajority(c.relative, "relative", c.absoluteLocal, "absolute");
  return { axis: "py_path_style", pattern, evidence: capEvidence(c.evidence) };
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
    if (c.evidence.length < EVIDENCE_LIMIT) c.evidence.push({ line: node.startPosition.row + 1, code: node.text.split("\n")[0].trim() });
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
    if (c.evidence.length < EVIDENCE_LIMIT) c.evidence.push({ line: i + 1, code: line.trim() });
  }
  return decidePathStyle(c);
}

// ─── py_wildcard ───

function decideWildcard(fromCount: number, wildcardCount: number, evidence: Evidence[]): AxisClassification | null {
  if (wildcardCount === 0 && fromCount < 2) return null;
  return { axis: "py_wildcard", pattern: wildcardCount > 0 ? "wildcard" : "explicit", evidence: capEvidence(evidence) };
}

function wildcardFromAst(tree: Tree): AxisClassification | null {
  let fromCount = 0;
  let wildcardCount = 0;
  const evidence: Evidence[] = [];
  for (const node of tree.rootNode.descendantsOfType("import_from_statement")) {
    if (!node) continue;
    fromCount++;
    if (node.descendantsOfType("wildcard_import").some((n) => n !== null)) wildcardCount++;
    if (evidence.length < EVIDENCE_LIMIT) evidence.push({ line: node.startPosition.row + 1, code: node.text.split("\n")[0].trim() });
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
    if (evidence.length < EVIDENCE_LIMIT) evidence.push({ line: i + 1, code: lines[i].trim() });
  }
  return decideWildcard(fromCount, wildcardCount, evidence);
}

export const pythonImportClassifier: ImportStyleClassifier = {
  classify(file: DriftFile): AxisClassification[] {
    if (!isAnalyzableSource(file.relativePath)) return [];
    const pkg = pkgSegmentsOf(file.relativePath);
    const tree = cleanTree(file);
    const lines = tree ? [] : stripPyNonCode(file.content.split("\n"));

    const out: AxisClassification[] = [];
    const pathStyle = tree ? pathStyleFromAst(tree, pkg) : pathStyleFromRegex(lines, pkg);
    if (pathStyle) out.push(pathStyle);
    const wildcard = tree ? wildcardFromAst(tree) : wildcardFromRegex(lines);
    if (wildcard) out.push(wildcard);
    return out;
  },
};
