import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRouteAuth } from "../../../../src/drift/route-auth-classify.js";

// The deep path (unused here, but run() imports it) is stubbed so nothing hits
// the network if a stray deep:true ever reaches it.
vi.mock("../../../../src/mcp/deep-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/mcp/deep-client.js")>();
  return { ...actual, deepAnalyze: vi.fn() };
});
vi.mock("../../../../src/mcp/deep-index.js", () => ({ deepDuplicatesViaIndex: vi.fn() }));

import { checkRouteAuthDrift, run } from "../../../../src/mcp/tools/validate-change.js";
import { buildBaseline, writeBaseline, type RepoDriftBaseline } from "../../../../src/core/baseline.js";
import { __clearBaselineCache } from "../../../../src/mcp/baseline-provider.js";
import { deepDuplicatesViaIndex } from "../../../../src/mcp/deep-index.js";

// ── Shared classifier ───────────────────────────────────────────────────────
// classifyRouteAuth reuses the SAME AST route extractor the batch security
// detector uses, so its verdict can never contradict the batch detector for the
// same body (Task 7 asserts that agreement across fixtures).
describe("classifyRouteAuth", () => {
  it("flags a mutating route with no visible auth guard", async () => {
    const r = await classifyRouteAuth('router.post("/x", (req, res) => { res.json({}); });', "a.ts");
    expect(r).toEqual({ isMutatingRoute: true, hasVisibleAuth: false });
  });

  it("reports a visible auth guard on a mutating route", async () => {
    const r = await classifyRouteAuth('router.post("/x", requireAuth, (req, res) => { res.json({}); });', "a.ts");
    expect(r).toEqual({ isMutatingRoute: true, hasVisibleAuth: true });
  });

  it("is conservative: a partly guarded body (one mutating route unguarded) is hasVisibleAuth:false", async () => {
    const body = [
      'router.post("/a", requireAuth, (req, res) => { res.json({}); });',
      'router.delete("/b", (req, res) => { res.json({}); });',
    ].join("\n");
    const r = await classifyRouteAuth(body, "a.ts");
    expect(r).toEqual({ isMutatingRoute: true, hasVisibleAuth: false });
  });

  it("returns a non-mutating verdict for a read-only (GET) route body", async () => {
    const r = await classifyRouteAuth('router.get("/x", (req, res) => { res.json({}); });', "a.ts");
    expect(r).toEqual({ isMutatingRoute: false, hasVisibleAuth: true });
  });

  it("returns null for a body with no route at all", async () => {
    const r = await classifyRouteAuth("export function add(a, b) { return a + b; }", "a.ts");
    expect(r).toBeNull();
  });

  it("returns null for a non JS/TS language (Python)", async () => {
    const r = await classifyRouteAuth('@app.post("/x")\ndef handler():\n    return {}', "a.py");
    expect(r).toBeNull();
  });
});

// ── Security path (checkRouteAuthDrift) ──────────────────────────────────────
// Pure-ish: takes a hand-built baseline so every branch is deterministic and
// offline. Emits a Conflict only when the proposed body has a mutating route
// with no visible guard AND the repo's own convention (vote or declared hint)
// is to apply auth. Otherwise honest silence (null).
const UNAUTHED_POST = 'router.post("/x", (req, res) => { res.json({}); });';
const GUARDED_POST = 'router.post("/x", requireAuth, (req, res) => { res.json({}); });';
// Task B1: Express .all() is a mutating method (it handles every verb), so an
// unauthed .all() route must be caught by the same in-loop classifier as
// .post()/.put()/.patch()/.delete(). It previously was not.
const UNAUTHED_ALL = 'router.all("/orders", (req, res) => { res.json({}); });';
const PLAIN_FN = "export function add(a, b) { return a + b; }";
const PY_ROUTE = '@app.post("/x")\ndef handler():\n    return {}';

function baseWith(
  securitySubVotes: RepoDriftBaseline["securitySubVotes"],
  intentHints: RepoDriftBaseline["intentHints"] = [],
): RepoDriftBaseline {
  return {
    key: "k",
    rootDir: "/r",
    ctxFiles: [{ path: "x.ts", hash: "h" }],
    perCategoryVote: {},
    securitySubVotes,
    intentHints,
    minhashIndex: [],
    builtAt: 0,
  };
}

const AUTH_APPLIED_VOTE: RepoDriftBaseline["securitySubVotes"] = {
  "Auth middleware": {
    driftCategory: "security_posture",
    dominantPattern: "Auth middleware applied",
    dominantCount: 8,
    totalRelevantFiles: 9,
    consistencyScore: 89,
    dominantFiles: ["routes/users.ts"],
    deviators: [],
  },
};

