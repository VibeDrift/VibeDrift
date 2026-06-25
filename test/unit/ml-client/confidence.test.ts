import { describe, it, expect } from "vitest";
import { filterByConfidence } from "../../../src/ml-client/confidence.js";
import { getAnalyzerKind } from "../../../src/scoring/categories.js";
import type { MlAnalyzeResponse } from "../../../src/ml-client/types.js";

function resp(over: Partial<MlAnalyzeResponse> = {}): MlAnalyzeResponse {
  return {
    processing_time_ms: 0,
    duplicates: [],
    intent_mismatches: [],
    anomalies: [],
    deviations: [],
    llm_validations: [],
    reimplementations: [],
    ...over,
  };
}

describe("filterByConfidence — reimplementations", () => {
  it("converts API reimplementations into ml-reimplementation findings", () => {
    const out = filterByConfidence(resp({
      reimplementations: [{
        name: "send_message",
        function_a: "p/openai.py::send_message",
        function_b: "p/ollama.py::send_message",
        member_ids: ["a", "b", "c"],
        files: ["p/openai.py", "p/ollama.py", "p/anthropic.py"],
        group_size: 3,
        verdict: "reimplementation",
        confidence: 1.0,
        real_votes: 3,
        votes: 3,
        reasons: ["same send logic"],
      }],
    }));
    const f = out.highConfidence.find((x) => x.analyzerId === "ml-reimplementation");
    expect(f).toBeDefined();
    expect(f!.tags).toContain("reimplementation");
    expect(f!.locations.length).toBe(3);
    expect(f!.message).toContain("send_message");
  });

  it("surfaces 2/3-confidence reimplementations (already panel-confirmed by the API)", () => {
    const out = filterByConfidence(resp({
      reimplementations: [{
        name: "formatDate", function_a: "a::formatDate", function_b: "b::formatDate",
        member_ids: ["a", "b"], files: ["a.ts", "b.ts"], group_size: 2,
        verdict: "reimplementation", confidence: 0.667, real_votes: 2, votes: 3, reasons: [],
      }],
    }));
    expect(out.highConfidence.some((x) => x.analyzerId === "ml-reimplementation")).toBe(true);
  });

  it("tolerates an old server response with no reimplementations field", () => {
    const r = resp();
    delete (r as { reimplementations?: unknown }).reimplementations;
    expect(() => filterByConfidence(r)).not.toThrow();
  });

  it("ml-reimplementation is findings-only in v1 (hygiene kind, not in the drift composite)", () => {
    expect(getAnalyzerKind("ml-reimplementation")).toBe("hygiene");
  });
});
