import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../src/auth/resolver.js", () => ({
  resolveToken: vi.fn(),
  resolveApiUrl: vi.fn(async () => "https://api.test"),
}));
vi.mock("../../../src/ml-client/embed-client.js", () => ({ embedFunctions: vi.fn() }));
vi.mock("../../../src/ml-client/build-embedding-index.js", () => ({ buildEmbeddingIndex: vi.fn() }));
// Keep the real cosine/isIndexStale; only loadEmbeddingIndex is stubbed.
vi.mock("../../../src/core/embedding-index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/embedding-index.js")>();
  return { ...actual, loadEmbeddingIndex: vi.fn() };
});
// Keep the real classifyDegradeReason; only the cloud verdict (deepAnalyze) is stubbed.
vi.mock("../../../src/mcp/deep-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/mcp/deep-client.js")>();
  return { ...actual, deepAnalyze: vi.fn() };
});

import { deepDuplicatesViaIndex } from "../../../src/mcp/deep-index.js";
import { resolveToken } from "../../../src/auth/resolver.js";
import { embedFunctions } from "../../../src/ml-client/embed-client.js";
import { buildEmbeddingIndex } from "../../../src/ml-client/build-embedding-index.js";
import { loadEmbeddingIndex, type EmbeddingIndex } from "../../../src/core/embedding-index.js";
import { deepAnalyze } from "../../../src/mcp/deep-client.js";

function index(baselineKey: string): EmbeddingIndex {
  return {
    version: 2,
    rootDir: "/r",
    baselineKey,
    dim: 3,
    builtAt: 0,
    entries: [
      { id: "a.ts::formatMoney", relativePath: "a.ts", name: "formatMoney", line: 1, contentHash: "h", body: "function formatMoney(n){ return '$'+n; }", vector: [1, 0, 0] },
      { id: "b.ts::add", relativePath: "b.ts", name: "add", line: 1, contentHash: "h", body: "function add(a,b){ return a+b; }", vector: [0, 1, 0] },
    ],
  };
}

// An index whose only entry sits in the borderline band (cosine ~0.8 with [1,0,0]).
function borderlineIndex(): EmbeddingIndex {
  return {
    version: 2,
    rootDir: "/r",
    baselineKey: "bk",
    dim: 3,
    builtAt: 0,
    entries: [
      { id: "a.ts::maybeTwin", relativePath: "a.ts", name: "maybeTwin", line: 7, contentHash: "h", body: "function maybeTwin(n){ return n * 2; }", vector: [0.8, 0.6, 0] },
    ],
  };
}
const QUERY = { id: "query::formatAmount", name: "formatAmount", file: "query", body: "x", line_start: 0, line_end: 0, language: "typescript" };
const tok = (t: string | null) => (resolveToken as ReturnType<typeof vi.fn>).mockResolvedValue(t ? { token: t, source: "config" } : null);

