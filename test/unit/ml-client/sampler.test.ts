import { describe, it, expect } from "vitest";
import {
  sampleFunctionsForMl,
  functionsInSimilarityBand,
  SIMILARITY_BAND_LOW,
  SIMILARITY_BAND_HIGH,
} from "../../../src/ml-client/sampler.js";
import { buildSignature, lcsSimilarity } from "../../../src/codedna/minhash.js";
import type { ExtractedFunction } from "../../../src/codedna/types.js";

function fn(name: string, file: string, body: string): ExtractedFunction {
  return {
    name,
    file,
    relativePath: file,
    rawBody: body,
    line: 1,
    language: "typescript",
  } as unknown as ExtractedFunction;
}

// A pair of functions that are clearly related but NOT identical — the
// ambiguous middle band where an embedding/LLM judge adds value. (Exact
// clones are caught locally; unrelated code is obviously different.)
const BODY_A = `function processA(items) {
  let total = 0;
  let count = 0;
  for (const item of items) {
    total += item.price;
    count += 1;
  }
  const average = total / count;
  const tax = total * 0.1;
  const fee = total - 2;
  return { total, average, tax, fee };
}`;
const BODY_B = `function processB(items) {
  let total = 0;
  let count = 0;
  for (const item of items) {
    total += item.price;
    count += 1;
  }
  const average = total / count;
  const flag = count > 5 ? true : false;
  const label = count === 0 ? "empty" : "ok";
  const ranges = [1, 2, 3, 4];
  return { average, flag, label, ranges };
}`;

describe("functionsInSimilarityBand", () => {
  it("precondition: the crafted pair lands in the ambiguous band", () => {
    const sim = lcsSimilarity(
      buildSignature(BODY_A).tokens,
      buildSignature(BODY_B).tokens,
    );
    // Guards the test: if tokenization changes push this out of band, this
    // fails loudly rather than the routing test silently passing for the
    // wrong reason.
    expect(sim).toBeGreaterThanOrEqual(SIMILARITY_BAND_LOW);
    expect(sim).toBeLessThanOrEqual(SIMILARITY_BAND_HIGH);
  });

  it("returns the indices of both members of an in-band pair", () => {
    const fns = [fn("computeTotals", "a.ts", BODY_A), fn("computeOrderSummary", "b.ts", BODY_B)];
    const band = functionsInSimilarityBand(fns);
    expect(band.has(0)).toBe(true);
    expect(band.has(1)).toBe(true);
  });

  it("returns empty for a single function", () => {
    expect(functionsInSimilarityBand([fn("x", "x.ts", BODY_A)]).size).toBe(0);
  });
});

describe("sampleFunctionsForMl — similarity-band routing", () => {
  it("seeds both members of an ambiguous pair even when the keyword/size heuristic would drop them", () => {
    // 40 trivial filler functions in non-entry, no-finding files so they all
    // score low. The cap is 30, so without band routing the low-priority
    // near-duplicate pair (appended last) would be dropped.
    const filler: ExtractedFunction[] = Array.from({ length: 40 }, (_, i) =>
      fn(`fn${i}`, `misc/file${i}.ts`, `function fn${i}() { return ${i}; }`),
    );
    const pair = [
      fn("computeTotals", "misc/za.ts", BODY_A),
      fn("computeOrderSummary", "misc/zb.ts", BODY_B),
    ];
    const all = [...filler, ...pair];

    const selected = sampleFunctionsForMl(all, []);
    const ids = new Set(selected.map((s) => s.id));
    expect(ids.has("misc/za.ts::computeTotals")).toBe(true);
    expect(ids.has("misc/zb.ts::computeOrderSummary")).toBe(true);
  });

  it("still respects the 30-function cap", () => {
    const filler: ExtractedFunction[] = Array.from({ length: 40 }, (_, i) =>
      fn(`fn${i}`, `misc/file${i}.ts`, `function fn${i}() { return ${i}; }`),
    );
    expect(sampleFunctionsForMl(filler, []).length).toBeLessThanOrEqual(30);
  });
});
