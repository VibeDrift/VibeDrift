import { describe, it, expect } from "vitest";
import {
  buildDirectoryScopedVote,
  directoryOf,
  buildPatternDistribution,
  findDominantPattern,
  temporalWeight,
} from "../../../src/drift/utils.js";

describe("directoryOf", () => {
  it("extracts the directory from a nested path", () => {
    expect(directoryOf("src/handlers/user.ts")).toBe("src/handlers");
    expect(directoryOf("a/b/c/d.ts")).toBe("a/b/c");
  });
  it("returns '.' for a root-level file", () => {
    expect(directoryOf("main.ts")).toBe(".");
    expect(directoryOf("")).toBe(".");
  });
});

describe("buildDirectoryScopedVote", () => {
  const NAMES = { A: "pattern A", B: "pattern B", C: "pattern C" } as const;

  function profile(file: string, pattern: "A" | "B" | "C") {
    return { file, patterns: [{ pattern, evidence: [] }] };
  }

  it("flags the deviator in a directory with 4 of one pattern and 1 of another", () => {
    const votes = buildDirectoryScopedVote(
      [
        profile("handlers/a.ts", "A"),
        profile("handlers/b.ts", "A"),
        profile("handlers/c.ts", "A"),
        profile("handlers/d.ts", "A"),
        profile("handlers/e.ts", "B"), // deviator
      ],
      NAMES,
    );
    expect(votes).toHaveLength(1);
    expect(votes[0].directory).toBe("handlers");
    expect(votes[0].dominant).toBe("A");
    expect(votes[0].dominantCount).toBe(4);
    expect(votes[0].deviators).toHaveLength(1);
    expect(votes[0].deviators[0].path).toBe("handlers/e.ts");
  });

  it("does NOT flag when two directories disagree but each is internally consistent (the core S1 invariant)", () => {
    const votes = buildDirectoryScopedVote(
      [
        // handlers/: all A
        profile("handlers/a.ts", "A"),
        profile("handlers/b.ts", "A"),
        profile("handlers/c.ts", "A"),
        // utils/: all B
        profile("utils/x.ts", "B"),
        profile("utils/y.ts", "B"),
        profile("utils/z.ts", "B"),
      ],
      NAMES,
    );
    expect(votes).toHaveLength(0);
  });

  it("skips directories smaller than minGroupSize", () => {
    const votes = buildDirectoryScopedVote(
      [
        profile("tiny/a.ts", "A"),
        profile("tiny/b.ts", "B"), // would be drift, but group too small
        profile("big/c.ts", "A"),
        profile("big/d.ts", "A"),
        profile("big/e.ts", "A"),
        profile("big/f.ts", "B"), // this one is the drift
      ],
      NAMES,
    );
    expect(votes).toHaveLength(1);
    expect(votes[0].directory).toBe("big");
  });

  it("respects the dominanceThreshold — a 60/40 split below 0.7 isn't flagged", () => {
    const votes = buildDirectoryScopedVote(
      [
        profile("mixed/a.ts", "A"),
        profile("mixed/b.ts", "A"),
        profile("mixed/c.ts", "A"),
        profile("mixed/d.ts", "B"),
        profile("mixed/e.ts", "B"),
      ],
      NAMES,
    );
    // 3/5 = 0.6 < 0.7 default threshold → skipped
    expect(votes).toHaveLength(0);
  });

  it("still votes when the threshold is lowered explicitly", () => {
    const votes = buildDirectoryScopedVote(
      [
        profile("mixed/a.ts", "A"),
        profile("mixed/b.ts", "A"),
        profile("mixed/c.ts", "A"),
        profile("mixed/d.ts", "B"),
        profile("mixed/e.ts", "B"),
      ],
      NAMES,
      { dominanceThreshold: 0.55 },
    );
    expect(votes).toHaveLength(1);
  });

  it("returns empty for unanimous directories", () => {
    const votes = buildDirectoryScopedVote(
      [
        profile("quiet/a.ts", "A"),
        profile("quiet/b.ts", "A"),
        profile("quiet/c.ts", "A"),
        profile("quiet/d.ts", "A"),
      ],
      NAMES,
    );
    expect(votes).toHaveLength(0);
  });

  it("orders directories deterministically (alphabetical) for stable output", () => {
    const votes = buildDirectoryScopedVote(
      [
        profile("z/a.ts", "A"),
        profile("z/b.ts", "A"),
        profile("z/c.ts", "A"),
        profile("z/d.ts", "B"),
        profile("a/e.ts", "A"),
        profile("a/f.ts", "A"),
        profile("a/g.ts", "A"),
        profile("a/h.ts", "B"),
      ],
      NAMES,
    );
    expect(votes.map((v) => v.directory)).toEqual(["a", "z"]);
  });
});

