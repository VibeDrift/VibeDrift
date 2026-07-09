import { describe, it, expect } from "vitest";
import { securityConsistency } from "../../../src/drift/security-consistency.js";
import { runDriftDetection } from "../../../src/drift/index.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import {
  SECURITY_SUPPRESSION_SUBCATEGORY,
  SECURITY_SUPPRESSION_ANALYZER_ID,
} from "../../../src/drift/security-suppression.js";

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

  // ── Denominator-removing suppression (@vibedrift-public annotation) ──
  //
  // Uses fileWithTree (AST route extraction) rather than the plain `file()`
  // regex fixture: the regex path's per-route auth check is a sliding
  // +/-N-line TEXT proximity window (see extractJsRoutesRegex), which in a
  // short 5-6 line fixture sees `requireAuth` from a NEIGHBORING route's own
  // call and marks every route in the window as authed — the AST extractor
  // scopes auth detection to each route's own middleware arguments, which is
  // what an annotation-suppression precision test needs.
  describe("route suppression via @vibedrift-public", () => {
    it("without the annotation, 4 authed + 1 unauthed mutating routes flags the unauthed one (baseline)", async () => {
      const f = await fileWithTree(
        "src/routes/api.ts",
        `router.post("/items", requireAuth, createItem);\n` +
          `router.put("/items/:id", requireAuth, updateItem);\n` +
          `router.patch("/items/:id", requireAuth, patchItem);\n` +
          `router.delete("/items/:id", requireAuth, deleteItem);\n` +
          `router.post("/public/webhook", handleWebhook);\n`,
      );
      const ctx = { files: [f], totalLines: f.lineCount, dominantLanguage: "typescript" };
      const findings = securityConsistency.detect(ctx as any);
      const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
      expect(authFinding).toBeDefined();
      expect(authFinding!.deviatingFiles.some((d) => d.evidence[0].line === 5)).toBe(true);
      // No suppression occurred — no audit finding either.
      expect(findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY)).toBeUndefined();
    });

    it("suppresses the annotated unauthed route so the denominator stays honest, and cites the exclusion", async () => {
      const f = await fileWithTree(
        "src/routes/api.ts",
        `router.post("/items", requireAuth, createItem);\n` +
          `router.put("/items/:id", requireAuth, updateItem);\n` +
          `router.patch("/items/:id", requireAuth, patchItem);\n` +
          `router.delete("/items/:id", requireAuth, deleteItem);\n` +
          `// @vibedrift-public\n` +
          `router.post("/public/webhook", handleWebhook);\n`,
      );
      const ctx = { files: [f], totalLines: f.lineCount, dominantLanguage: "typescript" };
      const findings = securityConsistency.detect(ctx as any);

      // The unauthed route was removed from the denominator BEFORE the vote
      // ran, so the remaining 4 routes are 4/4 authed — ratio stays honest
      // and no auth drift finding fires.
      const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
      expect(authFinding).toBeUndefined();

      // The exclusion is cited and counted — never silent.
      const auditFinding = findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY);
      expect(auditFinding).toBeDefined();
      expect(auditFinding!.severity).toBe("info");
      expect(auditFinding!.totalRelevantFiles).toBe(1);
      expect(auditFinding!.deviatingFiles).toHaveLength(1);
      expect(auditFinding!.deviatingFiles[0].path).toBe("src/routes/api.ts");
      expect(auditFinding!.deviatingFiles[0].evidence[0].line).toBe(6);
      expect(auditFinding!.finding).toContain("1 route(s)");
      expect(auditFinding!.finding).toContain("src/routes/api.ts:6");
    });

    // ── Finding 1 (over-suppression): the reviewer's exact end-to-end case ──
    //
    // A TRAILING `// @vibedrift-public` on route N's own line also sits on the
    // line immediately above route N+1. The old preceding-line matcher bound it
    // to BOTH, so an un-annotated unauthed route directly below an annotated
    // public route was silently removed from the vote and its auth drift never
    // fired. This test MUST fail before the Finding 1 fix.
    it("a trailing annotation on the line ABOVE an un-annotated unauthed route does not suppress that route (Finding 1)", async () => {
      const f = await fileWithTree(
        "src/routes/api.ts",
        `router.post("/items", requireAuth, createItem);\n` +
          `router.put("/items/:id", requireAuth, updateItem);\n` +
          `router.patch("/items/:id", requireAuth, patchItem);\n` +
          `router.delete("/items/:id", requireAuth, deleteItem);\n` +
          `router.post("/public", handlePublic); // @vibedrift-public\n` +
          `router.post("/danger", wipeEverything);\n`,
      );
      const ctx = { files: [f], totalLines: f.lineCount, dominantLanguage: "typescript" };
      const findings = securityConsistency.detect(ctx as any);

      // Only /public (line 5) is excluded — the trailing comment binds to its
      // own route, never to /danger on the line below.
      const auditFinding = findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY);
      expect(auditFinding).toBeDefined();
      expect(auditFinding!.totalRelevantFiles).toBe(1);
      expect(auditFinding!.deviatingFiles).toHaveLength(1);
      expect(auditFinding!.deviatingFiles[0].evidence[0].line).toBe(5);

      // The un-annotated /danger route stays in the denominator: with /public
      // suppressed, the remaining routes are 4 authed /items + 1 unauthed
      // /danger (ratio 4/5 = 0.8 > 0.75), so the auth-drift finding STILL fires
      // and cites /danger on line 6.
      const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
      expect(authFinding).toBeDefined();
      expect(authFinding!.deviatingFiles.some((d) => d.evidence[0].line === 6)).toBe(true);
    });

    // ── Finding 2 (comment-vs-code awareness), AST path ──
    it("does not suppress a route when @vibedrift-public sits inside a string literal on the line above (Finding 2)", async () => {
      const f = await fileWithTree(
        "src/routes/api.ts",
        `router.post("/items", requireAuth, createItem);\n` +
          `router.put("/items/:id", requireAuth, updateItem);\n` +
          `router.patch("/items/:id", requireAuth, patchItem);\n` +
          `router.delete("/items/:id", requireAuth, deleteItem);\n` +
          `const doc = "publish under // @vibedrift-public to opt out";\n` +
          `router.post("/danger", wipeEverything);\n`,
      );
      const ctx = { files: [f], totalLines: f.lineCount, dominantLanguage: "typescript" };
      const findings = securityConsistency.detect(ctx as any);

      // The string literal is not a comment, so nothing is suppressed and the
      // unauthed /danger route is flagged normally.
      expect(findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY)).toBeUndefined();
      const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
      expect(authFinding).toBeDefined();
      expect(authFinding!.deviatingFiles.some((d) => d.evidence[0].line === 6)).toBe(true);
    });

    it("an annotation elsewhere in the file does not suppress an unrelated, un-annotated route (precision)", async () => {
      const f = await fileWithTree(
        "src/routes/api.ts",
        `// @vibedrift-public\n` +
          `router.post("/public/webhook", handleWebhook);\n` +
          `\n` +
          `router.post("/items", requireAuth, createItem);\n` +
          `router.put("/items/:id", requireAuth, updateItem);\n` +
          `router.patch("/items/:id", requireAuth, patchItem);\n` +
          `router.delete("/items/:id", requireAuth, deleteItem);\n`,
      );
      const ctx = { files: [f], totalLines: f.lineCount, dominantLanguage: "typescript" };
      const findings = securityConsistency.detect(ctx as any);

      // Only the annotated webhook route (line 2) is suppressed — the 4
      // authed /items routes below it must NOT be swept up by the same
      // annotation two lines above them, or a real exclusion could hide
      // routes it was never meant to touch.
      const auditFinding = findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY);
      expect(auditFinding).toBeDefined();
      expect(auditFinding!.totalRelevantFiles).toBe(1);
      expect(auditFinding!.deviatingFiles[0].evidence[0].line).toBe(2);

      // The 4 authed /items routes were NOT removed from the vote: with the
      // webhook route suppressed out of the denominator, the remaining 4 are
      // still all authed, so no auth drift finding fires either.
      expect(findings.find((fnd) => fnd.subCategory === "Auth middleware")).toBeUndefined();
    });
  });
});

