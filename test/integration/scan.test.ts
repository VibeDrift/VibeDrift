import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { buildAnalysisContext } from "../../src/core/discovery.js";
import { parseFiles } from "../../src/utils/ast.js";
import { createAnalyzerRegistry } from "../../src/analyzers/index.js";
import { computeScores } from "../../src/scoring/engine.js";

const FIXTURES = resolve(__dirname, "../fixtures");

async function scanFixture(name: string) {
  const { ctx } = await buildAnalysisContext(resolve(FIXTURES, name));
  await parseFiles(ctx.files);
  const analyzers = createAnalyzerRegistry();
  const findings = [];
  for (const a of analyzers) {
    findings.push(...(await a.analyze(ctx)));
  }
  const { compositeScore, maxCompositeScore } = computeScores(findings, ctx.totalLines, ctx);
  return { ctx, findings, compositeScore, maxCompositeScore };
}

describe("integration: full scan pipeline", () => {
  it("scans messy JS/TS project and finds issues", async () => {
    const { findings, compositeScore } = await scanFixture("messy-project");

    expect(findings.length).toBeGreaterThan(0);
    const ids = new Set(findings.map((f) => f.analyzerId));
    expect(ids.has("todo-density")).toBe(true);
    expect(ids.has("config-drift")).toBe(true);
    expect(ids.has("dependencies")).toBe(true);
    expect(ids.has("imports")).toBe(true);
    expect(ids.has("error-handling")).toBe(true);
    expect(ids.has("security")).toBe(true);
    expect(compositeScore).toBeLessThan(100);
  });

  it("scans clean JS/TS project at/above the population mean (no drift drag)", async () => {
    // This fixture is intentionally tiny (~18 LOC). Under evidence-weighting,
    // "no drift found" in so little code is weak evidence of cleanliness, so the
    // score regresses toward the population mean (~80) rather than a free 90+ —
    // a large clean project still earns ~100 (see the engine unit tests). What
    // matters here: a clean project carries NO drift drag, so it sits at the
    // evidence-weighted ceiling for its size, well above a drift-laden project.
    const { compositeScore, maxCompositeScore } = await scanFixture("clean-project");
    expect(maxCompositeScore).toBe(100);
    expect(compositeScore).toBeGreaterThanOrEqual(78);
  });

  it("handles empty project gracefully", async () => {
    const { ctx } = await buildAnalysisContext(resolve(FIXTURES, "empty-project"));
    expect(ctx.files.length).toBe(0);
  });

  it("scans Go project and finds Go-specific issues", async () => {
    const { findings, ctx } = await scanFixture("go-project");

    expect(ctx.dominantLanguage).toBe("go");

    const ids = new Set(findings.map((f) => f.analyzerId));
    // Should find: unchecked errors, TODO density, and potentially unused deps
    expect(ids.has("language-specific")).toBe(true);
    expect(ids.has("todo-density")).toBe(true);

    // Verify Go unchecked error detection
    const goErrors = findings.filter(
      (f) => f.analyzerId === "language-specific" && f.tags.includes("unchecked-error"),
    );
    expect(goErrors.length).toBeGreaterThan(0);
  });

  it("scans Python project and finds Python-specific issues", async () => {
    const { findings, ctx } = await scanFixture("python-project");

    expect(ctx.dominantLanguage).toBe("python");

    const ids = new Set(findings.map((f) => f.analyzerId));
    expect(ids.has("language-specific")).toBe(true);
    expect(ids.has("todo-density")).toBe(true);

    // Bare except detection
    const bareExcepts = findings.filter(
      (f) => f.tags.includes("bare-except"),
    );
    expect(bareExcepts.length).toBeGreaterThan(0);

    // Mutable default detection
    const mutableDefaults = findings.filter(
      (f) => f.tags.includes("mutable-default"),
    );
    expect(mutableDefaults.length).toBeGreaterThan(0);
  });

  it("scans Rust project and finds Rust-specific issues", async () => {
    const { findings, ctx } = await scanFixture("rust-project");

    expect(ctx.dominantLanguage).toBe("rust");

    const ids = new Set(findings.map((f) => f.analyzerId));
    expect(ids.has("language-specific")).toBe(true);

    // unwrap() detection
    const unwraps = findings.filter(
      (f) => f.tags.includes("unwrap"),
    );
    expect(unwraps.length).toBeGreaterThan(0);

    // unsafe block detection
    const unsafeBlocks = findings.filter(
      (f) => f.analyzerId === "language-specific" && f.tags.includes("unsafe"),
    );
    expect(unsafeBlocks.length).toBeGreaterThan(0);
  });
});
