import { describe, it, expect } from "vitest";
import {
  tokenize,
  lcsSimilarity,
  minHashSignature,
  findLshCandidatePairs,
  buildShingles,
  DEFAULT_PERMUTATIONS,
} from "../../../src/codedna/minhash.js";

describe("lcsSimilarity length-ratio gate", () => {
  // The gate used to be `min/max < 0.5 -> return 0`, justified as "impossible
  // for LCS similarity to exceed 0.5 when that's the case". The real ceiling at
  // a length ratio r is a full containment, 2r/(1+r) — 0.667 at r = 0.5, not
  // 0.5. Every pair between r = 1/3 and r = 0.5 was hard-zeroed despite a true
  // similarity of up to 0.645, above the 0.60 discovery threshold used by
  // find-similar-function and the deep-scan sampler's 0.55 band floor.
  const shorter = Array.from({ length: 100 }, (_, i) => `t${i}`);
  const longer = [...shorter, ...Array.from({ length: 110 }, (_, i) => `f${i}`)];

  it("scores a 100-token body fully contained in a 210-token one at ~0.645, not 0", () => {
    expect(shorter.length / longer.length).toBeLessThan(0.5); // the old gate's reject zone
    expect(lcsSimilarity(shorter, longer)).toBeCloseTo(0.645, 3);
  });

  it("still skips the DP when the caller's own threshold is genuinely unreachable", () => {
    // 2r/(1+r) = 0.645 < 0.70, so no amount of overlap can reach it.
    expect(lcsSimilarity(shorter, longer, 0.7)).toBe(0);
    // ...and 0.645 >= 0.60, so the discovery threshold must still see it.
    expect(lcsSimilarity(shorter, longer, 0.6)).toBeCloseTo(0.645, 3);
  });

  it("is unchanged for equal-length streams", () => {
    const a = ["a", "b", "c", "d"];
    expect(lcsSimilarity(a, a)).toBe(1);
    expect(lcsSimilarity(a, ["a", "b", "x", "y"])).toBeCloseTo(0.5, 6);
  });
});

describe("permutation seeds", () => {
  it("does not repeat a hash row when more than DEFAULT_PERMUTATIONS are requested", () => {
    // The seed table was fixed at 128 entries and indexed `p % 128`, so row 128
    // was byte-identical to row 0: perfectly correlated rows that the LSH band
    // math counts as independent evidence.
    const shingles = buildShingles(
      Array.from({ length: 40 }, (_, i) => `tok${i}`),
    );
    const sig = minHashSignature(shingles, DEFAULT_PERMUTATIONS + 32);
    expect(sig.length).toBe(DEFAULT_PERMUTATIONS + 32);
    expect(sig[DEFAULT_PERMUTATIONS]).not.toBe(sig[0]);
    expect(sig[DEFAULT_PERMUTATIONS + 1]).not.toBe(sig[1]);
  });

  it("still produces the default-size signature deterministically", () => {
    const shingles = buildShingles(["a", "b", "c", "d", "e", "f", "g"]);
    expect(Array.from(minHashSignature(shingles))).toEqual(
      Array.from(minHashSignature(shingles)),
    );
  });
});

describe("findLshCandidatePairs guards", () => {
  const sigOf = (seed: string) =>
    minHashSignature(buildShingles(Array.from({ length: 20 }, (_, i) => `${seed}${i}`)));

  it("throws when bands x rows reads past the end of the signature", () => {
    const sigs = [sigOf("a"), sigOf("b")];
    expect(() => findLshCandidatePairs(sigs, 32, 8)).toThrow(/reads past the signature/);
  });

  it("emits O(m) star+chain pairs for a degenerate bucket instead of m(m-1)/2 or nothing", () => {
    // One identical signature repeated: every band puts all members in the
    // SAME oversized bucket, so skipping oversized buckets dropped the whole
    // cluster (no other band could recover it). Exhaustive pairing is m(m-1)/2
    // — 31,125 strings at 250 members. Star+chain keeps every member reachable
    // at ~2·m pairs.
    const identical = sigOf("same");
    const small = Array.from({ length: 10 }, () => identical);
    expect(findLshCandidatePairs(small).size).toBe((10 * 9) / 2);

    const m = 250;
    const huge = Array.from({ length: m }, () => identical);
    const pairs = findLshCandidatePairs(huge);
    expect(pairs.size).toBeGreaterThan(0);
    expect(pairs.size).toBeLessThanOrEqual(2 * m);

    const covered = new Set<number>();
    for (const key of pairs) {
      const [a, b] = key.split("-").map(Number);
      covered.add(a);
      covered.add(b);
    }
    expect(covered.size).toBe(m);
  });
});

describe("tokenize strips strings and comments in one pass", () => {
  it("a URL inside a string literal does not swallow the file", () => {
    // Stripping `//` first truncated the line inside the literal, leaving one
    // unbalanced quote that paired with the next quote further down and
    // collapsed everything between them into a single "STR".
    const tokens = tokenize(
      ['const url = "https://api.example.com/v1";', "const limit = 42;", 'log("done");'].join("\n"),
    );
    expect(tokens).toContain("limit");
    expect(tokens).toContain("42");
    expect(tokens).toContain("log");
  });

  it("still strips a real line comment", () => {
    const tokens = tokenize(["const a = 1; // secretIdentifier", "const b = 2;"].join("\n"));
    expect(tokens).not.toContain("secretIdentifier");
    expect(tokens).toContain("b");
  });

  it("still strips block comments", () => {
    const tokens = tokenize("const a = 1; /* blockOnly */ const b = 2;");
    expect(tokens).not.toContain("blockOnly");
    expect(tokens).toContain("b");
  });
});
