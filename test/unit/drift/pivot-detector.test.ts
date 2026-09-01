import { describe, it, expect } from "vitest";
import { detectPivot } from "../../../src/drift/pivot-detector.js";
import type { DriftContext, DriftFile, DriftFinding } from "../../../src/drift/types.js";

function makeFile(path: string, daysAgo: number | null): DriftFile {
  return {
    relativePath: path,
    language: "typescript",
    content: "",
    lineCount: 1,
    git: daysAgo == null ? null : {
      lastModifiedDaysAgo: daysAgo,
      uniqueAuthors: 1,
      commitCount90d: daysAgo <= 90 ? 1 : 0,
      commitCountTotal: 1,
    },
  };
}

function makeCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.length,
    dominantLanguage: "typescript",
    hasGitMetadata: true,
  };
}

function makeFinding(overrides: Partial<DriftFinding> = {}): DriftFinding {
  return {
    detector: "test",
    driftCategory: "architectural_consistency",
    severity: "warning",
    confidence: 0.8,
    finding: "test drift",
    dominantPattern: "repository",
    dominantCount: 3,
    totalRelevantFiles: 13,
    consistencyScore: 70,
    deviatingFiles: [],
    dominantFiles: [],
    recommendation: "fix it",
    ...overrides,
  };
}

describe("detectPivot", () => {
  it("returns finding unchanged when git metadata is absent", () => {
    const ctx: DriftContext = {
      files: [makeFile("handlers/a.ts", null)],
      totalLines: 1,
      dominantLanguage: "typescript",
      hasGitMetadata: false,
    };
    const finding = makeFinding({
      deviatingFiles: [{ path: "handlers/a.ts", detectedPattern: "raw_sql", evidence: [] }],
    });
    const result = detectPivot(ctx, finding);
    expect(result).toBe(finding); // reference-equal
    expect(result.pivot).toBeUndefined();
  });

  it("reclassifies legacy-aligned files as `legacy` and true drift as `drift`", () => {
    // Scenario: directory has 5 old raw_sql + 5 new repository + 1 odd file
    // using graphql. The finding already says repository is dominant
    // (because of temporal weighting). Pivot detection should:
    //   - Legacy dominant = raw_sql → 5 old raw_sql files become `legacy`
    //   - Recent dominant = repository → already dominant (aligned, no action)
    //   - 1 graphql file (recent or legacy) = `drift` (true outlier)
    const files: DriftFile[] = [
      // 5 legacy raw_sql handlers
      makeFile("handlers/old1.ts", 400),
      makeFile("handlers/old2.ts", 380),
      makeFile("handlers/old3.ts", 360),
      makeFile("handlers/old4.ts", 340),
      makeFile("handlers/old5.ts", 320),
      // 5 recent repository handlers
      makeFile("handlers/new1.ts", 10),
      makeFile("handlers/new2.ts", 15),
      makeFile("handlers/new3.ts", 20),
      makeFile("handlers/new4.ts", 25),
      makeFile("handlers/new5.ts", 30),
      // 1 recent but genuinely odd (graphql)
      makeFile("handlers/odd.ts", 5),
    ];
    const ctx = makeCtx(files);

    const finding = makeFinding({
      dominantPattern: "repository",
      dominantFiles: ["handlers/new1.ts", "handlers/new2.ts", "handlers/new3.ts", "handlers/new4.ts", "handlers/new5.ts"],
      deviatingFiles: [
        { path: "handlers/old1.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/old2.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/old3.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/old4.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/old5.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/odd.ts", detectedPattern: "graphql", evidence: [] },
      ],
    });

    const result = detectPivot(ctx, finding);

    expect(result.pivot).toBeDefined();
    expect(result.pivot!.fromPattern).toBe("raw_sql");
    expect(result.pivot!.toPattern).toBe("repository");
    expect(result.pivot!.recentFileCount).toBe(6); // 5 new + 1 odd
    expect(result.pivot!.legacyFileCount).toBe(5);

    // The 5 raw_sql deviators should be classified as `legacy`
    expect(result.legacyFiles).toHaveLength(5);
    expect(result.legacyFiles!.every((f) => f.classification === "legacy")).toBe(true);

    // The 1 graphql deviator should remain as `drift`
    expect(result.deviatingFiles).toHaveLength(1);
    expect(result.deviatingFiles[0].path).toBe("handlers/odd.ts");
    expect(result.deviatingFiles[0].classification).toBe("drift");
  });

  it("does NOT emit a pivot when recent and legacy majority match", () => {
    // Scenario: both old AND new files use raw_sql. One outlier uses repository.
    // No pivot — just a regular drift finding.
    const files: DriftFile[] = [
      makeFile("handlers/old1.ts", 300),
      makeFile("handlers/old2.ts", 200),
      makeFile("handlers/old3.ts", 150),
      makeFile("handlers/new1.ts", 30),
      makeFile("handlers/new2.ts", 20),
      makeFile("handlers/new3.ts", 10),
      makeFile("handlers/repo.ts", 5),
    ];
    const ctx = makeCtx(files);
    const finding = makeFinding({
      dominantPattern: "raw_sql",
      dominantFiles: ["handlers/old1.ts", "handlers/new1.ts"],
      deviatingFiles: [
        { path: "handlers/repo.ts", detectedPattern: "repository", evidence: [] },
      ],
    });
    const result = detectPivot(ctx, finding);
    expect(result.pivot).toBeUndefined();
    expect(result.deviatingFiles).toHaveLength(1);
    // classification may or may not be set; importantly, nothing becomes legacy
    expect(result.legacyFiles).toBeUndefined();
  });

  it("does NOT emit a pivot when one population is too small", () => {
    // Only 2 legacy files — below MIN_POPULATION (3). Skip pivot.
    const files: DriftFile[] = [
      makeFile("handlers/old1.ts", 300),
      makeFile("handlers/old2.ts", 200),
      makeFile("handlers/new1.ts", 10),
      makeFile("handlers/new2.ts", 20),
      makeFile("handlers/new3.ts", 30),
      makeFile("handlers/new4.ts", 40),
    ];
    const ctx = makeCtx(files);
    const finding = makeFinding({
      dominantPattern: "repository",
      dominantFiles: ["handlers/new1.ts", "handlers/new2.ts", "handlers/new3.ts", "handlers/new4.ts"],
      deviatingFiles: [
        { path: "handlers/old1.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/old2.ts", detectedPattern: "raw_sql", evidence: [] },
      ],
    });
    const result = detectPivot(ctx, finding);
    expect(result.pivot).toBeUndefined();
    expect(result.legacyFiles).toBeUndefined();
  });

  it("does NOT emit a pivot when recent population is mixed (below consistency threshold)", () => {
    // Recent files are split 2-2-2 across three patterns — no clear
    // new direction. Shouldn't flag a pivot.
    const files: DriftFile[] = [
      // 3 legacy raw_sql
      makeFile("handlers/old1.ts", 300),
      makeFile("handlers/old2.ts", 200),
      makeFile("handlers/old3.ts", 150),
      // Recent is messy: 2 repo, 2 orm, 2 graphql
      makeFile("handlers/a.ts", 10),
      makeFile("handlers/b.ts", 15),
      makeFile("handlers/c.ts", 20),
      makeFile("handlers/d.ts", 25),
      makeFile("handlers/e.ts", 30),
      makeFile("handlers/f.ts", 35),
    ];
    const ctx = makeCtx(files);
    const finding = makeFinding({
      dominantPattern: "repository",
      dominantFiles: ["handlers/a.ts", "handlers/b.ts"],
      deviatingFiles: [
        { path: "handlers/old1.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/old2.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/old3.ts", detectedPattern: "raw_sql", evidence: [] },
        { path: "handlers/c.ts", detectedPattern: "orm", evidence: [] },
        { path: "handlers/d.ts", detectedPattern: "orm", evidence: [] },
        { path: "handlers/e.ts", detectedPattern: "graphql", evidence: [] },
        { path: "handlers/f.ts", detectedPattern: "graphql", evidence: [] },
      ],
    });
    const result = detectPivot(ctx, finding);
    expect(result.pivot).toBeUndefined();
  });
});

