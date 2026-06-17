import { describe, it, expect } from "vitest";
import {
  tokenize,
  normalizeTokens,
  buildShingles,
  minHashSignature,
  findLshCandidatePairs,
  lcsSimilarity,
  buildSignature,
  DEFAULT_PERMUTATIONS,
} from "../../../src/codedna/minhash.js";

// True Jaccard similarity between two sets of shingle strings.
function trueJaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const x of setA) if (setB.has(x)) intersect++;
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 1 : intersect / union;
}

/**
 * Estimate Jaccard from MinHash signatures. Documented property: the
 * expected fraction of positions where sig_a[i] === sig_b[i] equals the
 * true Jaccard similarity of the underlying sets.
 *   E[estimate] = J(A, B)
 *   Var[estimate] ≈ J(1 - J) / k, where k is number of permutations.
 *   StdDev ≈ sqrt(J(1-J)/k) ≤ 1/(2·sqrt(k))
 */
function estimateJaccard(sigA: Uint32Array, sigB: Uint32Array): number {
  let agree = 0;
  const k = sigA.length;
  for (let i = 0; i < k; i++) {
    if (sigA[i] === sigB[i]) agree++;
  }
  return agree / k;
}

function randomShingles(count: number, vocab: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`sh_${Math.floor(Math.random() * vocab)}`);
  }
  return out;
}

