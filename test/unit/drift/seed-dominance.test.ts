import { describe, it, expect } from "vitest";
import { seedDominanceVote } from "../../../src/drift/utils.js";
import type { IntentHint } from "../../../src/intent/types.js";

function distFrom(
  entries: Array<[string, number]>,
): Map<string, { count: number; files: string[]; weight?: number }> {
  const m = new Map<string, { count: number; files: string[]; weight?: number }>();
  for (const [pattern, count] of entries) {
    // Give each count a synthetic file name — findDominantPattern
    // doesn't care about file identity, only the count / weight fields.
    m.set(pattern, { count, files: Array.from({ length: count }, (_, i) => `${pattern}-${i}.ts`) });
  }
  return m;
}

function hint(pattern: string, confidence = 0.9): IntentHint {
  return {
    category: "architectural_consistency",
    pattern,
    label: pattern,
    source: "CLAUDE.md",
    line: 1,
    text: `use ${pattern}`,
    confidence,
  };
}

describe("seedDominanceVote", () => {
  it("is a pure passthrough when hint is null", () => {
    const d = distFrom([["A", 5], ["B", 3]]);
    const r = seedDominanceVote(d, null);
    expect(r.declaredPattern).toBeNull();
    expect(r.declaredMatched).toBeNull();
    expect(r.dominant).toBe("A");
    expect(r.dominantCount).toBe(5);
    expect(r.hint).toBeNull();
    // No weights should be injected
    expect(d.get("A")!.weight).toBeUndefined();
    expect(d.get("B")!.weight).toBeUndefined();
  });

  it("declared pattern that already dominates simply boosts its weight", () => {
    const d = distFrom([["A", 5], ["B", 3]]);
    const r = seedDominanceVote(d, hint("A", 0.9));
    expect(r.dominant).toBe("A");
    expect(r.dominantCount).toBe(5);
    expect(r.declaredMatched).toBe(true);
    // Weights initialized from counts, A × 1.5 boost = 7.5
    expect(d.get("A")!.weight).toBeCloseTo(7.5);
    expect(d.get("B")!.weight).toBe(3);
  });

  it("declared pattern absent from distribution gets injected with weight = 1 + confidence", () => {
    const d = distFrom([["A", 5], ["B", 3]]);
    const r = seedDominanceVote(d, hint("C", 0.9));
    // Injected virtual entry with count 0 but weight 1.9
    expect(d.get("C")).toEqual({ count: 0, files: [], weight: 1.9 });
    // A still wins: its count 5 > C's weight 1.9
    expect(r.dominant).toBe("A");
    expect(r.declaredMatched).toBe(false);
  });

  it("hint flips the SEEDED dominant when boost exceeds the gap (but still reports divergence)", () => {
    // 5 files for A, 4 for B. Gap is 1. Hint B with 1.5× boost → B weight 6, A weight 5.
    // The seeded/display dominant flips to B, but the code dominant is A, so this
    // is divergence — not agreement (laundering fix).
    const d = distFrom([["A", 5], ["B", 4]]);
    const r = seedDominanceVote(d, hint("B", 0.9));
    expect(r.dominant).toBe("B");
    expect(r.codeDominant).toBe("A");
    expect(r.flipped).toBe(true);
    expect(r.declaredMatched).toBe(false);
  });

  it("hint does NOT flip a lopsided vote when boost is insufficient", () => {
    // 10 for A, 2 for B. Boost B → weight 3. A still dominant at weight 10.
    const d = distFrom([["A", 10], ["B", 2]]);
    const r = seedDominanceVote(d, hint("B", 0.9));
    expect(r.dominant).toBe("A");
    expect(r.declaredMatched).toBe(false);
  });

  it("invariant: hint can flip only when boosted weight exceeds pre-hint dominant", () => {
    // Gap = 3 between A and B. Boost = 1.5 means B needs ≥ A/1.5 files to win.
    // At A=6, B=4: B × 1.5 = 6.0 → A still wins (tie broken by iteration order).
    const d1 = distFrom([["A", 6], ["B", 4]]);
    const r1 = seedDominanceVote(d1, hint("B", 0.9));
    expect(r1.dominant).toBe("A");
    // At A=6, B=5: B × 1.5 = 7.5 → B wins.
    const d2 = distFrom([["A", 6], ["B", 5]]);
    const r2 = seedDominanceVote(d2, hint("B", 0.9));
    expect(r2.dominant).toBe("B");
  });

  it("low-confidence injected pattern cannot override a majority", () => {
    // Hint with low confidence creates only a weak virtual vote.
    const d = distFrom([["A", 3]]);
    const r = seedDominanceVote(d, hint("B", 0.6));
    // A (count/weight 3) vs B (weight 1.6) → A wins.
    expect(r.dominant).toBe("A");
    expect(r.declaredMatched).toBe(false);
  });

  it("high-confidence injected pattern beats a single-file raw vote — but that is DIVERGENCE, not agreement", () => {
    // A single file for A (weight 1) vs injected B with confidence 0.95 (weight 1.95).
    // The declaration flips the SEEDED dominant to B, but the CODE dominant is A.
    // declaredMatched must reflect the CODE, not the boosted vote (laundering fix).
    const d = distFrom([["A", 1]]);
    const r = seedDominanceVote(d, hint("B", 0.95));
    expect(r.dominant).toBe("B"); // seeded/displayed dominant
    expect(r.codeDominant).toBe("A"); // what the code actually does
    expect(r.flipped).toBe(true); // the declaration changed the dominant
    expect(r.declaredMatched).toBe(false); // → caller emits intent_divergence
  });

  it("flips a genuine tie but still reports divergence (the core laundering bug)", () => {
    // 5 files do A, 4 do B. Raw dominant is A. A 'use B' declaration boosts B
    // (4 * 1.5 = 6 > 5) and flips the seeded dominant to B — yet the codebase
    // has NOT converged on B, so the user must be warned, not reassured.
    const d = distFrom([["A", 5], ["B", 4]]);
    const r = seedDominanceVote(d, hint("B", 0.9));
    expect(r.codeDominant).toBe("A");
    expect(r.dominant).toBe("B");
    expect(r.flipped).toBe(true);
    expect(r.declaredMatched).toBe(false);
  });

  it("reports agreement (no divergence, no flip) when the code already follows the declaration", () => {
    const d = distFrom([["A", 5], ["B", 2]]);
    const r = seedDominanceVote(d, hint("A", 0.9));
    expect(r.codeDominant).toBe("A");
    expect(r.dominant).toBe("A");
    expect(r.flipped).toBe(false);
    expect(r.declaredMatched).toBe(true);
  });

  it("empty distribution with a hint yields the hint pattern as dominant (count 0)", () => {
    const d = new Map<string, { count: number; files: string[]; weight?: number }>();
    const r = seedDominanceVote(d, hint("A", 0.9));
    expect(r.dominant).toBe("A");
    expect(r.dominantCount).toBe(0);
    // No code to diverge from → no basis for a match/mismatch verdict.
    expect(r.codeDominant).toBeNull();
    expect(r.declaredMatched).toBeNull();
    expect(r.flipped).toBe(false);
  });

  it("empty distribution with no hint returns null dominant", () => {
    const d = new Map<string, { count: number; files: string[]; weight?: number }>();
    const r = seedDominanceVote(d, null);
    expect(r.dominant).toBeNull();
    expect(r.dominantCount).toBe(0);
    expect(r.declaredMatched).toBeNull();
  });
});