describe("deepDuplicatesViaIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: cloud verdict returns nothing (most tests only exercise the
    // high-confidence local path and never reach it).
    (deepAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue({ degraded: false, intentMismatches: [], duplicates: [] });
  });

  it("degrades (no_token) and never touches the index when signed out", async () => {
    tok(null);
    const r = await deepDuplicatesViaIndex("/r", QUERY, "bk");
    expect(r).toMatchObject({ degraded: true, reason: "no_token" });
    expect(loadEmbeddingIndex).not.toHaveBeenCalled();
    expect(embedFunctions).not.toHaveBeenCalled();
  });

  it("finds a cross-API clone via the cached index (no rebuild)", async () => {
    tok("t");
    (loadEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(index("bk"));
    (embedFunctions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: QUERY.id, vector: [0.99, 0.01, 0] }]);
    const r = await deepDuplicatesViaIndex("/r", QUERY, "bk");
    expect(buildEmbeddingIndex).not.toHaveBeenCalled(); // fresh → no rebuild
    expect(r?.duplicates).toHaveLength(1);
    expect(r?.duplicates[0].detail).toBe("query::formatAmount ≈ a.ts::formatMoney");
    expect(r?.duplicates[0].verdict).toBe("semantic_duplicate");
    expect(r?.intentMismatches).toEqual([]); // local index = duplicates only
    expect(deepAnalyze).not.toHaveBeenCalled(); // ≥0.90 ships locally — no cloud verdict
  });

  it("rebuilds the index when the baseline key changed", async () => {
    tok("t");
    (loadEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(index("old-key"));
    (buildEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(index("bk"));
    (embedFunctions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: QUERY.id, vector: [1, 0, 0] }]);
    await deepDuplicatesViaIndex("/r", QUERY, "bk");
    expect(buildEmbeddingIndex).toHaveBeenCalledTimes(1);
  });

  it("returns null (→ caller falls back) when no index can be built", async () => {
    tok("t");
    (loadEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (buildEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await deepDuplicatesViaIndex("/r", QUERY, "bk");
    expect(r).toBeNull();
    expect(embedFunctions).not.toHaveBeenCalled();
  });

  it("degrades (never throws) when the query embed call fails", async () => {
    tok("t");
    (loadEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(index("bk"));
    (embedFunctions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Embed API error 402: quota"));
    const r = await deepDuplicatesViaIndex("/r", QUERY, "bk");
    expect(r).toMatchObject({ degraded: true, reason: "quota" });
  });

  it("excludeFile drops a self-match", async () => {
    tok("t");
    (loadEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(index("bk"));
    (embedFunctions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: QUERY.id, vector: [1, 0, 0] }]);
    const r = await deepDuplicatesViaIndex("/r", QUERY, "bk", { excludeFile: "a.ts" });
    expect(r?.duplicates).toHaveLength(0); // the only match was in the excluded file
  });

  it("escalates a borderline match to the cloud and surfaces the LLM verdict", async () => {
    tok("t");
    (loadEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(borderlineIndex());
    (embedFunctions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: QUERY.id, vector: [1, 0, 0] }]);
    (deepAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue({
      degraded: false,
      intentMismatches: [],
      duplicates: [{ kind: "duplicate", detail: "query::formatAmount ≈ a.ts::maybeTwin", confidence: 0.94, verdict: "semantic_duplicate" }],
    });
    const r = await deepDuplicatesViaIndex("/r", QUERY, "bk");
    // Sent ONLY the query + the one borderline candidate (with its stored body),
    // and passed the query id so the server can filter its pairwise result.
    expect(deepAnalyze).toHaveBeenCalledTimes(1);
    const [sentFns, , sentQueryId] = (deepAnalyze as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sentFns).toHaveLength(2);
    expect(sentFns[0].id).toBe("query::formatAmount");
    expect(sentFns[1].id).toBe("a.ts::maybeTwin");
    expect(sentFns[1].body).toBe("function maybeTwin(n){ return n * 2; }");
    expect(sentQueryId).toBe("query::formatAmount");
    expect(r?.duplicates).toHaveLength(1);
    expect(r?.duplicates[0].verdict).toBe("semantic_duplicate");
  });

  it("drops a borderline match the cloud rejects (no false positive surfaced)", async () => {
    tok("t");
    (loadEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(borderlineIndex());
    (embedFunctions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: QUERY.id, vector: [1, 0, 0] }]);
    (deepAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue({ degraded: false, intentMismatches: [], duplicates: [] });
    const r = await deepDuplicatesViaIndex("/r", QUERY, "bk");
    expect(deepAnalyze).toHaveBeenCalledTimes(1);
    expect(r?.duplicates).toHaveLength(0);
  });

  it("reports degraded when the only matches are borderline and the cloud verdict fails", async () => {
    tok("t");
    (loadEmbeddingIndex as ReturnType<typeof vi.fn>).mockResolvedValue(borderlineIndex());
    (embedFunctions as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: QUERY.id, vector: [1, 0, 0] }]);
    (deepAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue({ degraded: true, reason: "rate_limited", intentMismatches: [], duplicates: [] });
    const r = await deepDuplicatesViaIndex("/r", QUERY, "bk");
    expect(r).toMatchObject({ degraded: true, reason: "rate_limited" });
  });
});
