import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the real pure helpers (bodyToPayloads/inferLanguage) but stub the network
// call so deep-mode tests are deterministic and offline.
vi.mock("../../../../src/mcp/deep-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/mcp/deep-client.js")>();
  return { ...actual, deepAnalyze: vi.fn() };
});

import { validateChange, run } from "../../../../src/mcp/tools/validate-change.js";
import { deepAnalyze } from "../../../../src/mcp/deep-client.js";
import { buildSignature } from "../../../../src/codedna/minhash.js";
import { buildBaseline, writeBaseline, type RepoDriftBaseline } from "../../../../src/core/baseline.js";
import { __clearBaselineCache } from "../../../../src/mcp/baseline-provider.js";

const THEN_BODY = ["function f(){", "  return a()", "    .then(x => x)", "    .then(y => y);", "}"].join("\n");
const AWAIT_BODY = ["async function g(){", "  const a = await p();", "  const b = await q();", "  return a + b;", "}"].join("\n");

function baseline(asyncDom: string | null, index: Array<{ path: string; name: string; body: string }>): RepoDriftBaseline {
  return {
    key: "k",
    rootDir: "/r",
    ctxFiles: [{ path: "x.ts", hash: "h" }],
    perCategoryVote: asyncDom
      ? {
          async_patterns: {
            driftCategory: "async_patterns",
            dominantPattern: asyncDom,
            dominantCount: 8,
            totalRelevantFiles: 10,
            consistencyScore: 80,
            dominantFiles: ["ref.ts"],
            deviators: [],
          },
        }
      : {},
    intentHints: [],
    minhashIndex: index.map((e) => {
      const s = buildSignature(e.body);
      return { relativePath: e.path, name: e.name, line: 1, tokens: s.tokens, signature: s.signature };
    }),
    builtAt: 0,
  };
}

describe("validateChange (pure)", () => {
  it("flags an async conflict when the proposed body's style differs from the dominant", () => {
    // baselines store the DISPLAY name (what the detector emits), not the key
    const r = validateChange(baseline("async/await", []), "new.ts", THEN_BODY);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].dimension).toBe("async_patterns");
    expect(r.conflicts[0].dominantPattern).toBe("async/await");
    expect(r.conflicts[0].yourPattern).toBe(".then() chains");
    expect(r.referenceFiles).toContain("ref.ts");
  });

  it("returns ok for a conforming, non-duplicate change", () => {
    const r = validateChange(baseline("async/await", [{ path: "u.ts", name: "unrelated", body: "function u(){ return 1; }" }]), "new.ts", AWAIT_BODY);
    expect(r.ok).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(r.duplicateOf).toEqual([]);
  });

  it("flags a near-duplicate the change would introduce", () => {
    const existing = "async function getUser(id){ const u = await db.users.find(id); if(!u) throw new E(); return u; }";
    const r = validateChange(baseline(null, [{ path: "user.ts", name: "getUser", body: existing }]), "new.ts",
      "async function fetchUser(uid){ const r = await db.users.find(uid); if(!r) throw new E(); return r; }");
    expect(r.duplicateOf.some((m) => m.name === "getUser")).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("does NOT flag a function as a duplicate of itself when editing its own file", () => {
    const existing = "async function getUser(id){ const u = await db.users.find(id); if(!u) throw new E(); return u; }";
    const r = validateChange(baseline(null, [{ path: "user.ts", name: "getUser", body: existing }]), "user.ts",
      "async function getUser(id){ const u = await db.users.find(id); if(!u) throw new E(); return u; }");
    expect(r.duplicateOf).toEqual([]); // editing the same file is not a duplicate
    expect(r.ok).toBe(true);
  });
});

