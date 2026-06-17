/**
 * Precision/recall/F1 over a SYNTHETIC labeled corpus.
 *
 * Because drift is injected programmatically (see labeled-injectors.ts), the
 * ground truth is exact: we know which files were mutated into which drift
 * category. This module classifies a scan's findings against that ground
 * truth — no human labeling, no subjectivity.
 *
 * File-level, per-category:
 *   TP = injected files in category C that a C-finding points at
 *   FN = injected files in C that NO C-finding caught
 *   FP = files a C-finding points at that were NOT injected (spurious fires,
 *        incl. everything on the clean baseline)
 */

export interface DriftLabel {
  category: string;
  file: string;
}

export interface ScoredFinding {
  category: string | null;
  files: string[];
}

export interface CategoryMetrics {
  category: string;
  tp: number;
  fp: number;
  fn: number;
  /** TP/(TP+FP); null when the detector emitted nothing for this category. */
  precision: number | null;
  /** TP/(TP+FN); null when nothing was injected in this category. */
  recall: number | null;
  /** harmonic mean of precision & recall; null when either is null. */
  f1: number | null;
}

/**
 * Canonical category for a finding. Drift detectors tag findings
 * ["drift", <driftCategory>, ...]; the static `naming` analyzer is the same
 * concept as naming_conventions. Everything else keys off analyzerId.
 */
export function findingCategory(f: { analyzerId?: string; tags?: string[] }): string | null {
  const tags = Array.isArray(f.tags) ? f.tags : [];
  if (tags[0] === "drift" && tags[1]) return tags[1];
  if (f.analyzerId === "naming") return "naming_conventions";
  return f.analyzerId ?? null;
}

function f1(p: number | null, r: number | null): number | null {
  if (p == null || r == null) return null;
  if (p + r === 0) return 0;
  return Math.round((2 * p * r) / (p + r) * 1000) / 1000;
}

export function classify(findings: ScoredFinding[], labels: DriftLabel[]): CategoryMetrics[] {
  const categories = new Set<string>();
  for (const l of labels) categories.add(l.category);
  for (const f of findings) if (f.category) categories.add(f.category);

  const out: CategoryMetrics[] = [];
  for (const category of [...categories].sort()) {
    const injected = new Set(labels.filter((l) => l.category === category).map((l) => l.file));
    const flagged = new Set<string>();
    for (const f of findings) {
      if (f.category !== category) continue;
      for (const file of f.files) flagged.add(file);
    }
    let tp = 0;
    let fn = 0;
    for (const file of injected) {
      if (flagged.has(file)) tp += 1;
      else fn += 1;
    }
    let fp = 0;
    for (const file of flagged) if (!injected.has(file)) fp += 1;

    const precision = tp + fp === 0 ? null : Math.round((tp / (tp + fp)) * 1000) / 1000;
    const recall = injected.size === 0 ? null : Math.round((tp / (tp + fn)) * 1000) / 1000;
    out.push({ category, tp, fp, fn, precision, recall, f1: f1(precision, recall) });
  }
  return out;
}
