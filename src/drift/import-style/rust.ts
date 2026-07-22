/**
 * Rust import-style classifier — axes `rust_glob` and `rust_use_path`.
 *
 * `rust_glob`: glob (`use foo::bar::*;`) vs explicit paths. Decidable with a
 * glob present or ≥2 `use` declarations.
 *
 * `rust_use_path`: intra-crate refs written absolute (`use crate::…`) vs
 * relative (`use super::…` / `use self::…`). External-crate uses (`std`,
 * `serde`, …) are neutral and ignored; ≥2 intra-crate uses to decide.
 *
 * AST on a clean parse (`use_declaration` / `use_wildcard`), regex fallback otherwise.
 */

import type { Tree } from "../../core/types.js";
import type { DriftFile, Evidence } from "../types.js";
import type { AxisClassification, ImportStyleClassifier } from "./types.js";
import { isAnalyzableSource } from "../utils.js";
import { RUST_USE, RUST_USE_GLOB, RUST_USE_HEAD } from "./patterns.js";

interface UseRow { line: number; text: string; }

/** Collect one row per `use` declaration (line number + single-line text). */
function collectUses(file: DriftFile): UseRow[] {
  const rows: UseRow[] = [];
  if (file.tree && !file.tree.rootNode.hasError) {
    for (const u of file.tree.rootNode.descendantsOfType("use_declaration")) {
      if (!u) continue;
      rows.push({ line: u.startPosition.row + 1, text: u.text.split("\n")[0].trim() });
    }
  } else {
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (RUST_USE.test(lines[i])) rows.push({ line: i + 1, text: lines[i].trim() });
    }
  }
  return rows;
}

function glob(rows: UseRow[]): AxisClassification | null {
  const globRows = rows.filter((r) => RUST_USE_GLOB.test(r.text));
  if (globRows.length === 0 && rows.length < 2) return null;
  const evidence: Evidence[] = (globRows.length > 0 ? globRows : rows).slice(0, 3).map((r) => ({ line: r.line, code: r.text }));
  return { axis: "rust_glob", pattern: globRows.length > 0 ? "glob" : "explicit", evidence };
}

function usePath(rows: UseRow[]): AxisClassification | null {
  let crate = 0;
  let relative = 0;
  const evidence: Evidence[] = [];
  for (const r of rows) {
    const head = r.text.match(RUST_USE_HEAD)?.[1];
    const kind = head === "crate" ? "crate" : (head === "super" || head === "self") ? "relative" : null;
    if (!kind) continue; // external crate — neutral
    if (kind === "crate") crate++; else relative++;
    if (evidence.length < 3) evidence.push({ line: r.line, code: r.text });
  }
  if (crate + relative < 2) return null;
  const pattern = relative === 0 ? "crate" : crate === 0 ? "relative" : crate >= relative ? "crate" : "relative";
  return { axis: "rust_use_path", pattern, evidence };
}

export const rustImportClassifier: ImportStyleClassifier = {
  classify(file: DriftFile): AxisClassification[] {
    if (!isAnalyzableSource(file.relativePath)) return [];
    const rows = collectUses(file);
    const out: AxisClassification[] = [];
    const g = glob(rows);
    if (g) out.push(g);
    const u = usePath(rows);
    if (u) out.push(u);
    return out;
  },
};
