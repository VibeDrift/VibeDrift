import { describe, it, expect } from "vitest";
import { computeScores, estimateScoreAfterFixes } from "../../../src/scoring/engine.js";
import type { Finding } from "../../../src/core/types.js";

describe("scoring engine", () => {
  it("gives max score with no findings", () => {
    const { scores, compositeScore, maxCompositeScore } = computeScores([], 1000);
    expect(scores.architecturalConsistency.score).toBe(20);
    expect(scores.redundancy.score).toBe(20);
    // dependencyHealth has ONLY hygiene analyzers now — when measured on the
    // drift track, it has no applicable analyzers and reports score: 0,
    // applicable: false. It is excluded from the drift composite entirely.
    expect(scores.dependencyHealth.applicable).toBe(false);
    expect(scores.securityPosture.score).toBe(20);
    expect(scores.intentClarity.score).toBe(20);
    // Drift composite excludes dependencyHealth (hygiene-only), so 4 × 20 = 80
    // raw — then normalized to /100 for presentation. Perfect = 100/100.
    expect(compositeScore).toBe(100);
    expect(maxCompositeScore).toBe(100);
  });

  it("reduces score with findings", () => {
    const findings: Finding[] = [
      {
        analyzerId: "naming",
        severity: "error",
        confidence: 0.9,
        message: "test",
        locations: [],
        tags: [],
      },
      {
        analyzerId: "naming",
        severity: "error",
        confidence: 0.9,
        message: "test2",
        locations: [],
        tags: [],
      },
    ];
    const { scores } = computeScores(findings, 1000);
    expect(scores.architecturalConsistency.score).toBeLessThan(20);
  });

  it("all applicable drift categories are unlocked", () => {
    const { scores } = computeScores([], 1000);
    expect(scores.securityPosture.locked).toBe(false);
    expect(scores.intentClarity.locked).toBe(false);
    expect(scores.securityPosture.applicable).toBe(true);
    expect(scores.intentClarity.applicable).toBe(true);
  });

  describe("drift vs hygiene separation", () => {
    function mk(analyzerId: string, severity: Finding["severity"] = "error"): Finding {
      return {
        analyzerId,
        severity,
        confidence: 0.9,
        message: `test ${analyzerId}`,
        locations: [{ file: `src/${analyzerId}.ts`, line: 1 }],
        tags: [],
      };
    }

    it("hygiene-only findings do NOT affect the drift composite", () => {
      // complexity, dead-code, todo-density, intent-clarity, error-handling
      // are all hygiene analyzers. Firing 10 of them should leave the Vibe
      // Drift Score untouched.
      const findings: Finding[] = [
        mk("complexity"), mk("complexity"), mk("complexity"),
        mk("dead-code"), mk("dead-code"),
        mk("todo-density"), mk("todo-density"),
        mk("intent-clarity"),
        mk("error-handling"),
        mk("duplicates"),
      ];
      const { compositeScore, maxCompositeScore, hygieneScore, maxHygieneScore } = computeScores(
        findings,
        1000,
      );
      // Drift composite: pristine — no drift findings fired.
      expect(compositeScore).toBe(maxCompositeScore);
      // Hygiene composite: hurt — 10 hygiene findings landed here instead.
      expect(hygieneScore).toBeLessThan(maxHygieneScore);
      expect(maxHygieneScore).toBeGreaterThan(0);
    });

    it("drift findings DO hurt the drift composite", () => {
      // drift-naming_conventions, codedna-fingerprint, ml-anomaly are
      // drift-kind analyzers. (analyzerId is `drift-<driftCategory>`.)
      const findings: Finding[] = [
        mk("drift-naming_conventions"),
        mk("drift-naming_conventions"),
        mk("codedna-fingerprint"),
        mk("ml-anomaly"),
      ];
      const { compositeScore, maxCompositeScore, hygieneScore, maxHygieneScore } = computeScores(
        findings,
        1000,
      );
      // Drift composite: hurt.
      expect(compositeScore).toBeLessThan(maxCompositeScore);
      // Hygiene composite: untouched.
      expect(hygieneScore).toBe(maxHygieneScore);
    });

    it("mixed findings hit the correct track only", () => {
      const findings: Finding[] = [
        mk("drift-architectural_consistency"),
        mk("complexity"),
        mk("codedna-taint"),
        mk("dead-code"),
      ];
      const { compositeScore, maxCompositeScore, hygieneScore, maxHygieneScore } = computeScores(
        findings,
        1000,
      );
      expect(compositeScore).toBeLessThan(maxCompositeScore);
      expect(hygieneScore).toBeLessThan(maxHygieneScore);
      // Each track should be a strict reduction — neither track should be
      // at zero with only 2 findings in its set.
      expect(compositeScore).toBeGreaterThan(0);
      expect(hygieneScore).toBeGreaterThan(0);
    });

    it("consistencyImpact is populated on drift findings and NOT on hygiene findings", () => {
      const drift = mk("drift-naming_conventions");
      const hygiene = mk("complexity");
      computeScores([drift, hygiene], 1000);
      expect(drift.consistencyImpact).toBeGreaterThan(0);
      // Hygiene track is invoked with mutateImpact: false — hygiene findings
      // never get consistencyImpact because Fix Plan prioritizes drift.
      expect(hygiene.consistencyImpact).toBeUndefined();
    });

    it("dependencyHealth is applicable only on the hygiene track (has no drift analyzers)", () => {
      const { scores, hygieneScores } = computeScores([mk("dependencies")], 1000);
      expect(scores.dependencyHealth.applicable).toBe(false);
      expect(hygieneScores.dependencyHealth.applicable).toBe(true);
      expect(hygieneScores.dependencyHealth.score).toBeLessThan(20);
    });

    it("max drift composite is /100 (4 × 20 = 80 internal, normalized)", () => {
      const { maxCompositeScore, maxHygieneScore } = computeScores([], 1000);
      // Drift internal max is 80 (4 applicable categories × 20). The engine
      // normalizes to 100 at the boundary so the headline displays /100,
      // matching user expectations from every other code-quality tool.
      expect(maxCompositeScore).toBe(100);
      // Hygiene covers all 5 categories — already /100 internally.
      expect(maxHygieneScore).toBe(100);
    });
  });

  describe("consistencyImpact", () => {
    it("populates consistencyImpact on every finding that affects a category", () => {
      const findings: Finding[] = [
        {
          analyzerId: "naming",
          severity: "error",
          confidence: 0.9,
          message: "e",
          locations: [{ file: "src/a.ts", line: 1 }],
          tags: [],
        },
        {
          analyzerId: "naming",
          severity: "warning",
          confidence: 0.7,
          message: "w",
          locations: [{ file: "src/b.ts", line: 1 }],
          tags: [],
        },
      ];
      computeScores(findings, 1000);
      expect(findings[0].consistencyImpact).toBeGreaterThan(0);
      expect(findings[1].consistencyImpact).toBeGreaterThan(0);
      // Error with higher confidence has larger impact than warning with lower
      expect(findings[0].consistencyImpact!).toBeGreaterThan(findings[1].consistencyImpact!);
    });

    it("assigns a higher impact to findings on entry-point files", () => {
      const entryFinding: Finding = {
        analyzerId: "naming",
        severity: "error",
        confidence: 0.9,
        message: "entry",
        locations: [{ file: "src/index.ts", line: 1 }],
        tags: [],
      };
      const sideFinding: Finding = {
        analyzerId: "naming",
        severity: "error",
        confidence: 0.9,
        message: "side",
        locations: [{ file: "src/utils/helper.ts", line: 1 }],
        tags: [],
      };
      computeScores([entryFinding, sideFinding], 1000);
      expect(entryFinding.consistencyImpact!).toBeGreaterThan(sideFinding.consistencyImpact!);
    });

    it("does NOT mutate consistencyImpact when mutateImpact is false", () => {
      const f: Finding = {
        analyzerId: "naming",
        severity: "error",
        confidence: 0.9,
        message: "x",
        locations: [{ file: "a.ts", line: 1 }],
        tags: [],
      };
      computeScores([f], 1000, undefined, undefined, { mutateImpact: false });
      expect(f.consistencyImpact).toBeUndefined();
    });
  });

  describe("estimateScoreAfterFixes", () => {
    function mkFinding(analyzerId: string, severity: Finding["severity"], id: string): Finding {
      return {
        analyzerId, severity, confidence: 0.9,
        message: id,
        locations: [{ file: `src/${id}.ts`, line: 1 }],
        tags: [],
      };
    }

    it("returns higher composite when findings are removed", () => {
      const all = [
        mkFinding("naming", "error", "a"),
        mkFinding("naming", "error", "b"),
        mkFinding("duplicates", "warning", "c"),
      ];
      const before = computeScores(all, 1000);
      const after = estimateScoreAfterFixes(all, [all[0], all[1]], 1000);
      expect(after.compositeScore).toBeGreaterThan(before.compositeScore);
    });

    it("returns the same composite when no findings are to be fixed", () => {
      const all = [
        mkFinding("naming", "error", "a"),
        mkFinding("duplicates", "warning", "c"),
      ];
      const before = computeScores(all, 1000);
      const after = estimateScoreAfterFixes(all, [], 1000);
      expect(after.compositeScore).toBe(before.compositeScore);
    });

    it("does not mutate the consistencyImpact of remaining findings", () => {
      const all = [
        mkFinding("naming", "error", "a"),
        mkFinding("duplicates", "warning", "c"),
      ];
      computeScores(all, 1000);
      const originalImpact = all[1].consistencyImpact;
      estimateScoreAfterFixes(all, [all[0]], 1000);
      expect(all[1].consistencyImpact).toBe(originalImpact);
    });
  });
});