describe("temporalWeight", () => {
  it("returns 1.0 when daysAgo is null or undefined", () => {
    expect(temporalWeight(null)).toBe(1.0);
    expect(temporalWeight(undefined)).toBe(1.0);
  });

  it("returns 2.0 for a file touched just now", () => {
    expect(temporalWeight(0)).toBeCloseTo(2.0, 3);
  });

  it("returns 1.0 at the 90-day half-life mark", () => {
    expect(temporalWeight(90)).toBeCloseTo(1.0, 3);
  });

  it("returns 0.5 at the 180-day mark", () => {
    expect(temporalWeight(180)).toBeCloseTo(0.5, 3);
  });

  it("clamps negative ages to 0 (future-dated clocks)", () => {
    expect(temporalWeight(-10)).toBeCloseTo(2.0, 3);
  });

  it("decays monotonically with age", () => {
    const w0 = temporalWeight(0);
    const w30 = temporalWeight(30);
    const w90 = temporalWeight(90);
    const w365 = temporalWeight(365);
    expect(w0).toBeGreaterThan(w30);
    expect(w30).toBeGreaterThan(w90);
    expect(w90).toBeGreaterThan(w365);
  });
});

describe("buildDirectoryScopedVote with temporal weighting", () => {
  const NAMES = { A: "pattern A", B: "pattern B" } as const;

  function profile(file: string, pattern: "A" | "B") {
    return { file, patterns: [{ pattern, evidence: [] }] };
  }

  it("flat vote matches pre-temporal behavior when fileAges is omitted", () => {
    const votes = buildDirectoryScopedVote(
      [
        profile("h/a.ts", "A"),
        profile("h/b.ts", "A"),
        profile("h/c.ts", "A"),
        profile("h/d.ts", "B"),
      ],
      NAMES,
    );
    expect(votes).toHaveLength(1);
    expect(votes[0].dominant).toBe("A");
    expect(votes[0].temporallyWeighted).toBeFalsy();
  });

  it("lets 3 new files outvote 10 old ones (the legacy-skew fix)", () => {
    // 10 ancient "A" files (>1 year) + 3 fresh "B" files (~5 days).
    // Raw count: A=10, B=3 → A dominant without temporal weighting.
    // Weighted:  A=10×~0.09=0.92, B=3×~1.92=5.76 → B wins ~86% share.
    const profiles = [
      ...Array.from({ length: 10 }, (_, i) => profile(`h/old${i}.ts`, "A")),
      profile("h/new1.ts", "B"),
      profile("h/new2.ts", "B"),
      profile("h/new3.ts", "B"),
    ];
    const fileAges = new Map<string, number>();
    for (let i = 0; i < 10; i++) fileAges.set(`h/old${i}.ts`, 400);
    fileAges.set("h/new1.ts", 5);
    fileAges.set("h/new2.ts", 5);
    fileAges.set("h/new3.ts", 5);

    const votes = buildDirectoryScopedVote(profiles, NAMES, { fileAges });
    expect(votes).toHaveLength(1);
    expect(votes[0].dominant).toBe("B"); // NEW pattern wins
    expect(votes[0].temporallyWeighted).toBe(true);
    expect(votes[0].consistencyScore).toBeGreaterThanOrEqual(70);
    // Deviators are now the 10 old files
    expect(votes[0].deviators).toHaveLength(10);
  });

  it("produces the same dominant as flat voting when all files have the same age", () => {
    const profiles = [
      profile("h/a.ts", "A"),
      profile("h/b.ts", "A"),
      profile("h/c.ts", "A"),
      profile("h/d.ts", "B"),
    ];
    const fileAges = new Map<string, number>([
      ["h/a.ts", 60],
      ["h/b.ts", 60],
      ["h/c.ts", 60],
      ["h/d.ts", 60],
    ]);
    const votes = buildDirectoryScopedVote(profiles, NAMES, { fileAges });
    expect(votes).toHaveLength(1);
    expect(votes[0].dominant).toBe("A");
    expect(votes[0].temporallyWeighted).toBe(true);
  });

  it("treats files missing from fileAges as neutral (weight=1.0)", () => {
    const profiles = [
      profile("h/a.ts", "A"),
      profile("h/b.ts", "A"),
      profile("h/c.ts", "A"),
      profile("h/d.ts", "B"),
    ];
    // Only one file has age data
    const fileAges = new Map<string, number>([["h/d.ts", 200]]);
    const votes = buildDirectoryScopedVote(profiles, NAMES, { fileAges });
    // A still dominant (3×1.0 = 3 vs B with weight 0.25)
    expect(votes[0].dominant).toBe("A");
  });

  it("respects dominance threshold against weighted share, not raw count", () => {
    // 4 A (neutral, age 60d) + 3 B (fresh, age 0d) = raw 4-vs-3 (A wins raw)
    // Weighted: A = 4 × ~1.26 = 5.04; B = 3 × 2.0 = 6.0 (B wins)
    const profiles = [
      profile("h/a.ts", "A"),
      profile("h/b.ts", "A"),
      profile("h/c.ts", "A"),
      profile("h/d.ts", "A"),
      profile("h/e.ts", "B"),
      profile("h/f.ts", "B"),
      profile("h/g.ts", "B"),
    ];
    const fileAges = new Map<string, number>();
    for (const f of ["h/a.ts", "h/b.ts", "h/c.ts", "h/d.ts"]) fileAges.set(f, 60);
    for (const f of ["h/e.ts", "h/f.ts", "h/g.ts"]) fileAges.set(f, 0);

    // threshold 0.7 — neither side has 70% weighted share, so no vote emitted
    const votes = buildDirectoryScopedVote(profiles, NAMES, { fileAges, dominanceThreshold: 0.7 });
    expect(votes).toHaveLength(0);

    // threshold 0.5 — B wins weighted (6 / 11.04 ≈ 54%)
    const votesRelaxed = buildDirectoryScopedVote(profiles, NAMES, { fileAges, dominanceThreshold: 0.5 });
    expect(votesRelaxed).toHaveLength(1);
    expect(votesRelaxed[0].dominant).toBe("B");
  });
});

describe("project-scoped helpers remain available", () => {
  // Sanity check: the original helpers still work for detectors that want
  // project-wide voting (error-shape, etc.).
  it("buildPatternDistribution + findDominantPattern produce a single vote", () => {
    const profiles = [
      { file: "a.ts", patterns: [{ pattern: "X" as const, evidence: [] }] },
      { file: "b.ts", patterns: [{ pattern: "X" as const, evidence: [] }] },
      { file: "c.ts", patterns: [{ pattern: "Y" as const, evidence: [] }] },
    ];
    const dist = buildPatternDistribution(profiles);
    const dom = findDominantPattern(dist);
    expect(dom?.dominant).toBe("X");
    expect(dom?.dominantCount).toBe(2);
  });
});