const AUTH_REQUIRED_HINT = {
  category: "security_posture" as const,
  pattern: "auth_required",
  label: "auth required on all routes",
  source: "CLAUDE.md",
  line: 42,
  text: "all routes require auth",
  confidence: 0.9,
};

describe("checkRouteAuthDrift", () => {
  it("emits a low-confidence conflict for an unauthed mutating route vs an 'Auth middleware' vote", async () => {
    const c = await checkRouteAuthDrift(baseWith(AUTH_APPLIED_VOTE), UNAUTHED_POST, "new.ts");
    expect(c).not.toBeNull();
    expect(c!.dimension).toBe("security_posture");
    expect(c!.dominantPattern).toBe("Auth middleware applied");
    expect(c!.yourPattern).toBe("no auth guard visible in this change");
    expect(c!.fixHint).toContain("8 of 9");
    expect(c!.fixHint).toContain("router-level middleware is not visible");
    // Honest phrasing: no em-dashes or double hyphens anywhere in the message.
    expect(c!.fixHint).not.toMatch(/—|--/);
  });

  it("cites the declaration when there is no vote but an auth_required hint exists", async () => {
    const c = await checkRouteAuthDrift(baseWith({}, [AUTH_REQUIRED_HINT]), UNAUTHED_POST, "new.ts");
    expect(c).not.toBeNull();
    expect(c!.dimension).toBe("security_posture");
    expect(c!.dominantPattern).toBe("Auth middleware applied");
    expect(c!.yourPattern).toBe("no auth guard visible in this change");
    expect(c!.fixHint).toContain("CLAUDE.md:42");
    expect(c!.fixHint).not.toMatch(/—|--/);
  });

  it("stays silent when there is neither a vote nor an auth hint (healthy 100%-authed repo)", async () => {
    const c = await checkRouteAuthDrift(baseWith({}, []), UNAUTHED_POST, "new.ts");
    expect(c).toBeNull();
  });

  it("does not flag a guarded mutating route even with an auth vote", async () => {
    const c = await checkRouteAuthDrift(baseWith(AUTH_APPLIED_VOTE), GUARDED_POST, "new.ts");
    expect(c).toBeNull();
  });

  it("emits a low-confidence conflict for an unauthed Express .all() route vs an 'Auth middleware' vote (Task B1)", async () => {
    const c = await checkRouteAuthDrift(baseWith(AUTH_APPLIED_VOTE), UNAUTHED_ALL, "new.ts");
    expect(c).not.toBeNull();
    expect(c!.dimension).toBe("security_posture");
    expect(c!.dominantPattern).toBe("Auth middleware applied");
    expect(c!.yourPattern).toBe("no auth guard visible in this change");
    expect(c!.fixHint).toContain("8 of 9");
  });

  it("does not flag a non-route body", async () => {
    const c = await checkRouteAuthDrift(baseWith(AUTH_APPLIED_VOTE), PLAIN_FN, "new.ts");
    expect(c).toBeNull();
  });

  it("does not flag a Python body (JS/TS-only gate)", async () => {
    const c = await checkRouteAuthDrift(baseWith(AUTH_APPLIED_VOTE), PY_ROUTE, "new.py");
    expect(c).toBeNull();
  });

  it("stays silent when the auth vote is not the applied-majority signal and no hint is declared", async () => {
    // Uniformly-unauthed baseline w/ machinery stores dominantPattern
    // "auth on mutating routes" (aspirational), not "Auth middleware applied".
    // Without a declared rule, the in-loop check has no truthful count to cite.
    const machineryVote: RepoDriftBaseline["securitySubVotes"] = {
      "Auth middleware": {
        driftCategory: "security_posture",
        dominantPattern: "auth on mutating routes",
        dominantCount: 0,
        totalRelevantFiles: 3,
        consistencyScore: 0,
        dominantFiles: [],
        deviators: [],
      },
    };
    const c = await checkRouteAuthDrift(baseWith(machineryVote), UNAUTHED_POST, "new.ts");
    expect(c).toBeNull();
  });
});

