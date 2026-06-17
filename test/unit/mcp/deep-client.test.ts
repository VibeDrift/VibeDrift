import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the underlying HTTP client + auth resolver so the deep-client is tested
// in isolation (no network). vi.mock is hoisted; the factories return spies we
// re-stub per test via the imported mocked modules.
vi.mock("../../../src/ml-client/client.js", () => ({ callMlApi: vi.fn() }));
vi.mock("../../../src/auth/resolver.js", () => ({
  resolveToken: vi.fn(),
  resolveApiUrl: vi.fn(async () => "https://api.test"),
}));

import { deepAnalyze, bodyToPayloads, inferLanguage, guessName } from "../../../src/mcp/deep-client.js";
import { callMlApi } from "../../../src/ml-client/client.js";
import { resolveToken } from "../../../src/auth/resolver.js";

describe("deep-client helpers", () => {
  it("inferLanguage maps extensions", () => {
    expect(inferLanguage("a/b/c.ts")).toBe("typescript");
    expect(inferLanguage("x.py")).toBe("python");
    expect(inferLanguage("noext")).toBe("unknown");
  });
  it("guessName extracts the function name from a body", () => {
    expect(guessName("async function getInvoices(id){}")).toBe("getInvoices");
    expect(guessName("const sumPrices = (xs) => xs")).toBe("sumPrices");
    expect(guessName("def is_valid_email(a):")).toBe("is_valid_email");
    expect(guessName("// no function here")).toBe("change");
  });
  it("bodyToPayloads builds a single API payload with name + language", () => {
    const [p] = bodyToPayloads("function f(){}", "src/a.ts");
    expect(p).toMatchObject({ name: "f", file: "src/a.ts", language: "typescript", id: "src/a.ts::f" });
  });
});

const FN = {
  id: "a.ts::getInvoices", name: "getInvoices", file: "a.ts",
  body: "async function getInvoices(id){ await db.invoices.delete(id); }",
  line_start: 1, line_end: 1, language: "typescript",
};

describe("deepAnalyze", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps API intent + duplicate findings into DeepResult", async () => {
    (resolveToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: "t", source: "config" });
    (callMlApi as ReturnType<typeof vi.fn>).mockResolvedValue({
      processing_time_ms: 5,
      intent_mismatches: [{ function_id: "a.ts::getInvoices", name: "getInvoices", similarity: 0.49, confidence: 0.92, needs_llm: true, llm_verdict: "confirmed" }],
      duplicates: [{ function_a: "a.ts::getInvoices", function_b: "b.ts::fetchInvoices", similarity: 0.88, confidence: 0.9, verdict: "semantic_duplicate", needs_llm: false }],
      anomalies: [], deviations: [], llm_validations: [],
    });
    const r = await deepAnalyze([FN], "typescript");
    expect(r.degraded).toBe(false);
    expect(r.intentMismatches).toHaveLength(1);
    expect(r.intentMismatches[0]).toMatchObject({ kind: "intent", detail: "getInvoices", verdict: "confirmed" });
    expect(r.duplicates).toHaveLength(1);
    expect(r.duplicates[0].detail).toContain("getInvoices");
    // sends source: 'mcp' and defer_persist: false
    const sent = (callMlApi as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sent.source).toBe("mcp");
    expect(sent.defer_persist).toBe(false);
  });

  it("degrades (never throws) when not signed in", async () => {
    (resolveToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await deepAnalyze([FN], "typescript");
    expect(r).toMatchObject({ degraded: true, reason: "no_token" });
    expect(callMlApi).not.toHaveBeenCalled();
  });

  it("degrades with reason 'quota' on a 402, never throws", async () => {
    (resolveToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: "t", source: "config" });
    (callMlApi as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Deep-analysis API error 402: quota"));
    const r = await deepAnalyze([FN], "typescript");
    expect(r).toMatchObject({ degraded: true, reason: "quota" });
  });

  it("degrades with reason 'rate_limited' on a 429", async () => {
    (resolveToken as ReturnType<typeof vi.fn>).mockResolvedValue({ token: "t", source: "config" });
    (callMlApi as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Deep-analysis API error 429: slow down"));
    const r = await deepAnalyze([FN], "typescript");
    expect(r.degraded).toBe(true);
    expect(r.reason).toBe("rate_limited");
  });
});
