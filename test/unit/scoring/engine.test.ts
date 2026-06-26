import { describe, it, expect } from "vitest";
import { computeScores, estimateScoreAfterFixes } from "../../../src/scoring/engine.js";
import type { Finding } from "../../../src/core/types.js";

describe("scoring engine", () => {
  it("gives max score with no findings (ample evidence)", () => {
    // No findings + AMPLE evidence (high LOC): "no drift found across a lot of
    // code" is strong evidence of cleanliness, so core categories reach max.
    // A thin-evidence repo regresses toward the prior — see the evidence-
    // weighting test below.
    const { scores, compositeScore, maxCompositeScore } = computeScores([], 30000);
    // Core categories always have input from code → measured-clean at 20 when empty (given evidence).
    expect(scores.architecturalConsistency.score).toBe(20);
    expect(scores.redundancy.score).toBe(20);
    // dependencyHealth has ONLY hygiene analyzers now — when measured on the
    // drift track, it has no applicable analyzers and reports applicable: false.
    expect(scores.dependencyHealth.applicable).toBe(false);
    // Surface-specific categories with no findings are NOT-MEASURED (no evidence
    // of a security surface / intent signal), so they are excluded from the
    // composite rather than credited a free 20/20.
    expect(scores.securityPosture.applicable).toBe(false);
    expect(scores.intentClarity.applicable).toBe(false);
    // Composite is the geometric mean of the MEASURED categories' health × 100.
    // With arch and redundancy at full health and the rest excluded, it is 100.
    expect(compositeScore).toBe(100);
    expect(maxCompositeScore).toBe(100);
  });

  it("evidence-weights no-finding categories: a tiny repo does not earn a free 100", () => {
    // The size-bias fix: "no drift found" is only strong evidence of cleanliness
    // when there was enough code to find drift in. A tiny repo with no findings
    // regresses toward the population prior instead of a free max score, while a
    // large repo with no findings still earns ~max. Score must rise with evidence.
    const tiny = computeScores([], 300).compositeScore;
    const small = computeScores([], 2000).compositeScore;
    const large = computeScores([], 30000).compositeScore;
    expect(tiny).toBeLessThan(100);          // no free perfect score on thin evidence
    expect(tiny).toBeGreaterThan(50);        // regresses toward the prior, not to zero
    expect(small).toBeGreaterThan(tiny);     // more evidence → higher clean credit
    expect(large).toBeGreaterThan(small);
    expect(large).toBe(100);                 // ample evidence → full clean credit
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

  it("surface-specific categories are not-measured when empty, measured+unlocked when they fire", () => {
    // With no findings, security/intent have no surface evidence → not-measured.
    const empty = computeScores([], 1000);
    expect(empty.scores.securityPosture.applicable).toBe(false);
    expect(empty.scores.intentClarity.applicable).toBe(false);

    // A security drift finding means the surface exists → measured + unlocked.
    const withSecurity = computeScores(
      [
        {
          analyzerId: "drift-security_posture",
          severity: "warning",
          confidence: 0.9,
          message: "auth inconsistency",
          locations: [{ file: "src/routes/a.ts", line: 1 }],
          tags: ["drift"],
          driftSignal: { consistencyScore: 60, dominantCount: 6, totalRelevantFiles: 10 },
        },
      ],
      1000,
    );
    expect(withSecurity.scores.securityPosture.applicable).toBe(true);
    expect(withSecurity.scores.securityPosture.locked).toBe(false);
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
      // Ample LOC so no-finding drift categories saturate to max (evidence-
      // weighting is tested separately) — isolates the drift/hygiene split.
      const { compositeScore, maxCompositeScore, hygieneScore, maxHygieneScore } = computeScores(
        findings,
        30000,
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
      // Ample LOC so no-finding hygiene categories saturate to max (evidence-
      // weighting is tested separately) — isolates the drift/hygiene split.
      const { compositeScore, maxCompositeScore, hygieneScore, maxHygieneScore } = computeScores(
        findings,
        30000,
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

    it("max drift composite is /100 (geometric mean of category healths × 100)", () => {
      const { maxCompositeScore, maxHygieneScore } = computeScores([], 1000);
      // The composite is the geometric mean of per-category health (score /
      // maxScore) scaled to /100, so the headline is always out of 100
      // regardless of how many categories are applicable on this track.
      expect(maxCompositeScore).toBe(100);
      // Hygiene composite is on the same /100 scale.
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

    // Regression: the cumulative Fix-Plan projection ("if all N close: +Npts
    // consistency") is displayed alongside per-item consistencyImpacts and
    // labeled "sub-additive (non-linear decay)". The composite delta is in a
    // DIFFERENT unit (geometric mean × 100) than the per-item impacts (category
    // points), so it could come out SUPER-additive (> the sum of impacts) —
    // contradicting both the math and the label. The projection must be returned
    // in the SAME consistency-point unit and be genuinely sub-additive:
    //   max(individual) <= consistencyGain <= sum(individual)
    it("consistencyGain is in the same unit as per-item impacts and is sub-additive", () => {
      function dom(
        analyzerId: string,
        consistencyScore: number,
        file: string,
        n: number,
      ): Finding {
        return {
          analyzerId,
          severity: "warning",
          confidence: 0.9,
          message: `DRIFT ${analyzerId}`,
          locations: [{ file, line: 1 }],
          tags: ["drift"],
          driftSignal: {
            consistencyScore,
            dominantCount: Math.round((n * consistencyScore) / 100),
            totalRelevantFiles: n,
          },
        };
      }

      // Spread drift across SEVERAL categories so the geometric-mean composite
      // delta is amplified — this is the configuration that used to go
      // super-additive (cumulative composite gain > sum of per-item impacts).
      const findings: Finding[] = [
        dom("drift-logging_consistency", 70, "src/a.ts", 39),
        dom("drift-architectural_consistency", 85, "src/b.ts", 20),
        dom("drift-comment_style_consistency", 60, "src/c.ts", 130),
        dom("drift-return_shape_consistency", 90, "src/d.ts", 10),
        dom("drift-export_style", 88, "src/e.ts", 9),
        dom("drift-security_posture", 50, "src/routes/x.ts", 8),
      ];
      const lines = 20000;

      // Populate per-item consistencyImpact (mutateImpact defaults to true).
      computeScores(findings, lines);
      const top = findings.slice(0, 5);
      const sumIndividual = top.reduce((s, f) => s + (f.consistencyImpact ?? 0), 0);
      const maxIndividual = Math.max(...top.map((f) => f.consistencyImpact ?? 0));

      const after = estimateScoreAfterFixes(findings, top, lines);

      // The projection must be returned in consistency-point units.
      expect(typeof after.consistencyGain).toBe("number");
      // Genuinely sub-additive AND monotonic vs the individual impacts.
      expect(after.consistencyGain).toBeGreaterThanOrEqual(maxIndividual - 1e-6);
      expect(after.consistencyGain).toBeLessThanOrEqual(sumIndividual + 1e-6);
    });

    it("consistencyGain equals the largest single impact when only one finding is fixed", () => {
      const all = [
        mkFinding("naming", "error", "a"),
        mkFinding("duplicates", "warning", "c"),
      ];
      computeScores(all, 5000);
      const after = estimateScoreAfterFixes(all, [all[0]], 5000);
      // Fixing exactly one finding: cumulative gain == that finding's own impact,
      // at the 1-decimal precision both numbers are displayed in (category scores
      // round to 1 decimal). The per-finding impact and the cumulative recompute
      // now share the SAME empty-category clean-credit model, so they agree.
      expect(after.consistencyGain).toBeCloseTo(all[0].consistencyImpact ?? 0, 1);
    });

    it("consistencyGain is zero when nothing is fixed", () => {
      const all = [mkFinding("naming", "error", "a")];
      computeScores(all, 1000);
      const after = estimateScoreAfterFixes(all, [], 1000);
      expect(after.consistencyGain).toBe(0);
    });
  });
});
