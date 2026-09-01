import { describe, it, expect, vi } from "vitest";
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

  it("isolates a throwing analyzer — the rest still produce findings (regression: one throw killed the whole Promise.all)", async () => {
    const throwing: Analyzer = {
      id: "boom",
      name: "boom",
      category: "redundancy",
      requiresAST: false,
      applicableLanguages: "all",
      async analyze(): Promise<Finding[]> {
        throw new Error("analyzer exploded");
      },
    };
    const analyzers = [mockAnalyzer("A", 0), throwing, mockAnalyzer("C", 0)];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { findings, failed, cacheHits, cacheMisses } = await runAnalyzers(analyzers, emptyCtx, { rootDir: "/x", cacheEnabled: false });
      // A and C's findings survive; "boom" contributes nothing but doesn't
      // reject the whole run. Declaration order preserved for the survivors.
      expect(findings.map((f) => f.analyzerId)).toEqual(["A", "C"]);
      // The failure must not be silent: it's reported by id so the scan can
      // mark its result degraded, and it's NOT tallied as an ordinary cache
      // miss (it never produced a result to cache).
      expect(failed).toEqual(["boom"]);
      expect(cacheHits).toBe(0);
      expect(cacheMisses).toBe(2);
      // Normal users must see something even with debug logging off — one
      // warning line on stderr naming the analyzer and the error.
      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toMatch(/warning/);
      expect(written).toContain('"boom"');
      expect(written).toContain("analyzer exploded");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("reports an empty `failed` list when every analyzer succeeds", async () => {
    const analyzers = [mockAnalyzer("A", 0), mockAnalyzer("B", 0)];
    const { failed } = await runAnalyzers(analyzers, emptyCtx, { rootDir: "/x", cacheEnabled: false });
    expect(failed).toEqual([]);
  });
});
