import { describe, it, expect } from "vitest";
import { commitArchaeology } from "../../../src/drift/commit-archaeology.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";
import type { FileGitMetadata } from "../../../src/core/types.js";

function makeFile(
  path: string,
  git: Partial<FileGitMetadata> | null,
): DriftFile {
  return {
    path,
    language: "typescript",
    content: "// test",
    lineCount: 1,
    git: git
      ? {
          lastModifiedDaysAgo: 7,
          uniqueAuthors: 1,
          commitCount90d: 1,
          commitCountTotal: 1,
          ...git,
        }
      : null,
  };
}

// A file that looks "cultivated" — multiple authors, spread-out commits.
const cultivated = (path: string): DriftFile =>
  makeFile(path, {
    uniqueAuthors: 3,
    commitCountTotal: 8,
    singleSession: false,
    authorDiversity: 1.5,
    medianCommitIntervalHours: 48,
  });

// A file that looks "burst" — single author, single session, tight interval.
const burst = (path: string): DriftFile =>
  makeFile(path, {
    uniqueAuthors: 1,
    commitCountTotal: 3,
    singleSession: true,
    authorDiversity: 0,
    medianCommitIntervalHours: 0.1,
  });

function ctx(files: DriftFile[], hasGit = true): DriftContext {
  return {
    files,
    totalLines: files.length,
    dominantLanguage: "typescript",
    hasGitMetadata: hasGit,
  };
}

describe("commit-archaeology detector", () => {
  it("returns no findings without git metadata", () => {
    const ctxNoGit = ctx(
      [
        burst("src/handlers/a.ts"),
        cultivated("src/handlers/b.ts"),
        cultivated("src/handlers/c.ts"),
      ],
      false,
    );
    expect(commitArchaeology.detect(ctxNoGit)).toHaveLength(0);
  });

  it("returns no findings on small repos (<10 files with git)", () => {
    const files = Array.from({ length: 5 }, (_, i) => burst(`src/a${i}.ts`));
    expect(commitArchaeology.detect(ctx(files))).toHaveLength(0);
  });

  it("flags the lone burst file in a directory of cultivated siblings", () => {
    const files = [
      // 12 cultivated files split across two directories — meets the
      // min-files and per-directory thresholds with room for a burst.
      ...Array.from({ length: 4 }, (_, i) => cultivated(`src/handlers/a${i}.ts`)),
      burst("src/handlers/odd.ts"),
      ...Array.from({ length: 4 }, (_, i) => cultivated(`src/services/b${i}.ts`)),
      ...Array.from({ length: 3 }, (_, i) => cultivated(`src/util/c${i}.ts`)),
    ];
    const findings = commitArchaeology.detect(ctx(files));
    expect(findings).toHaveLength(1);
    expect(findings[0].driftCategory).toBe("architectural_consistency");
    expect(findings[0].subCategory).toBe("burst_authorship");
    expect(findings[0].deviatingFiles).toHaveLength(1);
    expect(findings[0].deviatingFiles[0].path).toBe("src/handlers/odd.ts");
  });

  it("suppresses the signal when the repo is uniformly bursty (>40%)", () => {
    // 8 bursty + 4 cultivated across repo = 66% bursty → no signal.
    const files = [
      ...Array.from({ length: 8 }, (_, i) => burst(`src/a${i}.ts`)),
      ...Array.from({ length: 4 }, (_, i) => cultivated(`src/b${i}.ts`)),
    ];
    expect(commitArchaeology.detect(ctx(files))).toHaveLength(0);
  });

  it("ignores directories where bursty files are the majority (scaffolding)", () => {
    // migrations/ has 3 burst (all) and 0 cultivated — this is a generated
    // directory, not drift. Other dirs have cultivated files.
    const files = [
      ...Array.from({ length: 3 }, (_, i) => burst(`src/migrations/m${i}.ts`)),
      ...Array.from({ length: 8 }, (_, i) => cultivated(`src/services/s${i}.ts`)),
      ...Array.from({ length: 3 }, (_, i) => cultivated(`src/util/u${i}.ts`)),
    ];
    const findings = commitArchaeology.detect(ctx(files));
    // migrations/ is skipped (majority-bursty), other dirs have no bursty
    // files → no findings.
    expect(findings).toHaveLength(0);
  });

  it("skips files with <2 commits", () => {
    // All bursty, but only 1 commit each — below the history floor.
    const files = Array.from({ length: 12 }, (_, i) =>
      makeFile(`src/a${i}.ts`, {
        uniqueAuthors: 1,
        commitCountTotal: 1,
        singleSession: undefined,
      }),
    );
    expect(commitArchaeology.detect(ctx(files))).toHaveLength(0);
  });

  it("ignores test files", () => {
    const files = [
      ...Array.from({ length: 4 }, (_, i) => cultivated(`src/handlers/a${i}.ts`)),
      burst("src/handlers/odd.test.ts"), // test file, skipped by isAnalyzableSource
      ...Array.from({ length: 8 }, (_, i) => cultivated(`src/services/b${i}.ts`)),
    ];
    const findings = commitArchaeology.detect(ctx(files));
    // The test file is ignored; remaining handlers dir has 4 cultivated
    // files and no bursty — no finding.
    expect(findings).toHaveLength(0);
  });

  it("evidence lines describe the burst reasons", () => {
    const files = [
      ...Array.from({ length: 4 }, (_, i) => cultivated(`src/handlers/a${i}.ts`)),
      burst("src/handlers/odd.ts"),
      ...Array.from({ length: 8 }, (_, i) => cultivated(`src/services/b${i}.ts`)),
    ];
    const findings = commitArchaeology.detect(ctx(files));
    expect(findings).toHaveLength(1);
    const ev = findings[0].deviatingFiles[0].evidence[0].code;
    expect(ev).toContain("6-hour window");
    expect(ev).toContain("single-author");
  });
});
