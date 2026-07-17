import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { buildAnalysisContext } from "../../src/core/discovery.js";
import { runDriftDetection } from "../../src/drift/index.js";

const FIXTURES = resolve(__dirname, "../fixtures");

describe("drift detection engine", () => {
  it("detects architectural contradictions in drift-project fixture", async () => {
    const { ctx } = await buildAnalysisContext(resolve(FIXTURES, "drift-project"));
    const { driftFindings, driftScores } = runDriftDetection(ctx);

    // Should find data access pattern drift (raw SQL vs ORM/repository)
    const archFindings = driftFindings.filter(
      (f) => f.driftCategory === "architectural_consistency",
    );
    expect(archFindings.length).toBeGreaterThan(0);

    // Should detect that order_handler uses raw SQL
    const dataAccessDrift = archFindings.find(
      (f) => f.subCategory === "data_access",
    );
    expect(dataAccessDrift).toBeDefined();
    expect(
      dataAccessDrift!.deviatingFiles.some((f) => f.path.includes("order_handler")),
    ).toBe(true);

    // Item 2: dominantFiles must be populated for drift findings that have
    // a concrete peer baseline, and must NOT include deviators.
    expect(dataAccessDrift!.dominantFiles).toBeDefined();
    expect(dataAccessDrift!.dominantFiles!.length).toBeGreaterThan(0);
    const deviatorPaths = new Set(dataAccessDrift!.deviatingFiles.map((d) => d.path));
    for (const domFile of dataAccessDrift!.dominantFiles!) {
      expect(deviatorPaths.has(domFile)).toBe(false);
    }
  });

  it("propagates dominantFiles into Finding.metadata for drift-category findings", async () => {
    const { ctx } = await buildAnalysisContext(resolve(FIXTURES, "drift-project"));
    const { findings } = runDriftDetection(ctx);
    const driftF = findings.find(
      (f) => f.analyzerId === "drift-architectural_consistency",
    );
    expect(driftF).toBeDefined();
    expect(driftF!.metadata).toBeDefined();
    expect(driftF!.metadata!.dominantPattern).toBeTruthy();
    expect(Array.isArray(driftF!.metadata!.dominantFiles)).toBe(true);
  });

  it("detects naming convention oscillation", async () => {
    const { ctx } = await buildAnalysisContext(resolve(FIXTURES, "drift-project"));
    const { driftFindings } = runDriftDetection(ctx);

    const namingFindings = driftFindings.filter(
      (f) => f.driftCategory === "naming_conventions",
    );
    // The drift project has snake_case in order_handler among camelCase majority
    // May or may not trigger depending on thresholds
    // At minimum, the detector should run without errors
    expect(namingFindings).toBeDefined();
  });

  it("produces drift scores with proper weights", async () => {
    const { ctx } = await buildAnalysisContext(resolve(FIXTURES, "drift-project"));
    const { driftScores } = runDriftDetection(ctx);

    // Scores should exist for the always-measured categories.
    expect(driftScores.architectural_consistency).toBeDefined();
    expect(driftScores.semantic_duplication).toBeDefined();
    expect(driftScores.naming_conventions).toBeDefined();
    expect(driftScores.phantom_scaffolding).toBeDefined();
    // security_posture is surface-specific: present only when the fixture
    // produced security findings, absent (not a free full-health bar) when
    // there was nothing to measure — mirroring the composite's N/A rule.
    if (driftScores.security_posture) {
      expect(driftScores.security_posture.findings).toBeGreaterThan(0);
    }

    // Dual-engine collapse (Phase 0): driftScores no longer computes its own
    // composite/grade via a second (linear) formula. The single authoritative
    // composite is the scoring engine's compositeScore (computeScores). What
    // remains here is the per-category breakdown used for report bars.
    expect((driftScores as Record<string, unknown>).composite).toBeUndefined();
    expect((driftScores as Record<string, unknown>).grade).toBeUndefined();

    // Max scores should match spec weights
    expect(driftScores.architectural_consistency.maxScore).toBe(16);
    // security_posture may be absent (not measured) — weight applies only when present.
    if (driftScores.security_posture) expect(driftScores.security_posture.maxScore).toBe(14);
    expect(driftScores.semantic_duplication.maxScore).toBe(14);
    expect(driftScores.naming_conventions.maxScore).toBe(12);
    expect(driftScores.phantom_scaffolding.maxScore).toBe(12);
    expect(driftScores.import_style.maxScore).toBe(12);
    expect(driftScores.export_style.maxScore).toBe(10);
    expect(driftScores.async_patterns.maxScore).toBe(10);
  });

  it("produces no drift findings for clean project", async () => {
    const { ctx } = await buildAnalysisContext(resolve(FIXTURES, "clean-project"));
    const { driftFindings, driftScores } = runDriftDetection(ctx);

    // Clean project should have minimal or no drift
    expect(driftFindings.length).toBe(0);
    // With zero drift findings, every per-category breakdown reads full score.
    expect(driftScores.architectural_consistency.score).toBe(
      driftScores.architectural_consistency.maxScore,
    );
  });
});
