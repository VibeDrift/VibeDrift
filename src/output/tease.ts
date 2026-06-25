/**
 * Deep-scan tease messages — what deep scan would surface that local
 * analysis only half-confirms.
 *
 * Local scan produces several signals that are suggestive but not
 * conclusive:
 *   - Code DNA finds near-duplicate function sequences (LCS 0.5–0.85)
 *     that are "maybe the same thing." Deep scan's UniXcoder
 *     embeddings can confirm or reject semantic equivalence.
 *   - Certain function names (`handle`, `process`, `run`, `doStuff`)
 *     are generic enough that their intent is opaque from the name
 *     alone. Deep scan's intent-mismatch detector embeds name and
 *     body separately and confirms whether they align.
 *   - Pattern-classified files with internally-mixed patterns
 *     (`isInternallyInconsistent`) suggest a file that's drifting
 *     within itself — deep scan can cluster functions in embedding
 *     space to quantify the split.
 *
 * This module turns those signals into tease messages that NAME
 * specific files deep scan would confirm. That's the upsell moment
 * VibeDrift needs: not "run deep for AI analysis," but "run deep to
 * confirm that getCart() and loadCart() are the same function."
 *
 * Skipped when `deepUsed` is true — deep already ran.
 */

import type { AnalysisContext, Finding } from "../core/types.js";
import type { CodeDnaResult, ExtractedFunction } from "../codedna/types.js";

// Non-shipped path regexes — mirror of src/scoring/engine.ts (kept local to
// avoid exporting engine internals; same set the API reimplementation detector
// uses). Test/example/generated dup pairs were 0% precision in the recall audit.
const REIMPL_NOT_SHIPPED_RES: RegExp[] = [
  /(^|\/)(generated|__generated__)\/|\.(generated|gen)\.[A-Za-z0-9]+$|\.pb\.go$|_pb2?\.py$|\.min\.[A-Za-z0-9]+$/,
  /(^|\/)(fixtures?|__fixtures__|__mocks__|mocks|snapshots|__snapshots__)\//,
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[A-Za-z0-9]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/,
  /(^|\/)(examples?|demos?|samples?)\//,
];
const REIMPL_MIN_BODY_TOKENS = 12;

// Names so generic that local classification can't tell what they do.
// Deep scan's intent-mismatch uses UniXcoder to align name and body in
// embedding space — a mismatch surfaces when the body looks like, say,
// data transformation but the name is just `handle`.
const GENERIC_NAMES = new Set([
  "handle",
  "process",
  "run",
  "execute",
  "doWork",
  "doStuff",
  "main",
  "perform",
  "apply",
  "go",
  "exec",
  "dispatch",
  "work",
  "action",
  "method",
  "fn",
  "func",
  "operation",
  "task",
]);

const NEAR_DUP_LOWER = 0.5;
const NEAR_DUP_UPPER = 0.85; // fingerprint layer catches >0.85 as exact-ish

