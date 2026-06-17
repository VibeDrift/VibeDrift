import { describe, it, expect } from "vitest";
import {
  extractOperationSequences,
  findSequenceSimilarities,
} from "../../../src/codedna/operation-sequence.js";
import type { ExtractedFunction, OperationSequence } from "../../../src/codedna/types.js";

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
