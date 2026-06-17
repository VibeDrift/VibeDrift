import { describe, it, expect } from "vitest";
import { runAnalyzers } from "../../../src/core/run-analyzers.js";
import type { Analyzer } from "../../../src/analyzers/base.js";
import type { AnalysisContext, Finding } from "../../../src/core/types.js";

function mockAnalyzer(id: string, delayMs: number): Analyzer {
  return {
    id,
    name: id,
    category: "redundancy",
    requiresAST: false,
    applicableLanguages: "all",
    async analyze(): Promise<Finding[]> {
      await new Promise((r) => setTimeout(r, delayMs));
      return [{ analyzerId: id, severity: "info", confidence: 1, message: id, locations: [], tags: [] }];
    },
  };
}

const emptyCtx = { files: [] } as unknown as AnalysisContext;

describe("runAnalyzers (concurrent, order-preserving)", () => {
  it("returns findings in DECLARATION order even when analyzers resolve out of order", async () => {
    // C resolves first, A last — but the output must still be A, B, C
    // (determinism: parallelism must not change the result vs sequential).
    const analyzers = [mockAnalyzer("A", 30), mockAnalyzer("B", 15), mockAnalyzer("C", 0)];
    const { findings, cacheMisses } = await runAnalyzers(analyzers, emptyCtx, { rootDir: "/x", cacheEnabled: false });
    expect(findings.map((f) => f.analyzerId)).toEqual(["A", "B", "C"]);
    expect(cacheMisses).toBe(3);
  });

  it("actually runs concurrently (wall-clock << sum of per-analyzer delays)", async () => {
    const analyzers = [mockAnalyzer("A", 60), mockAnalyzer("B", 60), mockAnalyzer("C", 60)];
    const t = Date.now();
    await runAnalyzers(analyzers, emptyCtx, { rootDir: "/x", cacheEnabled: false });
    const elapsed = Date.now() - t;
    // Sequential would be ~180ms; concurrent ~60ms. Generous ceiling to avoid flake.
    expect(elapsed).toBeLessThan(140);
  });

  it("flattens findings from all analyzers", async () => {
    const analyzers = [mockAnalyzer("A", 0), mockAnalyzer("B", 0)];
    const { findings } = await runAnalyzers(analyzers, emptyCtx, { rootDir: "/x", cacheEnabled: false });
    expect(findings).toHaveLength(2);
  });
});
