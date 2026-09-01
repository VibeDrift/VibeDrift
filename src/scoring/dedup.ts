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

  // Group duplicate findings by the set of files they involve
  const byFilePair = new Map<string, Finding[]>();

  for (const f of duplicateFindings) {
    const key = makeFilePairKey(f);
    if (!byFilePair.has(key)) byFilePair.set(key, []);
    byFilePair.get(key)!.push(f);
  }

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
 * Create a normalized key for a finding based on the FUNCTIONS it involves.
 *
 * The key must identify one duplicate group, not one file pair. Keying on the
 * file set alone collapsed every distinct duplicate group spanning the same two
 * files into a single survivor: a pair of large modules sharing five unrelated
 * clones reported one finding, and the four dropped ones took their
 * `dupGroupSize` mass with them, so the duplicated-function fraction the scoring
 * engine divides by function count silently lost most of its numerator.
 *
 * The identity is the sorted set of `file:line` locations, which is the same for
 * the same functions reported by different LAYERS (that cross-layer merge is the
 * whole point of this module) and different for different groups over the same
 * files. Files are still sorted and deduped so a 3+-file cluster merges the same
 * way regardless of the order a layer listed it in.
 */
function makeFilePairKey(f: Finding): string {
  const files = [...new Set(
    f.locations.map((l) => l.file).filter(Boolean),
  )].sort();

  if (files.length >= 2) {
    const sites = [...new Set(
      f.locations
        .filter((l) => l.file)
        .map((l) => `${l.file}#${l.line ?? ""}`),
    )].sort();
    return `dup::${sites.join("::")}`;
  }

  // Single-file duplicate findings (e.g., static "X pairs of duplicates in this file")
  return `dup::${files[0] ?? "unknown"}::${f.analyzerId}`;
}
