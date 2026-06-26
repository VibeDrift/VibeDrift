import { describe, it, expect } from "vitest";
import {
  extractOperationSequences,
  findSequenceSimilarities,
  sequenceFindings,
} from "../../../src/codedna/operation-sequence.js";
import type {
  ExtractedFunction,
  OperationSequence,
  SequenceSimilarity,
} from "../../../src/codedna/types.js";

function mkFn(partial: Partial<ExtractedFunction>): ExtractedFunction {
  return {
    name: partial.name ?? "fn",
    file: partial.file ?? "src/a.ts",
    relativePath: partial.relativePath ?? partial.file ?? "src/a.ts",
    line: partial.line ?? 1,
    language: partial.language ?? "typescript",
    params: partial.params ?? [],
    paramCount: partial.paramCount ?? 0,
    rawBody: partial.rawBody ?? "",
    declarationCode: partial.declarationCode ?? "",
    domainCategory: partial.domainCategory ?? "handlers",
    bodyTokens: partial.bodyTokens ?? [],
    bodyTokenCount: partial.bodyTokenCount ?? 0,
    bodyHash: partial.bodyHash ?? 0,
  };
}

describe("extractOperationSequences", () => {
  it("classifies a handler that reads params, queries, and returns", () => {
    const fn = mkFn({
      rawBody: [
        "const id = req.params.id;",
        "const user = db.query(userSql);",
        "return res.json(user);",
      ].join("\n"),
    });
    const seqs = extractOperationSequences([fn]);
    expect(seqs).toHaveLength(1);
    expect(seqs[0].sequence).toContain("INPUT");
    expect(seqs[0].sequence).toContain("QUERY");
    // Sequence ends with a return of some shape
    const last = seqs[0].sequence[seqs[0].sequence.length - 1];
    expect(last === "RETURN_OK" || last === "RETURN_ERR" || last === "TRANSFORM").toBe(true);
  });

  it("collapses consecutive duplicate ops", () => {
    const fn = mkFn({
      rawBody: [
        "const a = db.query(q1);",
        "const b = db.query(q2);",
        "const c = db.query(q3);",
      ].join("\n"),
    });
    const seqs = extractOperationSequences([fn]);
    // Three queries in a row collapse to one QUERY in the sequence.
    const queryCount = seqs[0].sequence.filter((op) => op === "QUERY").length;
    expect(queryCount).toBe(1);
  });
});