describe("validateChange — declared-convention fallback (no detector vote)", () => {
  // When a dimension is 100% consistent the detector emits no finding, so there
  // is NO perCategoryVote for it. The team's DECLARED rule (intent hint) must
  // then stand in as the dominant — otherwise the most valuable drift to prevent
  // (the first .then() in an all-async/await repo) slips through ok:true.
  function withHints(hints: RepoDriftBaseline["intentHints"]): RepoDriftBaseline {
    const b = baseline(null, []); // no async vote
    b.intentHints = hints;
    return b;
  }
  const AWAIT_HINT = { category: "async_patterns" as const, pattern: "async_await", label: "async/await", source: "CLAUDE.md", line: 101, text: "use async/await throughout. No .then() chains", confidence: 0.7 };
  const THEN_HINT = { category: "async_patterns" as const, pattern: "then_chain", label: ".then() chains", source: "CLAUDE.md", line: 77, text: "async-consistency: async/await vs .then() chains", confidence: 0.5 };

  it("flags a .then() change against a repo that DECLARES async/await but has no async vote", () => {
    const r = validateChange(withHints([AWAIT_HINT]), "new.ts", THEN_BODY);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].dimension).toBe("async_patterns");
    expect(r.conflicts[0].dominantPattern).toBe("async/await");
    expect(r.conflicts[0].yourPattern).toBe(".then() chains");
    expect(r.conflicts[0].fixHint).toMatch(/declared in CLAUDE\.md:101/);
  });

  it("picks the HIGHEST-confidence hint when async hints conflict (async_await 0.7 beats then_chain 0.5)", () => {
    const r = validateChange(withHints([THEN_HINT, AWAIT_HINT]), "new.ts", THEN_BODY);
    expect(r.ok).toBe(false); // async_await wins → the .then() change is drift
    expect(r.conflicts[0].dominantPattern).toBe("async/await");
  });

  it("does NOT flag an async/await change when the declared rule is async/await (no false positive)", () => {
    const r = validateChange(withHints([AWAIT_HINT]), "new.ts", AWAIT_BODY);
    expect(r.conflicts).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("does nothing when there is neither a vote nor a declared hint", () => {
    const r = validateChange(withHints([]), "new.ts", THEN_BODY);
    expect(r.conflicts).toEqual([]); // no baseline signal → cannot judge
    expect(r.ok).toBe(true);
  });
});