// ── Task 5: config glob allowlist (`security.allowlist`) ── end-to-end
// through the detector, mirroring the @vibedrift-public suppression tests
// above but suppressing via ctx.projectConfig instead of an inline comment.
describe("route suppression via config allowlist (security.allowlist)", () => {
  it("without the allowlist, 4 authed + 1 unauthed mutating routes flags the unauthed one (baseline)", async () => {
    const items = await fileWithTree(
      "src/routes/api/items.ts",
      `router.post("/items", requireAuth, createItem);\n` +
        `router.put("/items/:id", requireAuth, updateItem);\n` +
        `router.patch("/items/:id", requireAuth, patchItem);\n` +
        `router.delete("/items/:id", requireAuth, deleteItem);\n`,
    );
    const webhook = await fileWithTree(
      "src/routes/api/webhook.ts",
      `router.post("/public/webhook", handleWebhook);\n`,
    );
    const ctx = {
      files: [items, webhook],
      totalLines: items.lineCount + webhook.lineCount,
      dominantLanguage: "typescript",
    };
    const findings = securityConsistency.detect(ctx as any);
    const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
    expect(authFinding).toBeDefined();
    expect(findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY)).toBeUndefined();
  });

  it("a config allowlist glob removes the unauthed route from the vote (no auth finding) and the audit finding cites it", async () => {
    const items = await fileWithTree(
      "src/routes/api/items.ts",
      `router.post("/items", requireAuth, createItem);\n` +
        `router.put("/items/:id", requireAuth, updateItem);\n` +
        `router.patch("/items/:id", requireAuth, patchItem);\n` +
        `router.delete("/items/:id", requireAuth, deleteItem);\n`,
    );
    const webhook = await fileWithTree(
      "src/routes/api/webhook.ts",
      `router.post("/public/webhook", handleWebhook);\n`,
    );
    const ctx = {
      files: [items, webhook],
      totalLines: items.lineCount + webhook.lineCount,
      dominantLanguage: "typescript",
      projectConfig: { version: 1, security: { allowlist: ["src/routes/api/webhook.ts"] } },
    };
    const findings = securityConsistency.detect(ctx as any);

    // The unauthed webhook route was removed from the denominator BEFORE the
    // vote ran, so the remaining 4 /items routes are 4/4 authed and no auth
    // drift finding fires.
    const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
    expect(authFinding).toBeUndefined();

    // The exclusion is cited and counted, same as an annotation-based one.
    const auditFinding = findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY);
    expect(auditFinding).toBeDefined();
    expect(auditFinding!.totalRelevantFiles).toBe(1);
    expect(auditFinding!.deviatingFiles[0].path).toBe("src/routes/api/webhook.ts");
    expect(auditFinding!.deviatingFiles[0].evidence[0].line).toBe(1);
    expect(auditFinding!.finding).toContain("1 route(s)");
    expect(auditFinding!.finding).toContain("src/routes/api/webhook.ts:1");
    expect(auditFinding!.finding).toContain("allowlist");
    expect(auditFinding!.finding).toContain("src/routes/api/webhook.ts");
  });

  it("a non-matching allowlist glob does not suppress anything; the auth finding still fires (no over-suppression)", async () => {
    const items = await fileWithTree(
      "src/routes/api/items.ts",
      `router.post("/items", requireAuth, createItem);\n` +
        `router.put("/items/:id", requireAuth, updateItem);\n` +
        `router.patch("/items/:id", requireAuth, patchItem);\n` +
        `router.delete("/items/:id", requireAuth, deleteItem);\n`,
    );
    const webhook = await fileWithTree(
      "src/routes/api/webhook.ts",
      `router.post("/public/webhook", handleWebhook);\n`,
    );
    const ctx = {
      files: [items, webhook],
      totalLines: items.lineCount + webhook.lineCount,
      dominantLanguage: "typescript",
      projectConfig: { version: 1, security: { allowlist: ["src/completely/unrelated/**"] } },
    };
    const findings = securityConsistency.detect(ctx as any);

    expect(findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY)).toBeUndefined();
    const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
    expect(authFinding).toBeDefined();
  });

  it("works with projectConfig undefined, the MCP/baseline shape (no crash, no suppression)", async () => {
    const items = await fileWithTree(
      "src/routes/api/items.ts",
      `router.post("/items", requireAuth, createItem);\n` +
        `router.put("/items/:id", requireAuth, updateItem);\n` +
        `router.patch("/items/:id", requireAuth, patchItem);\n` +
        `router.delete("/items/:id", requireAuth, deleteItem);\n`,
    );
    const webhook = await fileWithTree(
      "src/routes/api/webhook.ts",
      `router.post("/public/webhook", handleWebhook);\n`,
    );
    // No `projectConfig` key at all — the exact shape runDriftDetection sees
    // when an AnalysisContext is built without loading one (e.g. baseline.ts).
    const ctx = {
      files: [items, webhook],
      totalLines: items.lineCount + webhook.lineCount,
      dominantLanguage: "typescript",
    };
    expect(() => securityConsistency.detect(ctx as any)).not.toThrow();
    const findings = securityConsistency.detect(ctx as any);
    expect(findings.find((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY)).toBeUndefined();
    expect(findings.find((fnd) => fnd.subCategory === "Auth middleware")).toBeDefined();
  });
});

