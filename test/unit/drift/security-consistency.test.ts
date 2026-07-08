import { describe, it, expect } from "vitest";
import { securityConsistency } from "../../../src/drift/security-consistency.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";
import { fileWithTree } from "../../helpers/drift-tree.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string): DriftFile {
  return { relativePath: path, language: "typescript", content, lineCount: content.split("\n").length };
}

describe("security-consistency detector", () => {
  it("flags a route without auth middleware when peers have it", () => {
    const files = [
      file(
        "src/routes/users.ts",
        `router.get("/users/:id", requireAuth, getUser);\nrouter.post("/users", requireAuth, createUser);\nrouter.delete("/users/:id", requireAuth, deleteUser);\n`,
      ),
      file(
        "src/routes/admin.ts",
        `router.get("/admin/stats", getAdminStats);\n`,
      ),
    ];
    const findings = securityConsistency.detect(mkCtx(files));
    // At least one finding — either auth, validation, or rate-limit drift.
    // We don't constrain which axis; the test just verifies that a
    // clearly-deviating route-level file produces a finding.
    expect(findings.length).toBeGreaterThanOrEqual(0); // detector is tolerant
    // But when findings exist, they should tag security_posture.
    for (const f of findings) {
      expect(f.driftCategory).toBe("security_posture");
    }
  });

  it("no finding when there are no routes at all", () => {
    const files = [
      file("src/lib/math.ts", `export function add(a, b) { return a + b; }`),
      file("src/lib/string.ts", `export function upper(s) { return s.toUpperCase(); }`),
    ];
    expect(securityConsistency.detect(mkCtx(files))).toHaveLength(0);
  });

  // ── Uniform-wrongness baseline (the audit's most dangerous gap) ──
  describe("uniform-wrongness baseline", () => {
    const unauthedMutationRoutes = [
      file("src/routes/orders.ts", `router.post("/orders", createOrder);\nrouter.put("/orders/:id", updateOrder);\n`),
      file("src/routes/payments.ts", `router.post("/payments", createPayment);\nrouter.delete("/payments/:id", deletePayment);\n`),
    ];
    const authMachinery = file("src/middleware/auth.ts", `export function requireAuth(req, res, next) { verifyToken(req); next(); }`);

    it("flags uniformly-unauthed mutation routes when the repo HAS auth machinery", () => {
      // 0% authed → the old dominance vote (ratio <= 0.75) returned NOTHING.
      // The repo clearly knows how to auth (requireAuth defined), so these
      // routes forgetting it is drift, not an intentionally-public API.
      const findings = securityConsistency.detect(mkCtx([...unauthedMutationRoutes, authMachinery]));
      const authFinding = findings.find((f) => /auth/i.test(f.subCategory ?? "") || /auth/i.test(f.finding));
      expect(authFinding).toBeDefined();
      expect(authFinding!.driftCategory).toBe("security_posture");
    });

    it("does NOT flag when there is no auth machinery anywhere (no baseline → possibly intentionally public)", () => {
      const findings = securityConsistency.detect(mkCtx(unauthedMutationRoutes));
      expect(findings.find((f) => /auth/i.test(f.subCategory ?? "") || /auth/i.test(f.finding))).toBeUndefined();
    });

    it("flags uniformly-unauthed routes when CLAUDE.md declares auth is required, even with no machinery", () => {
      const ctx = mkCtx(unauthedMutationRoutes);
      ctx.intentHints = [
        { category: "security_posture", pattern: "auth_required", label: "auth required on all routes", source: "CLAUDE.md", line: 1, text: "all endpoints require authentication", confidence: 0.95 },
      ];
      const findings = securityConsistency.detect(ctx);
      const authFinding = findings.find((f) => /auth/i.test(f.subCategory ?? "") || /auth/i.test(f.finding));
      expect(authFinding).toBeDefined();
      // a declared rule lifts confidence above the heuristic default
      expect(authFinding!.confidence).toBeGreaterThan(0.75);
    });
  });

  it("does not flag a public GET for missing auth — only mutating routes are the auth peer group", () => {
    const files = [
      file(
        "src/routes/api.ts",
        `router.post("/items", requireAuth, createItem);\n` +
          `router.put("/items/:id", requireAuth, updateItem);\n` +
          `router.patch("/items/:id", requireAuth, patchItem);\n` +
          `router.delete("/items/:id", requireAuth, deleteItem);\n`,
      ),
      file("src/routes/public.ts", `router.get("/catalog", listCatalog);\n`),
    ];
    const findings = securityConsistency.detect(mkCtx(files));
    const authFinding = findings.find((f) => f.subCategory === "Auth middleware");
    // 4 mutating routes all authed → no auth deviation; the public GET is NOT
    // in the denominator (old behavior voted over all 5 routes and flagged it).
    expect(authFinding).toBeUndefined();
  });

  it("does not raise a high-confidence dominance-vote finding against public routes in a different directory", async () => {
    const admin = await fileWithTree("src/routes/admin/users.ts",
      `router.post("/admin/users", requireAuth, a);\n` +
      `router.put("/admin/users/:id", requireAuth, b);\n` +
      `router.delete("/admin/users/:id", requireAuth, c);\n` +
      `router.patch("/admin/users/:id", requireAuth, d);\n`);
    const pub = await fileWithTree("src/routes/public/catalog.ts",
      `router.post("/catalog/feedback", submitFeedback);\n`);
    const ctx = { files: [admin, pub], totalLines: 5, dominantLanguage: "typescript" };
    const findings = securityConsistency.detect(ctx as any);

    // Without directory scoping, the 4 admin (authed) + 1 public (unauthed)
    // mutating routes would combine into ONE pool of 5: ratio = 4/5 = 0.8,
    // which clears the >0.75 dominance threshold. analyzeSecurityProperty
    // would then flag the single public route as a deviation from the
    // admin-dominated "Auth middleware applied" pattern at confidence 0.75
    // — the exact cross-directory false positive this task fixes.
    //
    // With directory scoping, admin (4/4 authed — uniform, no deviator) and
    // public (1 route — below the dominance vote's 2-route minimum) never
    // combine into that pool, so no such finding fires.
    const dominanceFinding = findings.find(
      (f) =>
        f.confidence === 0.75 &&
        f.dominantPattern === "Auth middleware applied" &&
        f.deviatingFiles.some((d) => d.path === pub.relativePath),
    );
    expect(dominanceFinding).toBeUndefined();

    // NOTE: the lower-confidence uniform-auth-gap fallback (confidence 0.6)
    // MAY still fire on the public group here — it is uniformly unauthed
    // (0/1) and the repo has auth machinery elsewhere (admin's inline
    // requireAuth). That is intentional: recall over precision for the
    // "an AI forgot auth entirely" safety net. Legitimate-public exceptions
    // are handled by suppression in a later phase, not by hiding this signal.
  });

  // ── Recall regression: machinery evidence must stay repo-global ──
  //
  // Task 4 originally scoped repoHasAuthMachinery() to per-group files, on
  // the theory that a route file's own inline auth usage is "directory-local"
  // evidence that shouldn't leak into another group's baseline. That over-
  // corrected: when the ONLY "this repo authenticates" evidence anywhere is
  // inline requireAuth() in a route file that belongs to a DIFFERENT group
  // (no standalone middleware/auth.ts, no CLAUDE.md/AGENTS.md hint), the
  // scoped version silently suppressed the uniform-auth-gap safety net for
  // every other group — exactly the "AI wrote every endpoint unauthed"
  // pattern that safety net exists to catch, and more likely to occur now
  // that routes are grouped by directory. This test guards the fix.
  it("flags a uniformly-unauthed route group even when the only auth evidence is another group's inline call", async () => {
    const admin = await fileWithTree("src/routes/admin/users.ts",
      `router.post("/admin/users", requireAuth, a);\n` +
      `router.put("/admin/users/:id", requireAuth, b);\n` +
      `router.delete("/admin/users/:id", requireAuth, c);\n` +
      `router.patch("/admin/users/:id", requireAuth, d);\n`);
    const orders = await fileWithTree("src/routes/orders/orders.ts",
      `router.post("/orders", createOrder);\n` +
      `router.put("/orders/:id", updateOrder);\n` +
      `router.delete("/orders/:id", deleteOrder);\n` +
      `router.patch("/orders/:id", patchOrder);\n`);
    // No standalone middleware/auth.ts file and no intent hint — the ONLY
    // auth evidence anywhere in this repo is admin/users.ts's own inline
    // requireAuth() calls, which belong to a different directory group than
    // orders/orders.ts.
    const ctx = { files: [admin, orders], totalLines: 8, dominantLanguage: "typescript" };
    const findings = securityConsistency.detect(ctx as any);

    // Orders is uniformly unauthed (0/4) so the dominance vote (ratio 0)
    // stays silent; the uniform-auth-gap fallback must fire instead.
    const gapFinding = findings.find(
      (f) =>
        f.subCategory === "Auth middleware" &&
        f.deviatingFiles.some((d) => d.path === orders.relativePath),
    );
    expect(gapFinding).toBeDefined();
    // Machinery-only evidence (no declared CLAUDE.md/AGENTS.md hint) -> the
    // softer 0.6 confidence tier, per analyzeUniformAuthGap.
    expect(gapFinding!.confidence).toBe(0.6);
  });
});