// ── run() wiring (real baseline) ─────────────────────────────────────────────
// Proves the check is appended to the result in the async run() wrapper: ok
// flips false, confidence is forced low, and the security conflict is present.
// The baseline is built from a real repo whose auth sub-vote is "Auth middleware
// applied", so this doubles as a no-disagreement smoke test against the batch
// extractor.
describe("validate_change security check (run wiring)", () => {
  let repo: string;
  let authVote: string | undefined;
  let authVoteFiles: string[] | undefined;
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), "vd-vc-sec-"));
    mkdirSync(join(repo, "routes"), { recursive: true });
    // 4 guarded + 1 unguarded mutating route → ratio 0.8 > 0.75 → the security
    // detector votes "Auth middleware applied" (dominantCount 4 of 5).
    writeFileSync(
      join(repo, "routes", "api.ts"),
      [
        'router.post("/a", requireAuth, (req, res) => { res.json({}); });',
        'router.put("/b", requireAuth, (req, res) => { res.json({}); });',
        'router.patch("/c", requireAuth, (req, res) => { res.json({}); });',
        'router.delete("/d", requireAuth, (req, res) => { res.json({}); });',
        'router.post("/e", (req, res) => { res.json({}); });',
        "",
      ].join("\n"),
    );
    const built = await buildBaseline(repo);
    await writeBaseline(built);
    authVote = built.securitySubVotes?.["Auth middleware"]?.dominantPattern;
    authVoteFiles = built.securitySubVotes?.["Auth middleware"]?.dominantFiles;
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  beforeEach(() => __clearBaselineCache());

  it("fixture establishes an 'Auth middleware applied' vote", () => {
    expect(authVote).toBe("Auth middleware applied");
  });

  it("appends a low-confidence security conflict for an unauthed mutating route change, with referenceFiles from the vote", async () => {
    const out = await run({ rootDir: repo, targetPath: join(repo, "routes", "new.ts"), body: UNAUTHED_POST });
    expect(["ok", "stale"]).toContain(out.status);
    expect(out.ok).toBe(false);
    expect(out.confidence).toBe("low");
    const sec = out.conflicts.find((c) => c.dimension === "security_posture");
    expect(sec, "expected a security_posture conflict").toBeTruthy();
    expect(sec!.yourPattern).toBe("no auth guard visible in this change");
    // FINDING 2: the auth conflict is the only conflict, so validateChange's own
    // referenceFiles computation never runs. run() must backfill it from the
    // SAME auth vote the fixHint already cites (dominantFiles, capped at 3).
    expect(authVoteFiles?.length, "fixture vote should carry dominantFiles").toBeGreaterThan(0);
    expect(out.referenceFiles).toEqual((authVoteFiles ?? []).slice(0, 3));
  });

  it("does not append a security conflict for a guarded route change", async () => {
    const out = await run({ rootDir: repo, targetPath: join(repo, "routes", "new.ts"), body: GUARDED_POST });
    expect(out.conflicts.some((c) => c.dimension === "security_posture")).toBe(false);
  });

  // ── FINDING 1: deep path must never override the security-forced low
  // confidence ────────────────────────────────────────────────────────────────
  // The auth conflict's own fixHint says "this is a hint, not a verdict"
  // because router-level middleware is invisible to the in-loop check. A cloud
  // deep hit is genuinely high-confidence on ITS OWN finding, but must not
  // launder the hedged auth conflict up to confidence:"high" just because it
  // rode along in the same result.
  describe("deep path vs. the security-forced low confidence", () => {
    beforeEach(() => {
      (deepDuplicatesViaIndex as ReturnType<typeof vi.fn>).mockReset();
    });

    it("a deep hit does NOT override confidence when an auth conflict also fired", async () => {
      (deepDuplicatesViaIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        degraded: false,
        intentMismatches: [],
        duplicates: [
          { kind: "duplicate", detail: "new.ts::x ~ a.ts::twin", confidence: 0.93, verdict: "semantic_duplicate" },
        ],
      });
      const out = await run({
        rootDir: repo,
        targetPath: join(repo, "routes", "new.ts"),
        body: UNAUTHED_POST,
        deep: true,
      });
      // The deep hit genuinely fired (proves this isn't a vacuous test)...
      expect(out.deep?.duplicates).toHaveLength(1);
      const sec = out.conflicts.find((c) => c.dimension === "security_posture");
      expect(sec, "expected a security_posture conflict").toBeTruthy();
      // ...but the auth conflict's hedge still wins at the result level.
      expect(out.confidence).toBe("low");
    });

    it("a deep hit DOES set confidence high when there is no auth conflict (regression)", async () => {
      (deepDuplicatesViaIndex as ReturnType<typeof vi.fn>).mockResolvedValue({
        degraded: false,
        intentMismatches: [],
        duplicates: [
          { kind: "duplicate", detail: "new.ts::x ~ a.ts::twin", confidence: 0.93, verdict: "semantic_duplicate" },
        ],
      });
      const out = await run({
        rootDir: repo,
        targetPath: join(repo, "routes", "new.ts"),
        body: GUARDED_POST,
        deep: true,
      });
      expect(out.deep?.duplicates).toHaveLength(1);
      expect(out.conflicts.some((c) => c.dimension === "security_posture")).toBe(false);
      expect(out.confidence).toBe("high");
    });
  });
});
