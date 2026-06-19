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

import { deepDuplicatesViaIndex } from "../../../src/mcp/deep-index.js";
import { resolveToken } from "../../../src/auth/resolver.js";
import { embedFunctions } from "../../../src/ml-client/embed-client.js";
import { buildEmbeddingIndex } from "../../../src/ml-client/build-embedding-index.js";
import { loadEmbeddingIndex, type EmbeddingIndex } from "../../../src/core/embedding-index.js";

function index(baselineKey: string): EmbeddingIndex {
  return {
    version: 1,
    rootDir: "/r",
    baselineKey,
    dim: 3,
    builtAt: 0,
    entries: [
      { id: "a.ts::formatMoney", relativePath: "a.ts", name: "formatMoney", line: 1, contentHash: "h", vector: [1, 0, 0] },
      { id: "b.ts::add", relativePath: "b.ts", name: "add", line: 1, contentHash: "h", vector: [0, 1, 0] },
    ],
  };
}
const QUERY = { id: "query::formatAmount", name: "formatAmount", file: "query", body: "x", line_start: 0, line_end: 0, language: "typescript" };
const tok = (t: string | null) => (resolveToken as ReturnType<typeof vi.fn>).mockResolvedValue(t ? { token: t, source: "config" } : null);

describe("deepDuplicatesViaIndex", () => {
  beforeEach(() => vi.clearAllMocks());

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
});