describe("findSequenceSimilarities", () => {
  it("produces LCS-based similarity between cross-file same-domain sequences", () => {
    const body = [
      "const id = req.params.id;",
      "const user = db.query(userSql);",
      "return res.json(user);",
    ].join("\n");
    const fns = [
      mkFn({ name: "getUser", file: "src/a.ts", domainCategory: "auth", rawBody: body }),
      mkFn({ name: "getAccount", file: "src/b.ts", domainCategory: "auth", rawBody: body }),
    ];
    const seqs = extractOperationSequences(fns);
    const sims = findSequenceSimilarities(seqs, fns);
    // Identical sequences on cross-file same-domain pairs → similarity 1.0
    expect(sims).toHaveLength(1);
    expect(sims[0].similarity).toBeCloseTo(1, 1);
  });

  it("does not emit a high-confidence match for short generic op sequences", () => {
    // Reproduces the bandcamp-audit false positive: summarizeReason() (joins two
    // strings) and appendDebugEvent() (pushes a debug record + trims an array)
    // both reduce to the generic idiom [TRANSFORM, BRANCH, TRANSFORM]. They share
    // nothing semantically, yet lcs/maxLen saturated to 1.0 and cleared the gate.
    // A sequence made only of filler ops (TRANSFORM/BRANCH/LOOP) must not emit.
    const summarizeReason = [
      "const top = candidate.supportSignals.slice(0, 2);", // TRANSFORM (.slice)
      "if (top.length) {",                                  // BRANCH
      "return top.join('+');",                              // TRANSFORM (.join)
    ].join("\n");
    const appendDebugEvent = [
      "recentEvents.push(evt);",
      "const label = evt.kind.trim();",                     // TRANSFORM (.trim)
      "if (recentEvents.length > maxEvents) {",             // BRANCH
      "recentEvents.splice(0, recentEvents.length - max);", // TRANSFORM (.splice)
    ].join("\n");
    const fns = [
      mkFn({ name: "summarizeReason", file: "src/tempo.ts", domainCategory: "handlers", rawBody: summarizeReason }),
      mkFn({ name: "appendDebugEvent", file: "src/engine.ts", domainCategory: "handlers", rawBody: appendDebugEvent }),
    ];
    const seqs = extractOperationSequences(fns);
    // Sanity: both really do reduce to the identical generic 3-op sequence.
    expect(seqs[0].sequence).toEqual(["TRANSFORM", "BRANCH", "TRANSFORM"]);
    expect(seqs[1].sequence).toEqual(["TRANSFORM", "BRANCH", "TRANSFORM"]);
    // The matcher must NOT report this as a near-duplicate.
    expect(findSequenceSimilarities(seqs, fns)).toHaveLength(0);
  });

  it("does not emit when a generic-dominated run carries one incidental distinctive op", () => {
    // Reproduces the bandcamp-audit pruneAndCap() vs UI-builder false positives.
    // A cache-eviction loop and a DOM builder both reduce to LOOP/BRANCH plumbing
    // with a single incidental `.delete(`/`.create(` MUTATE. Their shared run is
    // [LOOP, BRANCH, LOOP, BRANCH, MUTATE] — 5 ops but only ONE distinctive op.
    // That is generic idiom, not a shared workflow, and must not be reported.
    const generic1: OperationSequence = {
      functionRef: { file: "src/cache.ts", relativePath: "src/cache.ts", name: "pruneAndCap", line: 1 },
      sequence: ["LOOP", "BRANCH", "MUTATE", "LOOP", "BRANCH", "MUTATE"],
    };
    const generic2: OperationSequence = {
      functionRef: { file: "src/ui.ts", relativePath: "src/ui.ts", name: "createTransport", line: 1 },
      sequence: ["BRANCH", "LOOP", "BRANCH", "LOOP", "BRANCH", "MUTATE"],
    };
    const fns = [
      mkFn({ name: "pruneAndCap", file: "src/cache.ts", domainCategory: "handlers" }),
      mkFn({ name: "createTransport", file: "src/ui.ts", domainCategory: "handlers" }),
    ];
    expect(findSequenceSimilarities([generic1, generic2], fns)).toHaveLength(0);
  });

  it("still emits a genuine long all-generic exact duplicate", () => {
    // parseClockDurationToSeconds() is copy-pasted across two files: identical
    // 6-op all-generic sequence. A long exact generic duplicate is a real drift
    // signal and must remain detected (do not zero out the detector).
    const body = ["LOOP", "BRANCH", "TRANSFORM", "BRANCH", "LOOP", "BRANCH"] as const;
    const dupA: OperationSequence = {
      functionRef: { file: "src/payload.ts", relativePath: "src/payload.ts", name: "parseClock", line: 1 },
      sequence: [...body],
    };
    const dupB: OperationSequence = {
      functionRef: { file: "src/resolver.ts", relativePath: "src/resolver.ts", name: "parseClock", line: 1 },
      sequence: [...body],
    };
    const fns = [
      mkFn({ name: "parseClock", file: "src/payload.ts", domainCategory: "handlers" }),
      mkFn({ name: "parseClock", file: "src/resolver.ts", domainCategory: "handlers" }),
    ];
    const sims = findSequenceSimilarities([dupA, dupB], fns);
    expect(sims).toHaveLength(1);
    expect(sims[0].similarity).toBeCloseTo(1, 1);
  });

  it("skips same-file pairs", () => {
    const fns = [
      mkFn({ name: "getA", file: "src/a.ts", domainCategory: "auth", rawBody: "const x = db.query(q); return x;" }),
      mkFn({ name: "getB", file: "src/a.ts", domainCategory: "auth", rawBody: "const x = db.query(q); return x;" }),
    ];
    const seqs = extractOperationSequences(fns);
    expect(findSequenceSimilarities(seqs, fns)).toHaveLength(0);
  });

  it("skips cross-domain pairs", () => {
    const body = "const x = db.query(q); return x;";
    const fns = [
      mkFn({ name: "a", file: "src/a.ts", domainCategory: "auth", rawBody: body }),
      mkFn({ name: "b", file: "src/b.ts", domainCategory: "billing", rawBody: body }),
    ];
    const seqs = extractOperationSequences(fns);
    expect(findSequenceSimilarities(seqs, fns)).toHaveLength(0);
  });

  it("skips the 'general' and 'request_handling' noise categories", () => {
    const body = "const x = db.query(q); return x;";
    const fns = [
      mkFn({ name: "a", file: "src/a.ts", domainCategory: "general", rawBody: body }),
      mkFn({ name: "b", file: "src/b.ts", domainCategory: "general", rawBody: body }),
    ];
    const seqs = extractOperationSequences(fns);
    expect(findSequenceSimilarities(seqs, fns)).toHaveLength(0);
  });

  it("LCS normalization: 2·lcs / (|a|+|b|) ∈ [0, 1]", () => {
    const seqs: OperationSequence[] = [
      {
        functionRef: { file: "a", relativePath: "a", name: "a", line: 1 },
        sequence: ["INPUT", "QUERY", "RETURN_OK", "RETURN_OK"], // length 4 after collapse in real pipeline; here we craft raw
      },
      {
        functionRef: { file: "b", relativePath: "b", name: "b", line: 1 },
        sequence: ["INPUT", "QUERY", "BRANCH", "RETURN_ERR"],
      },
    ];
    const fns = [
      mkFn({ name: "a", file: "a", domainCategory: "auth" }),
      mkFn({ name: "b", file: "b", domainCategory: "auth" }),
    ];
    const sims = findSequenceSimilarities(seqs, fns);
    if (sims.length > 0) {
      expect(sims[0].similarity).toBeGreaterThanOrEqual(0);
      expect(sims[0].similarity).toBeLessThanOrEqual(1);
    }
  });
});