describe("validateChange — return-shape + data-access single-body classifiers", () => {
  // The exact draft that slipped through the demo: throws (repo uses sentinels)
  // AND raw SQL / direct db (repo declares ORM).
  const DEMO_DRAFT =
    'export function loadThing(id){ const r = db.query("select * from things"); if(!r) throw new Error("x"); return r; }';
  // Conforming on both axes for an ORM + sentinel repo.
  const CONFORMING =
    "export async function loadThing(id){ const r = await Thing.findOne({ where: { id } }); if(!r) return null; return r; }";

  function base(
    perCategoryVote: RepoDriftBaseline["perCategoryVote"],
    intentHints: RepoDriftBaseline["intentHints"] = [],
  ): RepoDriftBaseline {
    return { key: "k", rootDir: "/r", ctxFiles: [{ path: "x.ts", hash: "h" }], perCategoryVote, intentHints, minhashIndex: [], builtAt: 0 };
  }
  const SENTINEL_VOTE: RepoDriftBaseline["perCategoryVote"] = {
    return_shape_consistency: {
      driftCategory: "return_shape_consistency",
      dominantPattern: "null/undefined sentinels",
      dominantCount: 19,
      totalRelevantFiles: 22,
      consistencyScore: 86,
      dominantFiles: ["app/components/ActionButton.tsx"],
      deviators: [],
    },
  };
  const ORM_HINT = {
    category: "architectural_consistency" as const,
    pattern: "orm",
    label: "ORM methods",
    source: "CLAUDE.md",
    line: 8,
    text: "Use Sequelize models in server/models/",
    confidence: 0.7,
  };

  it("flags a throw when the repo's dominant return-shape is null/undefined sentinels", () => {
    const r = validateChange(base(SENTINEL_VOTE), "new.ts", DEMO_DRAFT);
    const c = r.conflicts.find((x) => x.dimension === "return_shape_consistency");
    expect(c, "expected a return-shape conflict").toBeTruthy();
    expect(c!.dominantPattern).toBe("null/undefined sentinels");
    expect(c!.yourPattern).toBe("throws on error");
  });

  it("flags raw SQL / direct db when the repo DECLARES ORM methods", () => {
    const r = validateChange(base({}, [ORM_HINT]), "new.ts", DEMO_DRAFT);
    const c = r.conflicts.find((x) => x.dimension === "architectural_consistency");
    expect(c, "expected a data-access conflict").toBeTruthy();
    expect(c!.dominantPattern).toBe("ORM methods");
    expect(["raw SQL queries", "direct database calls"]).toContain(c!.yourPattern);
  });

  it("catches the demo draft on BOTH axes at once (throw + raw SQL)", () => {
    const r = validateChange(base(SENTINEL_VOTE, [ORM_HINT]), "new.ts", DEMO_DRAFT);
    expect(r.ok).toBe(false);
    const dims = r.conflicts.map((c) => c.dimension);
    expect(dims).toContain("return_shape_consistency");
    expect(dims).toContain("architectural_consistency");
  });

  it("does NOT flag a conforming function (ORM + null sentinel)", () => {
    const r = validateChange(base(SENTINEL_VOTE, [ORM_HINT]), "new.ts", CONFORMING);
    expect(r.conflicts).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("does not false-positive on a function with no data access or error path", () => {
    const r = validateChange(base(SENTINEL_VOTE, [ORM_HINT]), "new.ts", "export function add(a, b){ return a + b; }");
    expect(r.conflicts).toEqual([]);
  });
});

describe("validate_change (integration)", () => {
  let repo: string;
  let dom: string | undefined;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "vd-validate-"));
    // 4 async/await files + 1 .then -> async detector fires, dominant async_await
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(repo, `aw${i}.ts`), `export async function aw${i}(){\n  const a = await x${i}();\n  const b = await y${i}();\n  return a + b;\n}\n`);
    }
    writeFileSync(join(repo, "then0.ts"), "export function then0(){\n  return a()\n    .then(r => r)\n    .then(s => s);\n}\n");
    const built = await buildBaseline(repo);
    await writeBaseline(built);
    dom = built.perCategoryVote.async_patterns?.dominantPattern;
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  beforeEach(() => __clearBaselineCache());

  it("detects an async conflict for a .then() change against an async/await repo", async () => {
    expect(dom, "fixture should establish an async/await dominant").toBe("async/await");
    const out = await run({ rootDir: repo, targetPath: join(repo, "feature.ts"), body: THEN_BODY });
    expect(["ok", "stale"]).toContain(out.status);
    expect(out.ok).toBe(false);
    expect(out.conflicts.some((c) => c.dimension === "async_patterns")).toBe(true);
  });

  it("returns no_baseline for an unscanned dir", async () => {
    const empty = mkdtempSync(join(tmpdir(), "vd-empty-vc-"));
    try {
      const out = await run({ rootDir: empty, targetPath: join(empty, "x.ts"), body: AWAIT_BODY });
      expect(out.status).toBe("no_baseline");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("deep:true merges cloud findings, flips ok=false, status=partial", async () => {
    (deepAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue({
      degraded: false,
      intentMismatches: [{ kind: "intent", detail: "getInvoices", confidence: 0.92, verdict: "confirmed" }],
      duplicates: [],
    });
    const out = await run({ rootDir: repo, targetPath: join(repo, "feature.ts"), body: AWAIT_BODY, deep: true });
    expect(out.deep?.intentMismatches).toHaveLength(1);
    expect(out.ok).toBe(false);
    expect(out.status).toBe("partial");
  });

  it("deep:true degrades gracefully (status=degraded) without throwing on quota", async () => {
    (deepAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue({
      degraded: true, reason: "quota", intentMismatches: [], duplicates: [],
    });
    const out = await run({ rootDir: repo, targetPath: join(repo, "feature.ts"), body: AWAIT_BODY, deep: true });
    expect(out.status).toBe("degraded");
    expect(out.message).toMatch(/credits/i);
    expect(out.deep?.degraded).toBe(true);
  });

  it("without deep, never calls the cloud", async () => {
    (deepAnalyze as ReturnType<typeof vi.fn>).mockClear();
    await run({ rootDir: repo, targetPath: join(repo, "feature.ts"), body: AWAIT_BODY });
    expect(deepAnalyze).not.toHaveBeenCalled();
  });
});
