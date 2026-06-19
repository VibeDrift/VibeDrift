import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub the network embed call; everything else (extraction, persistence) is real.
vi.mock("../../../src/ml-client/embed-client.js", () => ({ embedFunctions: vi.fn() }));

import { buildEmbeddingIndex } from "../../../src/ml-client/build-embedding-index.js";
import { embedFunctions } from "../../../src/ml-client/embed-client.js";
import { loadEmbeddingIndex } from "../../../src/core/embedding-index.js";

describe("buildEmbeddingIndex", () => {
  let repo: string;
  let home: string;
  let prevHome: string | undefined;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "vd-bei-repo-"));
    writeFileSync(join(repo, "a.ts"), "export function formatMoney(cents){ const d = cents/100; return `$${d}`; }\n");
    writeFileSync(join(repo, "b.ts"), "export function addNumbers(a, b){ const total = a + b; return total; }\n");
    home = mkdtempSync(join(tmpdir(), "vd-bei-home-"));
    prevHome = process.env.HOME;
    process.env.HOME = home; // redirect ~/.vibedrift to a temp dir
  });
  afterAll(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  beforeEach(() => vi.clearAllMocks());

  it("embeds the repo's functions and persists a loadable index", async () => {
    // Return a vector for whatever ids the builder sends.
    (embedFunctions as ReturnType<typeof vi.fn>).mockImplementation(async (payloads: any[]) =>
      payloads.map((p) => ({ id: p.id, vector: [p.id.length, 1, 2] })),
    );
    const index = await buildEmbeddingIndex(repo, "bk-1", { token: "tok", nowMs: 123 });
    expect(index).not.toBeNull();
    expect(index!.baselineKey).toBe("bk-1");
    expect(index!.builtAt).toBe(123);
    expect(index!.dim).toBe(3);
    expect(index!.entries.some((e) => e.name === "formatMoney")).toBe(true);
    // v2: each entry stores its (truncated) body for borderline LLM validation
    const fm = index!.entries.find((e) => e.name === "formatMoney");
    expect(fm!.body).toContain("cents/100"); // the extracted body (sans signature)
    // round-trips through the local store
    const loaded = await loadEmbeddingIndex(repo);
    expect(loaded?.entries.length).toBe(index!.entries.length);
    expect(loaded!.version).toBe(2);
  });

  it("returns null (no index) when the embed call yields nothing", async () => {
    (embedFunctions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const index = await buildEmbeddingIndex(repo, "bk-1", { token: "tok" });
    expect(index).toBeNull();
  });

  it("returns null when embedding throws (offline) — caller falls back", async () => {
    (embedFunctions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network"));
    const index = await buildEmbeddingIndex(repo, "bk-1", { token: "tok" });
    expect(index).toBeNull();
  });
});
