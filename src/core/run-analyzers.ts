import type { Analyzer } from "../analyzers/base.js";
import type { AnalysisContext, Finding } from "./types.js";
import {
  computeAnalyzerCacheKey,
  filterApplicableFiles,
  loadAnalyzerFindings,
  saveAnalyzerFindings,
} from "./findings-cache.js";
import { debug } from "./debug.js";

export interface RunAnalyzersResult {
  findings: Finding[];
  cacheHits: number;
  cacheMisses: number;
  /**
   * Ids of analyzers that threw and were skipped. Their findings are absent
   * from `findings`, so any score computed from this result is degraded —
   * callers must surface this rather than report a clean-looking score.
   */
  failed: string[];
}

/**
 * Run all analyzers CONCURRENTLY and reassemble their findings in analyzer
 * DECLARATION order. Analyzers are pure/read-only over `ctx`, so concurrency
 * is safe; `Promise.all` preserves array order, so the flattened result is
 * byte-identical to the old sequential loop (determinism is preserved — see
 * the order-preservation test). The win is overlapping each analyzer's cache
 * I/O and letting the event loop interleave, which speeds up every scan and
 * every watch-mode tick. (CPU-bound AST work is still serial on Node's single
 * thread — true CPU parallelism would need worker threads, deferred.)
 */
export async function runAnalyzers(
  analyzers: Analyzer[],
  ctx: AnalysisContext,
  opts: { rootDir: string; cacheEnabled: boolean },
): Promise<RunAnalyzersResult> {
  const perAnalyzer = await Promise.all(
    analyzers.map(async (analyzer): Promise<{ findings: Finding[]; hit: boolean; failed: boolean }> => {
      let findings: Finding[] | null = null;
      let cacheKey: string | null = null;

      if (opts.cacheEnabled) {
        const applicable = filterApplicableFiles(ctx.files, analyzer.applicableLanguages);
        cacheKey = computeAnalyzerCacheKey(analyzer.id, analyzer.version ?? 1, applicable);
        findings = await loadAnalyzerFindings(opts.rootDir, cacheKey);
      }

      if (findings === null) {
        // Isolate each analyzer: one throwing must not reject the whole
        // Promise.all and kill every other analyzer's findings. Skip the
        // failing one, keep going with the rest — but never silently: the
        // score computed downstream will be missing this analyzer's
        // findings, and a silently-wrong score is worse than a crash. The
        // warning always goes to stderr (debug() is off by default, so it
        // alone would hide the failure from every normal user); the stack
        // stays behind debug() to keep the default output readable.
        try {
          findings = await analyzer.analyze(ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `vibedrift: warning — analyzer "${analyzer.id}" failed and was skipped; ` +
              `the score does not include its findings (${message})\n`,
          );
          debug("analyzers", `analyzer "${analyzer.id}" threw and was skipped:`, err);
          return { findings: [], hit: false, failed: true };
        }
        if (opts.cacheEnabled && cacheKey !== null) {
          await saveAnalyzerFindings(opts.rootDir, cacheKey, findings);
        }
        return { findings, hit: false, failed: false };
      }
      return { findings, hit: true, failed: false };
    }),
  );

  const findings: Finding[] = [];
  const failed: string[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (let i = 0; i < perAnalyzer.length; i++) {
    const r = perAnalyzer[i];
    for (const f of r.findings) findings.push(f); // in-order (Promise.all preserves analyzer order); loop, not spread: unbounded set
    // A failed analyzer is neither a hit nor a miss — it never produced a
    // result to cache, so counting it as a miss would misreport the cache stats.
    if (r.failed) failed.push(analyzers[i].id);
    else if (r.hit) cacheHits++;
    else cacheMisses++;
  }
  return { findings, cacheHits, cacheMisses, failed };
}