describe("sequenceFindings — severity graded by match strength", () => {
  function mkSim(partial: Partial<SequenceSimilarity>): SequenceSimilarity {
    return {
      functionA: { file: "a", relativePath: "a", name: "a", line: 1 },
      functionB: { file: "b", relativePath: "b", name: "b", line: 1 },
      similarity: partial.similarity ?? 0.8,
      lcsLength: partial.lcsLength ?? 3,
      maxLength: partial.maxLength ?? 5,
    };
  }

  it("a strong, long match (sim>=0.92 && lcs>=6) grades warning", () => {
    const f = sequenceFindings([mkSim({ similarity: 0.95, lcsLength: 8 })])[0];
    expect(f.severity).toBe("warning");
  });

  it("a borderline-similarity match grades info even with a long LCS", () => {
    const f = sequenceFindings([mkSim({ similarity: 0.85, lcsLength: 8 })])[0];
    expect(f.severity).toBe("info");
  });

  it("a short match grades info even at high similarity", () => {
    const f = sequenceFindings([mkSim({ similarity: 0.95, lcsLength: 4 })])[0];
    expect(f.severity).toBe("info");
  });

  it("keeps the existing graded confidence (min(similarity, 0.95))", () => {
    expect(sequenceFindings([mkSim({ similarity: 0.83 })])[0].confidence).toBeCloseTo(0.83);
    expect(sequenceFindings([mkSim({ similarity: 0.99 })])[0].confidence).toBeCloseTo(0.95);
  });
});
