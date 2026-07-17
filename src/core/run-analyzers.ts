import type { Analyzer } from "../analyzers/base.js";
import type { AnalysisContext, Finding } from "./types.js";
import {
  computeAnalyzerCacheKey,
  filterApplicableFiles,
  loadAnalyzerFindings,
  saveAnalyzerFindings,
} from "./findings-cache.js";

export interface RunAnalyzersResult {
  findings: Finding[];
  cacheHits: number;
  cacheMisses: number;
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
    analyzers.map(async (analyzer): Promise<{ findings: Finding[]; hit: boolean }> => {
      let findings: Finding[] | null = null;
      let cacheKey: string | null = null;

      if (opts.cacheEnabled) {
        const applicable = filterApplicableFiles(ctx.files, analyzer.applicableLanguages);
        cacheKey = computeAnalyzerCacheKey(analyzer.id, analyzer.version ?? 1, applicable);
        findings = await loadAnalyzerFindings(opts.rootDir, cacheKey);
      }

      if (findings === null) {
        findings = await analyzer.analyze(ctx);
        if (opts.cacheEnabled && cacheKey !== null) {
          await saveAnalyzerFindings(opts.rootDir, cacheKey, findings);
        }
        return { findings, hit: false };
      }
      return { findings, hit: true };
    }),
  );

  const findings: Finding[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const r of perAnalyzer) {
    for (const f of r.findings) findings.push(f); // in-order (Promise.all preserves analyzer order); loop, not spread: unbounded set
    if (r.hit) cacheHits++;
    else cacheMisses++;
  }
  return { findings, cacheHits, cacheMisses };
}
