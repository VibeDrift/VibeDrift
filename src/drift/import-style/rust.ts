/**
 * Rust import-style classifier — axes `rust_glob`, `rust_use_path`, `rust_grouping`.
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

import type { DriftFile, Evidence } from "../types.js";
import type { AxisClassification, ImportStyleClassifier } from "./types.js";
import { isAnalyzableSource } from "../utils.js";
import { RUST_USE, RUST_USE_GLOB, RUST_USE_HEAD } from "./patterns.js";
import { EVIDENCE_LIMIT, capEvidence, cleanTree, binaryMajority } from "./shared.js";

interface UseRow { line: number; text: string; }

/** Collect one row per `use` declaration (line number + single-line text). */
function collectUses(file: DriftFile): UseRow[] {
  const rows: UseRow[] = [];
  const tree = cleanTree(file);
  if (tree) {
    for (const u of tree.rootNode.descendantsOfType("use_declaration")) {
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
  const evidence = capEvidence((globRows.length > 0 ? globRows : rows).map((r) => ({ line: r.line, code: r.text })));
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
    if (evidence.length < EVIDENCE_LIMIT) evidence.push({ line: r.line, code: r.text });
  }
  if (crate + relative < 2) return null;
  const pattern = binaryMajority(crate, "crate", relative, "relative");
  return { axis: "rust_use_path", pattern, evidence };
}

type Origin = "std" | "external" | "internal";

/** Origin of a `use` from its head token — unambiguous in Rust (no local-vs-
 *  stdlib guessing needed): crate/super/self ⇒ internal, std/core/alloc ⇒ std,
 *  anything else ⇒ an external crate. */
function useOrigin(text: string): Origin | null {
  const head = text.match(RUST_USE_HEAD)?.[1];
  if (!head) return null;
  if (head === "crate" || head === "super" || head === "self") return "internal";
  if (head === "std" || head === "core" || head === "alloc") return "std";
  return "external";
}

/** Are uses from ≥2 origins separated by a blank line (`grouped`) or run
 *  together (`flat`)? Only files spanning ≥2 origins are judged, so a
 *  single-origin file is never a false deviator. Note: rustfmt does not enforce
 *  import grouping by default, so this is a softer convention than gofmt's. */
function grouping(rows: UseRow[]): AxisClassification | null {
  if (rows.length < 2) return null;
  const origins = new Set(rows.map((r) => useOrigin(r.text)).filter((o): o is Origin => o !== null));
  if (origins.size < 2) return null;
  const sorted = [...rows].sort((a, b) => a.line - b.line);
  let grouped = false;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].line - sorted[i - 1].line > 1) { grouped = true; break; }
  }
  const evidence = capEvidence(sorted.map((r) => ({ line: r.line, code: r.text })));
  return { axis: "rust_grouping", pattern: grouped ? "grouped" : "flat", evidence };
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
    const gr = grouping(rows);
    if (gr) out.push(gr);
    return out;
  },
};
