import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../../src/mcp/deep-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/mcp/deep-client.js")>();
  return { ...actual, deepAnalyze: vi.fn() };
});

import { findSimilarToBody } from "../../../../src/codedna/find-similar-to-body.js";
import { buildSignature } from "../../../../src/codedna/minhash.js";
import { run } from "../../../../src/mcp/tools/find-similar-function.js";
import { deepAnalyze } from "../../../../src/mcp/deep-client.js";
import { buildBaseline, writeBaseline } from "../../../../src/core/baseline.js";
import { __clearBaselineCache } from "../../../../src/mcp/baseline-provider.js";

function entry(relativePath: string, name: string, body: string) {
  const sig = buildSignature(body);
  return { relativePath, name, line: 1, tokens: sig.tokens };
}

describe("findSimilarToBody (pure)", () => {
  const index = [
    entry("a.ts", "fetchUser", "async function fetchUser(id){ const u = await db.users.find(id); if(!u) throw new E(); return u; }"),
    entry("z.ts", "add", "function add(a, b){ return a + b; }"),
  ];

  it("ranks a near-duplicate above the threshold and excludes the unrelated function", () => {
    const matches = findSimilarToBody(
      "async function getUser(uid){ const r = await db.users.find(uid); if(!r) throw new E(); return r; }",
      index,
      { threshold: 0.6, cap: 20 },
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].relativePath).toBe("a.ts");
    expect(matches[0].similarity).toBeGreaterThan(0.6);
    expect(matches.find((m) => m.relativePath === "z.ts")).toBeUndefined();
  });

  it("respects the cap and sorts by similarity descending", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      entry(`f${i}.ts`, `fn${i}`, `async function fn${i}(id){ const u = await db.users.find(id); if(!u) throw new E(); return u; }`),
    );
    const matches = findSimilarToBody(
      "async function q(id){ const u = await db.users.find(id); if(!u) throw new E(); return u; }",
      many,
      { threshold: 0.5, cap: 5 },
    );
    expect(matches.length).toBe(5);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].similarity).toBeGreaterThanOrEqual(matches[i].similarity);
    }
  });
});

describe("find_similar_function (integration)", () => {
  let repo: string;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "vd-sim-"));
    writeFileSync(join(repo, "user.ts"), "export async function getUserById(repo, id){ const u = await repo.users.findById(id); if(!u) throw new NotFound(); return u; }\n");
    writeFileSync(join(repo, "acct.ts"), "export function add(a, b){ return a + b; }\n");
    await writeBaseline(await buildBaseline(repo));
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  beforeEach(() => __clearBaselineCache());

  it("finds the existing near-duplicate for a new function body", async () => {
    const out = await run({
      rootDir: repo,
      body: "async function fetchUser(r, userId){ const rec = await r.users.findById(userId); if(!rec) throw new NotFound(); return rec; }",
    });
    expect(["ok", "stale"]).toContain(out.status);
    expect(out.found).toBe(true);
    expect(out.matches.some((m) => m.name === "getUserById")).toBe(true);
    expect(out.matches.find((m) => m.name === "add")).toBeUndefined();
  });

  it("returns no_baseline for an unscanned dir", async () => {
    const empty = mkdtempSync(join(tmpdir(), "vd-empty-sim-"));
    try {
      const out = await run({ rootDir: empty, body: "function x(){}" });
      expect(out.status).toBe("no_baseline");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("deep:true surfaces a semantic duplicate the local index missed (status=partial)", async () => {
    (deepAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue({
      degraded: false, intentMismatches: [],
      duplicates: [{ kind: "duplicate", detail: "x ≈ y", confidence: 0.88, verdict: "confirmed" }],
    });
    // a body with no local match, so only the deep pass can flag it
    const out = await run({ rootDir: repo, body: "function totallyUnrelated(){ return Math.random(); }", deep: true });
    expect(out.deep?.duplicates).toHaveLength(1);
    expect(out.found).toBe(true);
    expect(out.status).toBe("partial");
  });

  it("deep:true degrades on rate_limit without throwing", async () => {
    (deepAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue({
      degraded: true, reason: "rate_limited", intentMismatches: [], duplicates: [],
    });
    const out = await run({ rootDir: repo, body: "function x(){}", deep: true });
    expect(out.status).toBe("degraded");
    expect(out.message).toMatch(/retry/i);
  });

  it("without deep, never calls the cloud", async () => {
    (deepAnalyze as ReturnType<typeof vi.fn>).mockClear();
    await run({ rootDir: repo, body: "function x(){}" });
    expect(deepAnalyze).not.toHaveBeenCalled();
  });
});