export function generateTeaseMessages(
  ctx: AnalysisContext,
  findings: Finding[],
  deepUsed: boolean,
  codeDnaResult?: CodeDnaResult,
): string[] {
  if (deepUsed) return [];
  const messages: string[] = [];

  // ─── Signal 1: near-duplicate candidates from Code DNA ───
  // LCS-similarity pairs in the 0.5–0.85 range are "look similar but
  // we can't be sure." UniXcoder embeddings at deep-scan time
  // disambiguate (true semantic duplicate vs. superficially alike).
  if (codeDnaResult?.sequenceSimilarities) {
    const nearDups = codeDnaResult.sequenceSimilarities
      .filter((s) => s.similarity >= NEAR_DUP_LOWER && s.similarity < NEAR_DUP_UPPER)
      // Prefer cross-file matches — same-file near-dups are often intentional
      // local helpers.
      .filter((s) => s.functionA.file !== s.functionB.file)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3);

    if (nearDups.length > 0) {
      const count = codeDnaResult.sequenceSimilarities.filter(
        (s) => s.similarity >= NEAR_DUP_LOWER &&
          s.similarity < NEAR_DUP_UPPER &&
          s.functionA.file !== s.functionB.file,
      ).length;
      const examples = nearDups.map((s) =>
        `${s.functionA.name}() in ${shortPath(s.functionA.relativePath)} ↔ ${s.functionB.name}() in ${shortPath(s.functionB.relativePath)}`,
      );
      messages.push(
        `${count} near-duplicate function pair${count === 1 ? "" : "s"} (LCS similarity ${(nearDups[0].similarity * 100).toFixed(0)}%) — deep scan confirms semantic equivalence via UniXcoder embeddings:`,
      );
      for (const ex of examples) {
        messages.push(`  • ${ex}`);
      }
    }
  }

  // ─── Signal 2: generic function names (intent-mismatch candidates) ───
  if (codeDnaResult?.functions) {
    const genericFns = codeDnaResult.functions.filter((fn) => {
      if (fn.name.length < 3) return false;
      if (!GENERIC_NAMES.has(fn.name)) return false;
      // Body has enough content that its intent is actually opaque —
      // a 5-line handler's name might not matter.
      if (fn.bodyTokenCount < 20) return false;
      return true;
    });

    if (genericFns.length > 0) {
      const top = genericFns.slice(0, 3);
      const examples = top.map((fn) => `${fn.name}() in ${shortPath(fn.relativePath)}:${fn.line}`);
      messages.push(
        `${genericFns.length} function${genericFns.length === 1 ? "" : "s"} with opaque names (handle, process, run, …) — deep scan checks whether the name matches what the body actually does:`,
      );
      for (const ex of examples) {
        messages.push(`  • ${ex}`);
      }
    }
  }

  // ─── Signal 3: files with internally-inconsistent patterns ───
  if (codeDnaResult?.patternDistributions) {
    const mixed = codeDnaResult.patternDistributions.filter((p) => p.isInternallyInconsistent);
    if (mixed.length > 0) {
      const top = mixed.slice(0, 3);
      messages.push(
        `${mixed.length} file${mixed.length === 1 ? "" : "s"} use multiple architectural patterns internally — deep scan clusters functions in embedding space to quantify the split:`,
      );
      for (const p of top) {
        messages.push(`  • ${shortPath(p.relativePath)}`);
      }
    }
  }

  // ─── Fallback: nothing suggestive but still a sizable codebase ───
  // Only fires when none of the specific signals hit. Keeps the tease
  // from vanishing on a clean codebase where deep scan still has value
  // (anomaly detection can surface outliers even when local is green).
  if (messages.length === 0 && ctx.files.length > 10) {
    const funcCount = codeDnaResult?.functions.length ?? 0;
    if (funcCount >= 20) {
      messages.push(
        `Local analysis found no suggestive anomalies across ${funcCount} functions. Deep scan's UniXcoder anomaly detector can still surface outlier implementations that local heuristics miss.`,
      );
    }
  }

  if (messages.length > 0) {
    messages.push(`Sign in with \`vibedrift login\` (free, 10s) and run \`vibedrift --deep\`. 1 free deep scan/month.`);
  }

  return messages;
}

/**
 * Free Tier-1 reimplementation teaser (COUNT only, never findings).
 *
 * Counts distinct function NAMES that appear as shipped functions in 2+ different
 * files — a cheap proxy for "the same responsibility reimplemented per file"
 * (the dominant AI-drift shape from the recall audit: send_message x5, formatDate
 * x5, ...). Mirrors the API detector's Tier-1 rule (same-name, cross-file,
 * shipped, non-generic, non-trivial) but emits only an integer the CLI shows as
 * an upsell ("N possible ... run a deep scan to confirm"). The deep scan's panel
 * is what confirms which are real, so we never present these as findings.
 */
export function countReimplementationCandidates(functions: ExtractedFunction[]): number {
  const filesByName = new Map<string, Set<string>>();
  for (const fn of functions) {
    if (fn.name.length < 4) continue;
    if (GENERIC_NAMES.has(fn.name)) continue;
    if (fn.bodyTokenCount < REIMPL_MIN_BODY_TOKENS) continue;
    if (REIMPL_NOT_SHIPPED_RES.some((re) => re.test(fn.relativePath))) continue;
    let files = filesByName.get(fn.name);
    if (!files) {
      files = new Set();
      filesByName.set(fn.name, files);
    }
    files.add(fn.relativePath);
  }
  let count = 0;
  for (const files of filesByName.values()) {
    if (files.size >= 2) count++;
  }
  return count;
}

/**
 * Shorten a long relative path for display. Keep the last two segments
 * so the user can still orient (service vs helper vs handler).
 *   "src/services/user-service.ts"  → "services/user-service.ts"
 *   "a.ts"                          → "a.ts"
 */
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}