describe("detectPivot: the dominant population is not a 3-file sample", () => {
  // A directory of 9 stable `repository` files and 3 `raw_sql` deviators. Nine
  // is more than pickDominantFiles' cap of 3, so a finding carries only the
  // three ALPHABETICALLY FIRST dominant paths. Here those three happen to be
  // the recently-touched ones, so treating them as the dominant population
  // reads "recent = all repository, legacy = all raw_sql" and declares a pivot
  // the repo never made.
  const dominantPaths = Array.from({ length: 9 }, (_, i) => `handlers/dom${i}.ts`);
  const deviatingPaths = ["handlers/zz1.ts", "handlers/zz2.ts", "handlers/zz3.ts"];

  const files: DriftFile[] = [
    // dom0..dom2 sort first AND are recent; dom3..dom8 are old.
    ...dominantPaths.map((p, i) => makeFile(p, i < 3 ? 10 : 400)),
    // The deviators are all old, so the alphabetical sample skews the split.
    ...deviatingPaths.map((p) => makeFile(p, 500)),
  ];
  const ctx = makeCtx(files);

  const base = {
    dominantPattern: "repository",
    dominantCount: 9,
    totalRelevantFiles: 12,
    dominantFiles: dominantPaths.slice(0, 3),
    deviatingFiles: deviatingPaths.map((path) => ({ path, detectedPattern: "raw_sql", evidence: [] })),
  };

  it("does not flip to a pivot when the full dominant population is carried", () => {
    const result = detectPivot(ctx, makeFinding({ ...base, allDominantFiles: dominantPaths }));
    // Recent = the 3 recent repository files. Legacy = 6 repository + 3 raw_sql,
    // so the legacy dominant is ALSO repository — same pattern in both windows,
    // which is drift, not a pivot.
    expect(result.pivot).toBeUndefined();
    expect(result.legacyFiles).toBeUndefined();
  });

  it("declines to judge when only the 3-file dominant sample is available", () => {
    // Without allDominantFiles we can see 3 of 9 dominant files: 6 of the
    // directory's 12, under the coverage floor. Declining beats guessing.
    const result = detectPivot(ctx, makeFinding(base));
    expect(result.pivot).toBeUndefined();
  });
});
