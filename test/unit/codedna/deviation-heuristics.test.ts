import { describe, it, expect } from "vitest";
import { scoreDeviations, deviationFindings } from "../../../src/codedna/deviation-heuristics.js";
import { classifyPatterns, patternFindings } from "../../../src/codedna/pattern-classifier.js";
import { mergePatternAndDeviation } from "../../../src/codedna/index.js";
import { DEFAULT_DEVIATION_WEIGHTS } from "../../../src/core/config.js";
import type { SourceFile } from "../../../src/core/types.js";

const file = (relativePath: string, content: string): SourceFile => ({
  path: `/repo/${relativePath}`,
  relativePath,
  language: "typescript",
  content,
  lineCount: content.split("\n").length,
});

const REPOSITORY = "export async function load(id: string) {\n  return repository.findUser(id);\n}\n";
const RAW_SQL = 'export async function load(id: string) {\n  return db.Query("SELECT * FROM users");\n}\n';

/** Three repository handlers (the convention) plus one raw-SQL deviator. */
function fixture(deviatorPath: string): SourceFile[] {
  return [
    file("src/handlers/a.ts", REPOSITORY),
    file("src/handlers/b.ts", REPOSITORY),
    file("src/handlers/c.ts", REPOSITORY),
    file(deviatorPath, RAW_SQL),
  ];
}

describe("hasAdjacentTest regex escaping", () => {
  it("does not throw on a filename containing regex metacharacters", () => {
    // The inline escape here was a broken character class (`[.*+?^${}()|[\\]\\\\]`
    // closes early at the `\\]`), so it escaped nothing and any filename with an
    // unbalanced `(` or `[` compiled to an invalid RegExp and threw mid-scan.
    const files = fixture("src/handlers/we(ird[a.b.ts");
    const dists = classifyPatterns(files);
    expect(dists).toHaveLength(4);

    let result: ReturnType<typeof scoreDeviations> | undefined;
    expect(() => {
      result = scoreDeviations(dists, files);
    }).not.toThrow();
    expect(result).toHaveLength(1);
    expect(result![0].relativePath).toBe("src/handlers/we(ird[a.b.ts");
  });

  it("still finds a genuine adjacent test file", () => {
    const files = [
      ...fixture("src/handlers/reports.ts"),
      file("src/handlers/reports.test.ts", "it('works', () => {});"),
    ];
    const [justification] = scoreDeviations(classifyPatterns(files), files);
    expect(justification.signals.map((s) => s.type)).toContain("adjacent_test");
  });
});

describe("no_comment weight comes from the weight table", () => {
  it("reads the weight instead of a hardcoded penalty", () => {
    const files = fixture("src/handlers/reports.ts");
    const dists = classifyPatterns(files);

    const [withDefault] = scoreDeviations(dists, files);
    const noCommentSignal = withDefault.signals.find((s) => s.type === "no_comment");
    expect(noCommentSignal).toBeDefined();
    expect(noCommentSignal!.weight).toBe(-0.1);

    const [withOverride] = scoreDeviations(dists, files, {
      weights: { ...DEFAULT_DEVIATION_WEIGHTS, no_comment: 0 },
    });
    expect(withOverride.signals.find((s) => s.type === "no_comment")!.weight).toBe(0);
    // Removing the penalty must move the signal total by exactly it. (The
    // justification SCORE is clamped to [0, 1], so on a heavily penalized
    // deviator both runs bottom out at 0 and would hide the difference.)
    const total = (j: typeof withDefault) => j.signals.reduce((n, s) => n + s.weight, 0);
    expect(total(withOverride)).toBeCloseTo(total(withDefault) + 0.1, 6);
  });

  it("no longer emits the dead git_recency signal", () => {
    const files = fixture("src/handlers/reports.ts");
    const [justification] = scoreDeviations(classifyPatterns(files), files);
    expect(justification.signals.map((s) => s.type)).not.toContain("git_recency");
  });
});

describe("pattern and deviation findings are not double-counted", () => {
  it("emits at most one architecturalConsistency drift finding per deviating file", () => {
    // Both detectors read the SAME deviation — the classifier says a file
    // deviates, the heuristics say whether that was deliberate. Emitting both
    // let the scoring engine's per-DETECTOR noisy-OR count one file's single
    // deviation as two independent patterns drifting.
    const files = [
      file("src/handlers/a.ts", REPOSITORY),
      file("src/handlers/b.ts", REPOSITORY),
      file("src/handlers/c.ts", REPOSITORY),
      file("src/handlers/d.ts", REPOSITORY),
      file("src/handlers/e.ts", REPOSITORY),
      file("src/handlers/legacy.ts", RAW_SQL),
    ];
    const dists = classifyPatterns(files);
    const justifications = scoreDeviations(dists, files);
    const rawDeviation = deviationFindings(justifications);
    // The fixture must actually exercise the overlap.
    expect(rawDeviation.length).toBeGreaterThan(0);

    const merged = mergePatternAndDeviation(patternFindings(dists), rawDeviation, justifications);
    const perFile = merged.filter((f) => f.locations[0]?.file === "src/handlers/legacy.ts");
    expect(perFile).toHaveLength(1);
    expect(perFile[0].analyzerId).toBe("codedna-pattern");
    // Nothing the deviation finding said is lost: the verdict is folded in.
    expect(perFile[0].tags).toContain("accidental");
    expect(perFile[0].message).toContain("looks accidental");
  });

  it("keeps a deviation finding for a file the pattern detector did not flag", () => {
    const orphan = deviationFindings([
      {
        file: "/repo/src/other.ts",
        relativePath: "src/other.ts",
        deviatingPattern: "raw_sql",
        dominantPattern: "repository",
        justificationScore: 0.1,
        signals: [],
        verdict: "likely_accidental",
      },
    ]);
    expect(mergePatternAndDeviation([], orphan, [])).toHaveLength(1);
  });
});
