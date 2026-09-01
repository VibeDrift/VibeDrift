import type { Finding } from "../core/types.js";

// Analyzer IDs that detect duplicates, in priority order (highest first)
const DUPLICATE_ANALYZER_IDS = ["ml-duplicate", "codedna-fingerprint", "codedna-opseq", "duplicates"];
const DUPLICATE_IDS_SET = new Set(DUPLICATE_ANALYZER_IDS);

/**
 * Deduplicate findings across the three duplicate detection layers.
 *
 * The same function pair can be reported by static analysis, Code DNA, and ML embeddings.
 * We keep only the highest-priority detection per file pair:
 *   ML-confirmed > Code DNA fingerprint > Code DNA opseq > Static
 *
 * Non-duplicate findings pass through unchanged.
 */
export function deduplicateFindingsAcrossLayers(findings: Finding[]): Finding[] {
  const nonDuplicate: Finding[] = [];
  const duplicateFindings: Finding[] = [];

  for (const f of findings) {
    if (DUPLICATE_IDS_SET.has(f.analyzerId)) {
      duplicateFindings.push(f);
    } else {
      nonDuplicate.push(f);
    }
  }

  // Return a COPY, never the input array itself: callers replace their list in
  // place via `allFindings.length = 0; allFindings.push(...deduped)`, and if we
  // returned the same reference that clear would empty the array before the
  // re-push — silently dropping every finding (composite then floats to ~100).
  if (duplicateFindings.length === 0) return [...findings];

  const byFilePair = groupDuplicateFindings(duplicateFindings);

  // For each file pair group, keep only the highest-priority finding
  const dedupedDuplicates: Finding[] = [];

  for (const [, group] of byFilePair) {
    if (group.length === 1) {
      dedupedDuplicates.push(group[0]);
      continue;
    }

    // Sort by priority (ML > Code DNA fingerprint > Code DNA opseq > Static)
    group.sort((a, b) => {
      const pa = DUPLICATE_ANALYZER_IDS.indexOf(a.analyzerId);
      const pb = DUPLICATE_ANALYZER_IDS.indexOf(b.analyzerId);
      return pa - pb; // lower index = higher priority
    });

    const best = group[0];
    const sources = [...new Set(group.map((f) => f.analyzerId))];

    // Annotate the winning finding with detection source info. On a COPY: the
    // caller still holds the original finding objects (and re-reads them for the
    // findings library, the session ledger and the diff), so appending to
    // `best.message` in place rewrote a finding this function was only supposed
    // to select — and appended again on every re-run over the same array.
    if (sources.length > 1) {
      const sourceLabels = sources.map((s) =>
        s === "ml-duplicate" ? "ML embeddings"
        : s === "codedna-fingerprint" ? "Code DNA fingerprint"
        : s === "codedna-opseq" ? "Code DNA sequence"
        : "static analysis"
      );
      dedupedDuplicates.push({
        ...best,
        message: `${best.message} [confirmed by ${sourceLabels.join(", ")}]`,
      });
      continue;
    }

    dedupedDuplicates.push(best);
  }

  return [...nonDuplicate, ...dedupedDuplicates];
}

/**
 * Group duplicate findings by the FUNCTIONS they involve, not the file pair.
 *
 * Keying on the file set alone collapsed every distinct duplicate group spanning
 * the same two files into a single survivor: a pair of large modules sharing
 * five unrelated clones reported one finding, and the four dropped ones took
 * their `dupGroupSize` mass with them, so the duplicated-function fraction the
 * scoring engine divides by function count silently lost most of its numerator.
 *
 * So a finding whose locations all carry a line is keyed on its sorted set of
 * `file#line` sites: identical for the same functions reported by different
 * layers, distinct for different clones over the same files.
 *
 * But not every layer reports lines. ML duplicate findings are built from
 * `function_a`/`function_b` ids and carry FILES ONLY (see
 * `src/ml-client/confidence.ts`), so a site key would never match the Code DNA
 * copy of the same clone: deep scans would show it twice, lose the
 * "[confirmed by ...]" annotation, and count its damage double. A line-less
 * finding therefore merges by FILE SET into an existing lined group over the
 * same files — the first such group in sorted key order, so the choice is
 * deterministic — and only forms its own file-set group when no lined group
 * over those files exists.
 *
 * Files are sorted and deduped throughout so a 3+-file cluster merges the same
 * way regardless of the order a layer listed it in.
 */
function groupDuplicateFindings(duplicateFindings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  const push = (key: string, f: Finding) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  };

  // Pass 1: everything with a full site identity (plus single-file findings,
  // which never merge across layers).
  const lineless: Array<{ finding: Finding; fileSet: string }> = [];
  for (const f of duplicateFindings) {
    const files = sortedFiles(f);
    if (files.length < 2) {
      // Single-file duplicate findings (e.g., static "X pairs of duplicates in this file")
      push(`dup::${files[0] ?? "unknown"}::${f.analyzerId}`, f);
      continue;
    }
    const locs = f.locations.filter((l) => l.file);
    if (locs.every((l) => typeof l.line === "number")) {
      const sites = [...new Set(locs.map((l) => `${l.file}#${l.line}`))].sort();
      push(`dup::sites::${sites.join("::")}`, f);
    } else {
      lineless.push({ finding: f, fileSet: files.join("::") });
    }
  }

  // Pass 2: line-less findings attach to the first lined group over the same
  // file set, or form a file-set group of their own.
  const firstLinedGroupByFileSet = new Map<string, string>();
  for (const key of [...groups.keys()].sort()) {
    if (!key.startsWith("dup::sites::")) continue;
    const fileSet = sortedFiles(groups.get(key)![0]).join("::");
    if (!firstLinedGroupByFileSet.has(fileSet)) firstLinedGroupByFileSet.set(fileSet, key);
  }
  for (const { finding, fileSet } of lineless) {
    push(firstLinedGroupByFileSet.get(fileSet) ?? `dup::files::${fileSet}`, finding);
  }

  return groups;
}

function sortedFiles(f: Finding): string[] {
  return [...new Set(f.locations.map((l) => l.file).filter(Boolean))].sort();
}