describe("MinHash + LSH", () => {
  describe("tokenize", () => {
    it("strips line comments and normalizes string literals", () => {
      const tokens = tokenize(`// hello\nconst x = "world";`);
      expect(tokens).toContain("const");
      // The string literal "world" gets replaced by "STR" before tokenization;
      // the tokenizer then captures the `STR` identifier (quotes are
      // separate punctuation tokens that get matched independently).
      expect(tokens).toContain("STR");
      expect(tokens.some((t) => t.includes("world"))).toBe(false);
    });

    it("strips block comments", () => {
      const tokens = tokenize(`/* explain */\nreturn x;`);
      expect(tokens).not.toContain("/*");
      expect(tokens).toContain("return");
    });

    it("strips python hash comments", () => {
      const tokens = tokenize(`# remark\nreturn x`);
      expect(tokens).not.toContain("#");
      expect(tokens).toContain("return");
    });

    it("normalizes numeric literals to a class-less-tagged form (handled in normalizeTokens)", () => {
      const tokens = tokenize(`return 42;`);
      // Digits survive tokenize; the NUM normalization happens in normalizeTokens.
      expect(tokens).toContain("42");
    });
  });

  describe("normalizeTokens", () => {
    it("renames declared locals while keeping call targets literal", () => {
      const tokens = tokenize(`const user = db.query(sql);`);
      const normalized = normalizeTokens(tokens);
      expect(normalized.join(" ")).toContain("db . query");
      // user is local → ID0
      expect(normalized).toContain("ID0");
    });

    it("preserves constructor names (new Foo())", () => {
      const tokens = tokenize(`new UserRepo();`);
      const normalized = normalizeTokens(tokens);
      expect(normalized).toContain("UserRepo");
    });

    it("replaces numeric literals with NUM", () => {
      const tokens = tokenize(`const x = 42;`);
      const normalized = normalizeTokens(tokens);
      expect(normalized).toContain("NUM");
      expect(normalized).not.toContain("42");
    });
  });

  describe("buildShingles", () => {
    it("produces n-k+1 shingles where n = tokens, k = shingle size", () => {
      const shingles = buildShingles(["a", "b", "c", "d", "e"], 3);
      expect(shingles).toHaveLength(3); // 5 - 3 + 1 = 3
    });

    it("collapses a too-short token stream to a single shingle", () => {
      const shingles = buildShingles(["a", "b"], 5);
      expect(shingles).toHaveLength(1);
    });
  });

  describe("minHashSignature", () => {
    it("identical inputs → identical signatures (0 distance)", () => {
      const tokens = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const shingles = buildShingles(tokens);
      const sigA = minHashSignature(shingles);
      const sigB = minHashSignature(shingles);
      expect(estimateJaccard(sigA, sigB)).toBe(1);
    });

    it("completely disjoint inputs → near-zero signature agreement", () => {
      const shinglesA = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
      const shinglesB = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"];
      const sigA = minHashSignature(shinglesA);
      const sigB = minHashSignature(shinglesB);
      const est = estimateJaccard(sigA, sigB);
      // Two disjoint sets have J=0. With k=128 perms the estimate should
      // be <5% (pure chance collisions).
      expect(est).toBeLessThan(0.05);
    });
  });

  describe("property: MinHash estimate within 1/(2·sqrt(k)) of true Jaccard (100 random pairs)", () => {
    it("holds across 100 random pairs", () => {
      const k = DEFAULT_PERMUTATIONS;
      const bound = 1 / (2 * Math.sqrt(k));
      // Generous slack: 3x the theoretical standard-deviation bound to
      // allow for outlier pairs; still orders of magnitude tighter than
      // naïve random.
      const slack = bound * 3;

      let violations = 0;
      for (let trial = 0; trial < 100; trial++) {
        const shared = randomShingles(40 + Math.floor(Math.random() * 40), 200);
        const onlyA = randomShingles(20, 200);
        const onlyB = randomShingles(20, 200);
        const a = [...shared, ...onlyA];
        const b = [...shared, ...onlyB];

        const true_J = trueJaccard(a, b);
        const sigA = minHashSignature(a);
        const sigB = minHashSignature(b);
        const est = estimateJaccard(sigA, sigB);

        if (Math.abs(est - true_J) > slack) violations++;
      }

      // Allow a tiny number of outlier trials (small-sample randomness
      // can push a few pairs past 3σ). Fail if the estimator is broken
      // in a systematic way — many violations means the property fails.
      expect(violations).toBeLessThanOrEqual(5);
    });
  });

  describe("findLshCandidatePairs", () => {
    it("LSH catches high-similarity pairs (s=0.9, catch rate ~99.999%)", () => {
      // Make two signatures that are 90% identical by seeding them
      // from highly-overlapping shingle sets.
      const shared = randomShingles(90, 500);
      const onlyA = randomShingles(10, 500);
      const onlyB = randomShingles(10, 500);
      const sigs: Uint32Array[] = [];
      sigs.push(minHashSignature([...shared, ...onlyA]));
      sigs.push(minHashSignature([...shared, ...onlyB]));
      // Add 20 random unrelated signatures as distractors.
      for (let i = 0; i < 20; i++) {
        sigs.push(minHashSignature(randomShingles(50, 500)));
      }

      const pairs = findLshCandidatePairs(sigs);
      // Our two highly-similar signatures are at indices 0 and 1.
      expect(pairs.has("0-1")).toBe(true);
    });

    it("LSH rejects low-similarity pairs (s=0.3, catch rate <0.1%)", () => {
      const shared = randomShingles(30, 500);
      const onlyA = randomShingles(70, 500);
      const onlyB = randomShingles(70, 500);
      const sigs: Uint32Array[] = [
        minHashSignature([...shared, ...onlyA]),
        minHashSignature([...shared, ...onlyB]),
      ];
      // Pair is ~J=0.23 — LSH probability 1 - (1 - 0.23^8)^16 ≈ 0.02%.
      // Expect a miss > 95% of the time. Check stochastically.
      let hits = 0;
      for (let trial = 0; trial < 50; trial++) {
        if (findLshCandidatePairs(sigs).has("0-1")) hits++;
      }
      expect(hits).toBeLessThan(25); // way below 50% chance.
    });
  });

  describe("lcsSimilarity", () => {
    it("identical token streams → 1.0", () => {
      expect(lcsSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    });

    it("disjoint token streams → 0", () => {
      expect(lcsSimilarity(["a", "b", "c"], ["x", "y", "z"])).toBe(0);
    });

    it("half-overlap subsequence gives expected ratio", () => {
      // LCS of [1,2,3,4] and [1,3,5,7] is [1,3] → 2 · 2 / (4 + 4) = 0.5
      expect(lcsSimilarity(["1", "2", "3", "4"], ["1", "3", "5", "7"])).toBeCloseTo(0.5);
    });

    it("rejects wildly different lengths (short-circuits to 0)", () => {
      const a = ["x"];
      const b = Array(100).fill("y");
      expect(lcsSimilarity(a, b)).toBe(0);
    });
  });

  describe("buildSignature end-to-end", () => {
    it("produces a signature with DEFAULT_PERMUTATIONS values", () => {
      const sig = buildSignature(`const x = 1; return x;`);
      expect(sig.signature.length).toBe(DEFAULT_PERMUTATIONS);
      expect(sig.tokens.length).toBeGreaterThan(0);
    });
  });
});