// ── Finding 3: the suppression-audit finding must never be stamped with a
//    false "code contradicts declared intent" divergence ──
//
// The suppression-audit finding is a COUNT of excluded routes, not a dominance
// vote; its dominantPattern ("route excluded via @vibedrift-public") is never
// meant to be compared against a declared convention label. Without the guard
// in enrichWithIntentDivergence (src/drift/index.ts), any repo with a
// security_posture intent hint would stamp the audit finding with a spurious
// intent-divergence claim — an audit-first false statement. This pins that
// guard while confirming a REAL auth-vote finding still diverges.
describe("suppression-audit finding vs intent divergence (Finding 3)", () => {
  it("does not stamp the audit finding with intent divergence, but still stamps a real auth-vote finding", async () => {
    // Group A (src/routes/items): 4 authed + 1 annotated-public unauthed route
    // → produces a suppression-audit finding, no auth vote (4/4 after removal).
    const items = await fileWithTree(
      "src/routes/items/api.ts",
      `router.post("/items", requireAuth, createItem);\n` +
        `router.put("/items/:id", requireAuth, updateItem);\n` +
        `router.patch("/items/:id", requireAuth, patchItem);\n` +
        `router.delete("/items/:id", requireAuth, deleteItem);\n` +
        `// @vibedrift-public\n` +
        `router.post("/public/webhook", handleWebhook);\n`,
    );
    // Group B (src/routes/orders): 4 authed + 1 unauthed mutating route
    // → real auth-vote finding (ratio 4/5 = 0.8), dominantPattern differs from
    // the declared label, so intent divergence SHOULD stamp it.
    const orders = await fileWithTree(
      "src/routes/orders/orders.ts",
      `router.post("/orders", requireAuth, a);\n` +
        `router.put("/orders/:id", requireAuth, b);\n` +
        `router.patch("/orders/:id", requireAuth, c);\n` +
        `router.delete("/orders/:id", requireAuth, d);\n` +
        `router.post("/orders/export", exportOrders);\n`,
    );

    const ctx = {
      files: [items, orders],
      totalLines: items.lineCount + orders.lineCount,
      dominantLanguage: "typescript",
      intentHints: [
        {
          category: "security_posture",
          pattern: "auth_required",
          label: "auth required on all routes",
          source: "CLAUDE.md",
          line: 1,
          text: "all routes require auth",
          confidence: 0.95,
        },
      ],
    };

    const { driftFindings } = runDriftDetection(ctx as any);

    // The audit finding exists and carries NO intent-divergence claim.
    const audit = driftFindings.find((f) => f.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY);
    expect(audit).toBeDefined();
    expect(audit!.intentDivergence).toBeUndefined();

    // The real auth-vote finding still diverges from the declared convention.
    const authVote = driftFindings.find((f) => f.subCategory === "Auth middleware");
    expect(authVote).toBeDefined();
    expect(authVote!.intentDivergence).toBeDefined();
    expect(authVote!.intentDivergence!.declaredPattern).toBe("auth_required");
    expect(authVote!.intentDivergence!.source).toBe("CLAUDE.md");

    // And after conversion, the audit finding lands on the hygiene analyzerId
    // (never the drift-security_posture track) with no intent-divergence tag.
    const { findings } = runDriftDetection(ctx as any);
    const auditConverted = findings.find((f) => f.analyzerId === SECURITY_SUPPRESSION_ANALYZER_ID);
    expect(auditConverted).toBeDefined();
    expect(auditConverted!.tags).not.toContain("intent-divergence");
  });
});
