import { describe, it, expect } from "vitest";
import { classifyPatterns, patternFindings } from "../../../src/codedna/pattern-classifier.js";
import { scoreDeviations } from "../../../src/codedna/deviation-heuristics.js";
import type { SourceFile } from "../../../src/core/types.js";

/**
 * Drift needs a baseline to deviate FROM, and the plurality winner is not one.
 *
 * The project-wide pattern vote took whichever pattern had the highest count no
 * matter how thin the win, so a 3/3/3 split across nine handlers named the
 * first-seen pattern "the convention" and reported the other SIX files as
 * pattern drift — against a 33% plurality. That is a repo with no convention,
 * which is a repo with no pattern drift to report; the cross-file drift
 * detectors already apply an entropy gate for exactly this reason.
 */

const file = (relativePath: string, content: string): SourceFile => ({
  path: `/repo/${relativePath}`,
  relativePath,
  language: "typescript",
  content,
  lineCount: content.split("\n").length,
});

const REPOSITORY = "export async function load(id: string) {\n  return repository.findUser(id);\n}\n";
const RAW_SQL = 'export async function load(id: string) {\n  return db.Query("SELECT * FROM users");\n}\n';
const HTTP = 'export async function load(id: string) {\n  return fetch("https://api.example.com/users");\n}\n';

function handlers(...bodies: string[]): SourceFile[] {
  return bodies.map((content, i) => file(`src/handlers/h${i}.ts`, content));
}

function distributionsFor(files: SourceFile[]) {
  const dists = classifyPatterns(files);
  // Guard the fixture itself: if the classifier stopped labelling these, the
  // dominance assertions below would pass vacuously.
  expect(dists).toHaveLength(files.length);
  return dists;
}

describe("project-wide pattern dominance gate", () => {
  it("emits nothing on a 3/3/3 split across nine files", () => {
    const files = handlers(
      REPOSITORY, REPOSITORY, REPOSITORY,
      RAW_SQL, RAW_SQL, RAW_SQL,
      HTTP, HTTP, HTTP,
    );
    const dists = distributionsFor(files);
    // Three distinct patterns, three files each: a 33% plurality.
    expect(new Set(dists.map((d) => d.dominantPattern)).size).toBe(3);
    expect(patternFindings(dists)).toHaveLength(0);
  });

  it("emits nothing when the plurality is real but under the dominance threshold", () => {
    // 4/3/2 over nine files: a 44% plurality is still not a convention.
    const files = handlers(
      REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY,
      RAW_SQL, RAW_SQL, RAW_SQL,
      HTTP, HTTP,
    );
    expect(patternFindings(distributionsFor(files))).toHaveLength(0);
  });

  it("emits one finding per deviator on a 7/2 split, carrying the vote", () => {
    const files = handlers(
      REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY,
      RAW_SQL, RAW_SQL,
    );
    const findings = patternFindings(distributionsFor(files));
    const driftFindings = findings.filter((f) => f.tags?.includes("drift"));
    expect(driftFindings).toHaveLength(2);
    for (const f of driftFindings) {
      expect(f.driftSignal).toBeDefined();
      expect(f.driftSignal!.totalRelevantFiles).toBe(9);
      expect(f.driftSignal!.dominantCount).toBe(7);
      expect(f.driftSignal!.consistencyScore).toBe(78);
      expect(f.message).toContain("7/9");
    }
  });

  it("applies the same gate to the deviation-justification pass", () => {
    const split = handlers(
      REPOSITORY, REPOSITORY, REPOSITORY,
      RAW_SQL, RAW_SQL, RAW_SQL,
      HTTP, HTTP, HTTP,
    );
    expect(scoreDeviations(distributionsFor(split), split)).toHaveLength(0);

    const dominant = handlers(
      REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY, REPOSITORY,
      RAW_SQL, RAW_SQL,
    );
    expect(scoreDeviations(distributionsFor(dominant), dominant)).toHaveLength(2);
  });
});
