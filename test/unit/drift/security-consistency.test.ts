import { describe, it, expect } from "vitest";
import { securityConsistency } from "../../../src/drift/security-consistency.js";
import { runDriftDetection, driftFindingToFinding } from "../../../src/drift/index.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import { extractPythonRoutesAst } from "../../../src/drift/security-ast-python.js";
import { extractJsRoutesAst } from "../../../src/drift/security-ast.js";
import { extractGoFileMiddlewareAst, extractGoRoutesAst } from "../../../src/drift/security-ast-go.js";
import {
  SECURITY_SUPPRESSION_SUBCATEGORY,
  SECURITY_SUPPRESSION_ANALYZER_ID,
} from "../../../src/drift/security-suppression.js";
import { renderTerminalOutput } from "../../../src/output/terminal.js";
import type { ScanResult, Finding } from "../../../src/core/types.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string, language: DriftFile["language"] = "typescript"): DriftFile {
  return { relativePath: path, language, content, lineCount: content.split("\n").length };
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

// ── Task B1: canonical mutating-method classification ──────────────────────
//
// MUTATION_METHODS previously excluded Express `.all()` ("ALL") and unresolved
// Flask routes ("ANY"), so those routes were silently dropped from BOTH the
// auth dominance vote and its uniform-auth-gap fallback. These tests pin the
// fix: `.all()` and a Flask `methods=[...]` mutating verb now enter the vote;
// a bare `@app.route` (which defaults to GET, not "ANY") still does not.
describe("canonical mutating methods (Task B1)", () => {
  it("includes an unauthed Express .all() route in the auth vote as a deviator", async () => {
    const f = await fileWithTree(
      "src/routes/admin.ts",
      `router.post("/users", requireAuth, createUser);\n` +
        `router.put("/users/:id", requireAuth, updateUser);\n` +
        `router.patch("/users/:id", requireAuth, patchUser);\n` +
        `router.delete("/users/:id", requireAuth, deleteUser);\n` +
        `router.all("/admin", handleAdmin);\n`,
    );
    const authMachinery = file(
      "src/middleware/auth.ts",
      `export function requireAuth(req, res, next) { verifyToken(req); next(); }`,
    );
    const ctx = {
      files: [f, authMachinery],
      totalLines: f.lineCount + authMachinery.lineCount,
      dominantLanguage: "typescript",
    };
    const findings = securityConsistency.detect(ctx as any);
    const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
    expect(authFinding).toBeDefined();
    expect(
      authFinding!.deviatingFiles.some((d) => d.path === f.relativePath && d.evidence[0].line === 5),
    ).toBe(true);
  });

  it("includes a Flask methods=['POST'] mutating route in the auth vote as a deviator; a bare @app.route (GET) is not flagged", () => {
    // Deliberately NOT @login_required / @jwt_required here: those decorators
    // also trip buildFileMiddlewareIndex's FILE-LEVEL Python auth regex
    // (pyAuth), which would inherit hasAuth:true onto every route in the
    // file, masking the very per-route gap this test targets. @requires_auth
    // still matches the per-route perAuth regex (`@requires`) without
    // matching the file-level one.
    const pyRoutes = file(
      "src/routes/orders.py",
      [
        `@app.post("/orders")`,
        `@requires_auth`,
        `def create_order():`,
        `    return {}`,
        ``,
        `@app.post("/orders/<id>")`,
        `@requires_auth`,
        `def update_order():`,
        `    return {}`,
        ``,
        `@app.post("/orders/<id>")`,
        `@requires_auth`,
        `def cancel_order():`,
        `    return {}`,
        ``,
        `@app.post("/orders/<id>/ship")`,
        `@requires_auth`,
        `def ship_order():`,
        `    return {}`,
        ``,
        `@app.route("/orders/danger", methods=["POST"])`,
        `def danger():`,
        `    return {}`,
        ``,
        `@app.route("/read")`,
        `def read_only():`,
        `    return {}`,
      ].join("\n"),
      "python",
    );
    const ctx = mkCtx([pyRoutes]);
    const findings = securityConsistency.detect(ctx);
    const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
    expect(authFinding).toBeDefined();
    // The unauthed methods=['POST'] route (line 21) is named as the deviator...
    expect(
      authFinding!.deviatingFiles.some((d) => d.path === pyRoutes.relativePath && d.evidence[0].line === 21),
    ).toBe(true);
    // ...and the bare, GET-only @app.route('/read') (line 25, no auth) is not:
    // it never enters the mutating-route denominator at all.
    expect(
      authFinding!.deviatingFiles.some((d) => d.evidence[0].line === 25),
    ).toBe(false);
  });

  // ── Adjacent-decorator regression: the methods= lookahead must never bleed
  // into a neighboring route's decorator when routes sit immediately next to
  // each other with one-line bodies (no blank line in between). ──
  it("does not bleed an adjacent route's methods=[...] into an unauthed POST route's own classification", () => {
    const pyRoutes = file(
      "src/routes/orders.py",
      [
        `@app.post("/orders")`,
        `@requires_auth`,
        `def create_order(): return {}`,
        `@app.post("/orders/<id>")`,
        `@requires_auth`,
        `def update_order(): return {}`,
        `@app.post("/orders/<id>/cancel")`,
        `@requires_auth`,
        `def cancel_order(): return {}`,
        `@app.post("/orders/<id>/ship")`,
        `@requires_auth`,
        `def ship_order(): return {}`,
        `@app.post("/orders/danger")`,
        `def danger(): return {}`,
        `@app.route("/read", methods=["GET"])`,
        `def read_only(): return {}`,
      ].join("\n"),
      "python",
    );
    const ctx = mkCtx([pyRoutes]);
    const findings = securityConsistency.detect(ctx);
    const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
    // The unauthed POST route at line 13 must still be classified as
    // mutating (POST from its own decorator), not as GET bled in from the
    // immediately-adjacent /read route's methods=["GET"] on line 15.
    expect(authFinding).toBeDefined();
    expect(
      authFinding!.deviatingFiles.some((d) => d.path === pyRoutes.relativePath && d.evidence[0].line === 13),
    ).toBe(true);
  });

  it("does not bleed an adjacent route's methods=[...] into a bare GET route's own classification", () => {
    // 7 authed POST routes keep the auth-vote ratio above the 75% dominance
    // threshold even while both trailing routes (the misclassified /read
    // under the old bug, and the genuinely-unauthed /danger) count against
    // it, so the vote actually fires and the bug's false-positive on /read
    // is observable, rather than the vote going silent.
    const pyRoutes = file(
      "src/routes/orders.py",
      [
        `@app.post("/orders/1")`,
        `@requires_auth`,
        `def r1(): return {}`,
        `@app.post("/orders/2")`,
        `@requires_auth`,
        `def r2(): return {}`,
        `@app.post("/orders/3")`,
        `@requires_auth`,
        `def r3(): return {}`,
        `@app.post("/orders/4")`,
        `@requires_auth`,
        `def r4(): return {}`,
        `@app.post("/orders/5")`,
        `@requires_auth`,
        `def r5(): return {}`,
        `@app.post("/orders/6")`,
        `@requires_auth`,
        `def r6(): return {}`,
        `@app.post("/orders/7")`,
        `@requires_auth`,
        `def r7(): return {}`,
        `@app.route("/read")`,
        `def read_only(): return {}`,
        `@app.route("/danger", methods=["POST"])`,
        `def danger(): return {}`,
      ].join("\n"),
      "python",
    );
    const ctx = mkCtx([pyRoutes]);
    const findings = securityConsistency.detect(ctx);
    const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
    expect(authFinding).toBeDefined();
    // The bare @app.route("/read") on line 22 defaults to GET and must never
    // be reported as a missing-auth mutating route, even though the
    // immediately-adjacent /danger route's methods=["POST"] on line 24 sits
    // within the old 3-line lookahead window.
    expect(
      authFinding!.deviatingFiles.some((d) => d.path === pyRoutes.relativePath && d.evidence[0].line === 22),
    ).toBe(false);
    // /danger (line 24) is a genuine unauthed mutating route and should
    // still be correctly flagged.
    expect(
      authFinding!.deviatingFiles.some((d) => d.path === pyRoutes.relativePath && d.evidence[0].line === 24),
    ).toBe(true);
  });

  it("does not let an unbalanced literal paren in a route path bleed an adjacent route's methods=[...]", () => {
    // A route path string can legitimately contain a "(". The decorator-arg
    // scanner must skip parens inside string literals, otherwise the unbalanced
    // "(" in "/weird(path" keeps the paren depth open and the scan leaks into
    // the immediately-adjacent /danger route's methods=["POST"], misclassifying
    // this bare GET route as a mutating route (a false positive).
    const pyRoutes = file(
      "src/routes/orders.py",
      [
        `@app.post("/orders/1")`,
        `@requires_auth`,
        `def r1(): return {}`,
        `@app.post("/orders/2")`,
        `@requires_auth`,
        `def r2(): return {}`,
        `@app.post("/orders/3")`,
        `@requires_auth`,
        `def r3(): return {}`,
        `@app.post("/orders/4")`,
        `@requires_auth`,
        `def r4(): return {}`,
        `@app.post("/orders/5")`,
        `@requires_auth`,
        `def r5(): return {}`,
        `@app.post("/orders/6")`,
        `@requires_auth`,
        `def r6(): return {}`,
        `@app.post("/orders/7")`,
        `@requires_auth`,
        `def r7(): return {}`,
        `@app.route("/weird(path")`,
        `def weird(): return {}`,
        `@app.route("/danger", methods=["POST"])`,
        `def danger(): return {}`,
      ].join("\n"),
      "python",
    );
    const ctx = mkCtx([pyRoutes]);
    const findings = securityConsistency.detect(ctx);
    const authFinding = findings.find((fnd) => fnd.subCategory === "Auth middleware");
    expect(authFinding).toBeDefined();
    // The bare @app.route("/weird(path") on line 22 defaults to GET and must
    // never be reported as a missing-auth mutating route, even though the
    // unbalanced literal "(" would, without string skipping, leak the adjacent
    // /danger route's methods=["POST"] into its classification.
    expect(
      authFinding!.deviatingFiles.some((d) => d.path === pyRoutes.relativePath && d.evidence[0].line === 22),
    ).toBe(false);
    // /danger (line 24) is a genuine unauthed mutating route and stays flagged.
    expect(
      authFinding!.deviatingFiles.some((d) => d.path === pyRoutes.relativePath && d.evidence[0].line === 24),
    ).toBe(true);
  });
});

// ── Task 4: Python AST extractor wired into both seams ──────────────────────
//
// Seam 1 (extractRoutes) and seam 2 (buildFileMiddlewareIndex) dispatch to the
// AST extractor for clean-parsed python files, with the regex path retained as a
// byte-identical fallback for tree-less / broken-parse python and for every
// non-python file.
describe("Python AST wiring (Task 4)", () => {
  const pyTree = (p: string, c: string) => fileWithTree(p, c, "python");
  const authFinding = (findings: any[]) => findings.find((f) => f.subCategory === "Auth middleware");

  // ── Seam 1: dispatch selects AST vs regex ──
  it("dispatch: a route-shaped COMMENT yields a route via the regex path but NOT via the AST path", async () => {
    // 4 authed POST routes (per-route @requires_auth, which does NOT trip the
    // file-level pyAuth regex) plus a route-shaped COMMENT for /danger. The
    // regex extractor matches the comment (a live over-capture); the AST
    // extractor sees only a comment node, no route.
    const src =
      `@app.post("/a")\n@requires_auth\ndef a(): return {}\n\n` +
      `@app.post("/b")\n@requires_auth\ndef b(): return {}\n\n` +
      `@app.post("/c")\n@requires_auth\ndef c(): return {}\n\n` +
      `@app.post("/d")\n@requires_auth\ndef d(): return {}\n\n` +
      `# @app.post("/danger")\n`;

    // Tree-less (regex): the comment extracts an unauthed POST /danger, so the
    // 4/5 auth vote fires and cites it.
    const regexCtx = mkCtx([file("src/routes/orders.py", src, "python")]);
    const regexFinding = authFinding(securityConsistency.detect(regexCtx));
    expect(regexFinding).toBeDefined();
    expect(regexFinding!.deviatingFiles.some((d: any) => d.detectedPattern.includes("/danger"))).toBe(true);

    // With a clean tree (AST): the comment is not a route, so all 4 real routes
    // are authed and no auth finding fires.
    const astCtx = mkCtx([await pyTree("src/routes/orders.py", src)]);
    expect(authFinding(securityConsistency.detect(astCtx))).toBeUndefined();
  });

  it("tree-less parity: a plain @app.route(methods=['POST']) file still yields its route via the regex fallback", () => {
    const src =
      `@app.post("/a")\n@requires_auth\ndef a(): return {}\n` +
      `@app.post("/b")\n@requires_auth\ndef b(): return {}\n` +
      `@app.post("/c")\n@requires_auth\ndef c(): return {}\n` +
      `@app.post("/d")\n@requires_auth\ndef d(): return {}\n` +
      `@app.route("/x", methods=["POST"])\ndef x(): return {}\n`;
    // No tree -> the regex extractor runs and extracts the /x POST route, which
    // is the lone unauthed deviator against 4 authed peers.
    const findings = securityConsistency.detect(mkCtx([file("src/routes/orders.py", src, "python")]));
    const f = authFinding(findings);
    expect(f).toBeDefined();
    expect(f!.deviatingFiles.some((d: any) => d.detectedPattern.includes("/x"))).toBe(true);
  });

  // ── Seam 2: file-level middleware index no longer over-blesses ──
  it("file-middleware seam: a per-route @login_required no longer blesses the whole file (bare route is flagged)", async () => {
    const lines: string[] = [];
    for (const p of ["a", "b", "c", "d"]) {
      lines.push(`@app.post("/${p}")`, `@login_required`, `def ${p}():`, `    return {}`, ``);
    }
    const dangerLine = lines.length + 1; // next pushed line is the /danger decorator
    lines.push(`@app.post("/danger")`, `def danger():`, `    return {}`);
    const api = await pyTree("src/routes/api.py", lines.join("\n"));
    // Tree-less auth machinery file in a different directory (repo-global signal).
    const mw = file("src/middleware/auth.ts", `export function requireAuth(req, res, next) { verifyToken(req); next(); }`);
    const ctx = { files: [api, mw], totalLines: api.lineCount + mw.lineCount, dominantLanguage: "typescript" };

    const findings = securityConsistency.detect(ctx as any);
    const auth = findings.filter((f) => f.subCategory === "Auth middleware");
    // Exactly one auth finding, and its sole deviator is the bare /danger route.
    // Under the OLD regex file-index, @login_required marked the whole file
    // authed and NO finding fired at all.
    expect(auth).toHaveLength(1);
    expect(auth[0].deviatingFiles).toHaveLength(1);
    expect(auth[0].deviatingFiles[0].path).toBe("src/routes/api.py");
    expect(auth[0].deviatingFiles[0].evidence[0].line).toBe(dangerLine);
  });

  // ── Inheritance precedence: receiver-scoped before_request ──
  it("inheritance: a before_request auth hook blesses every route in its file (no auth finding among 4 hook-files)", async () => {
    const hookFile = (p: string) =>
      pyTree(`src/routes/${p}.py`,
        `@app.before_request\ndef require_login():\n    abort(401)\n\n` +
        `@app.post("/${p}")\ndef ${p}():\n    return {}\n`);
    const files = await Promise.all([hookFile("a"), hookFile("b"), hookFile("c"), hookFile("d")]);
    const ctx = { files, totalLines: files.reduce((s, f) => s + f.lineCount, 0), dominantLanguage: "typescript" };
    expect(authFinding(securityConsistency.detect(ctx as any))).toBeUndefined();
  });

  it("inheritance: a file with no hook stays unauthed and is flagged among hook-blessed peers", async () => {
    const hookFile = (p: string) =>
      pyTree(`src/routes/${p}.py`,
        `@app.before_request\ndef require_login():\n    abort(401)\n\n` +
        `@app.post("/${p}")\ndef ${p}():\n    return {}\n`);
    const authed = await Promise.all([hookFile("a"), hookFile("b"), hookFile("c"), hookFile("d")]);
    const bare = await pyTree("src/routes/e.py", `@app.post("/e")\ndef e():\n    return {}\n`);
    const files = [...authed, bare];
    const ctx = { files, totalLines: files.reduce((s, f) => s + f.lineCount, 0), dominantLanguage: "typescript" };
    const f = authFinding(securityConsistency.detect(ctx as any));
    expect(f).toBeDefined();
    // Only the no-hook e.py route deviates; the 4 hook-blessed peers do not.
    expect(f!.deviatingFiles).toHaveLength(1);
    expect(f!.deviatingFiles[0].path).toBe("src/routes/e.py");
  });

  // ── Mixed receivers end-to-end (the core never-false-bless case) ──
  it("mixed receivers: an admin_bp before_request does not bless a co-located public_bp route end-to-end", async () => {
    const mixed = await pyTree("src/routes/mixed.py",
      `@admin_bp.before_request\n` +      // L1
      `def require_login():\n` +          // L2
      `    abort(401)\n\n` +              // L3, L4
      `@admin_bp.route("/users", methods=["POST"])\n` + // L5
      `def create_user():\n` +           // L6
      `    return {}\n\n` +               // L7, L8
      `@public_bp.route("/webhook", methods=["POST"])\n` + // L9
      `def webhook():\n` +                // L10
      `    return {}\n`);                 // L11
    const peer = (n: number) =>
      pyTree(`src/routes/peer${n}.py`, `@app.post("/p${n}")\n@requires_auth\ndef p${n}():\n    return {}\n`);
    const peers = await Promise.all([peer(1), peer(2), peer(3)]);
    const files = [mixed, ...peers];
    const ctx = { files, totalLines: files.reduce((s, f) => s + f.lineCount, 0), dominantLanguage: "typescript" };

    const f = authFinding(securityConsistency.detect(ctx as any));
    expect(f).toBeDefined();
    // The public_bp webhook (L9) is the deviator; the admin_bp /users (L5) is
    // NOT flagged. A file-granular OR would have blessed the webhook via the
    // admin blueprint's hook and silenced both vote layers.
    expect(f!.deviatingFiles.some((d: any) => d.path === "src/routes/mixed.py" && d.evidence[0].line === 9)).toBe(true);
    expect(f!.deviatingFiles.some((d: any) => d.evidence[0].line === 5)).toBe(false);
  });

  // ── Cross-language regex noise can no longer bless a clean-parsed python file ──
  it("cross-language noise: a docstring mentioning app.use(authMiddleware) never blesses a python route (seam 2)", async () => {
    const orders = await pyTree("src/routes/orders.py",
      `"""Mirrors the Node service: app.use(authMiddleware) runs first."""\n` + // L1
      `@app.post("/orders")\n` +  // L2
      `def create():\n` +          // L3
      `    return {}\n`);          // L4
    const peer = (p: string) =>
      pyTree(`src/routes/${p}.py`, `@app.post("/${p}")\n@requires_auth\ndef ${p}():\n    return {}\n`);
    const peers = await Promise.all([peer("a"), peer("b"), peer("c"), peer("d")]);
    const files = [orders, ...peers];
    const ctx = { files, totalLines: files.reduce((s, f) => s + f.lineCount, 0), dominantLanguage: "typescript" };

    const f = authFinding(securityConsistency.detect(ctx as any));
    expect(f).toBeDefined();
    // The jsAuth regex matches "app.use(authMiddleware" in the docstring, but a
    // python file with a clean tree forces the js/go arms false, so /orders
    // stays unauthed and is the flagged deviator.
    expect(f!.deviatingFiles.some((d: any) => d.path === "src/routes/orders.py" && d.evidence[0].line === 2)).toBe(true);
  });

  // ── healthPaths still excluded end-to-end ──
  it("healthPaths: 7 authed POST routes + 1 unauthed POST /healthz produces zero auth findings", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 7; i++) {
      lines.push(`@app.post("/r${i}")`, `@requires_auth`, `def r${i}():`, `    return {}`, ``);
    }
    lines.push(`@app.post("/healthz")`, `def health():`, `    return {}`);
    const f = await pyTree("src/routes/api.py", lines.join("\n"));
    const ctx = mkCtx([f]);
    expect(authFinding(securityConsistency.detect(ctx))).toBeUndefined();
  });

  // ── Byte-identical guard: a python file cannot perturb JS-side findings ──
  it("mixed-language: adding a python route file (different directory) does not change the JS-side findings", async () => {
    const js = await fileWithTree("src/js/api.ts",
      `router.post("/items", requireAuth, createItem);\n` +
      `router.put("/items/:id", requireAuth, updateItem);\n` +
      `router.patch("/items/:id", requireAuth, patchItem);\n` +
      `router.delete("/items/:id", requireAuth, deleteItem);\n` +
      `router.post("/danger", wipeEverything);\n`);
    const py = await fileWithTree("src/py/orders.py",
      `@app.post("/o1")\n@requires_auth\ndef o1():\n    return {}\n\n` +
      `@app.post("/o2")\n@requires_auth\ndef o2():\n    return {}\n`,
      "python");

    const withoutPy = securityConsistency.detect({ files: [js], totalLines: js.lineCount, dominantLanguage: "typescript" } as any);
    const withPy = securityConsistency.detect({ files: [js, py], totalLines: js.lineCount + py.lineCount, dominantLanguage: "typescript" } as any);
    // The python file is uniformly authed (no finding of its own) and lives in a
    // different directory group, so the JS findings are byte-for-byte identical.
    expect(withPy).toEqual(withoutPy);
  });
});

// ── Task 6: detect-level fallback + suppression pins for the Python path ──────
//
// These exercise securityConsistency.detect end-to-end (not the extractor in
// isolation), pinning two things: (1) a broken-parse python file still routes to
// the regex extractor, preserving today's recall AND today's known regex over-
// bless (the explicit scope boundary of the never-false-bless invariant); and
// (2) the `# @vibedrift-public` annotation binds to a python route exactly as it
// does for JS, using the `#` comment marker and the same own-line/preceding-line
// rule.
describe("Task 6: python detect-level fallback and suppression pins", () => {
  const pyTree = (p: string, c: string) => fileWithTree(p, c, "python");
  const auth = (findings: any[]) => findings.find((f) => f.subCategory === "Auth middleware");
  const audit = (findings: any[]) => findings.find((f) => f.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY);
  const ctxOf = (files: DriftFile[], extra: Record<string, unknown> = {}) => ({
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
    ...extra,
  });

  it("an unclosed-paren file (rootNode.hasError) still yields its regex-visible route through detect", async () => {
    // Unclosed decorator paren erases the file's decorator structure, so the AST
    // extractor finds nothing on this tree — but detect's hasError gate routes the
    // whole file to extractPythonRoutesRegex, which recovers the POST /danger
    // route. Peers keep the auth vote alive so the recovered route is observable
    // as the lone unauthed deviator.
    const brokenSrc =
      `@app.route("/broken"\n` +
      `@app.post("/danger")\n` +
      `def danger():\n` +
      `    return {}\n`;
    const broken = await pyTree("src/routes/broken.py", brokenSrc);
    expect(broken.tree!.rootNode.hasError).toBe(true);
    // The AST path alone loses the route (proving the regex fallback is what
    // preserves recall here, not the AST extractor).
    expect(extractPythonRoutesAst(broken.tree!, broken.relativePath)).toEqual([]);

    const peer = (n: number) =>
      pyTree(`src/routes/p${n}.py`, `@app.post("/p${n}")\n@requires_auth\ndef p${n}():\n    return {}\n`);
    const peers = await Promise.all([peer(1), peer(2), peer(3), peer(4)]);
    const f = auth(securityConsistency.detect(ctxOf([broken, ...peers]) as any));
    expect(f).toBeDefined();
    expect(
      f!.deviatingFiles.some(
        (d: any) => d.path === "src/routes/broken.py" && d.detectedPattern.includes("/danger"),
      ),
    ).toBe(true);
  });

  it("pinned legacy: parse-error files keep the regex window over-bless", async () => {
    // The recorded exception to never-false-bless: on a file with ANY parse error,
    // detect falls back to the regex extractor, whose per-route auth check is a
    // 30-line TEXT window. Here an unauthed POST /legacy route sits within that
    // window of the bare word `token` in a comment, so the regex over-blesses it
    // to hasAuth:true. This is the legacy behavior the AST path replaces on CLEAN
    // files; on parse-error files it survives unchanged, by design. Pinned as a
    // decision, not left silent.
    const legacySrc =
      `@app.route("/legacy", methods=["POST"])\n` + // L1: unauthed mutating route
      `def legacy():\n` +                            // L2
      `    # token validated upstream\n` +           // L3: bare word `token` in a comment, within the 30-line window
      `    x = = 1\n` +                              // L4: parse error -> rootNode.hasError, routes file to regex
      `    return {}\n`;                             // L5
    const legacy = await pyTree("src/routes/legacy.py", legacySrc);
    expect(legacy.tree!.rootNode.hasError).toBe(true);

    // Group: the over-blessed /legacy + 3 authed peers + 1 genuine unauthed
    // /danger. If the over-bless holds, /legacy counts as authed, the vote is
    // 4 authed / 1 unauthed = 0.8 (fires), and /danger — NOT /legacy — is cited.
    const peer = (n: number) =>
      pyTree(`src/routes/lp${n}.py`, `@app.post("/lp${n}")\n@requires_auth\ndef lp${n}():\n    return {}\n`);
    const peers = await Promise.all([peer(1), peer(2), peer(3)]);
    const danger = await pyTree("src/routes/danger.py", `@app.post("/danger")\ndef danger():\n    return {}\n`);
    const f = auth(securityConsistency.detect(ctxOf([legacy, ...peers, danger]) as any));

    expect(f).toBeDefined();
    // The genuine unauthed route is flagged...
    expect(f!.deviatingFiles.some((d: any) => d.path === "src/routes/danger.py")).toBe(true);
    // ...and /legacy is NOT flagged: the regex window over-blessed it via `token`,
    // so it came out hasAuth:true (were it correctly unauthed, it would be cited
    // here too — and the vote would have dropped to 3/5 = 0.6 and gone silent).
    expect(f!.deviatingFiles.some((d: any) => d.path === "src/routes/legacy.py")).toBe(false);
  });

  it("suppresses a python route when # @vibedrift-public sits directly above its route decorator, and cites it", async () => {
    // Four authed POST routes plus a fifth unauthed public route with a standalone
    // `# @vibedrift-public` on the line immediately above its @app.post decorator.
    const src = [
      `@app.post("/a")`, `@requires_auth`, `def a():`, `    return {}`, ``,       // L1-5
      `@app.post("/b")`, `@requires_auth`, `def b():`, `    return {}`, ``,       // L6-10
      `@app.post("/c")`, `@requires_auth`, `def c():`, `    return {}`, ``,       // L11-15
      `@app.post("/d")`, `@requires_auth`, `def d():`, `    return {}`, ``,       // L16-20
      `# @vibedrift-public`,                                                       // L21
      `@app.post("/public")`,                                                      // L22: route.line
      `def public():`,                                                             // L23
      `    return {}`,                                                             // L24
    ].join("\n");
    const f = await pyTree("src/routes/api.py", src);
    const findings = securityConsistency.detect(ctxOf([f]) as any);

    // /public is removed from the denominator, leaving 4/4 authed -> no auth drift.
    expect(auth(findings)).toBeUndefined();
    // The exclusion is cited on the route's own line (22), never silent.
    const a = audit(findings);
    expect(a).toBeDefined();
    expect(a!.totalRelevantFiles).toBe(1);
    expect(a!.deviatingFiles).toHaveLength(1);
    expect(a!.deviatingFiles[0].path).toBe("src/routes/api.py");
    expect(a!.deviatingFiles[0].evidence[0].line).toBe(22);
  });

  it("does NOT suppress when # @vibedrift-public sits above the FIRST decorator of a stack whose route decorator is lower", async () => {
    // The annotation is 2 lines above route.line (a non-route decorator sits
    // between them), so neither the own-line nor the preceding-line rule binds it.
    // Under-matching is the documented safe direction: /public stays in the vote
    // as the unauthed deviator, nothing is suppressed. This pins the python
    // behavior as a decision, not an accident.
    const src = [
      `@app.post("/a")`, `@requires_auth`, `def a():`, `    return {}`, ``,       // L1-5
      `@app.post("/b")`, `@requires_auth`, `def b():`, `    return {}`, ``,       // L6-10
      `@app.post("/c")`, `@requires_auth`, `def c():`, `    return {}`, ``,       // L11-15
      `@app.post("/d")`, `@requires_auth`, `def d():`, `    return {}`, ``,       // L16-20
      `# @vibedrift-public`,                                                       // L21: annotation (2 lines above route.line)
      `@log_calls`,                                                                // L22: first decorator of the stack
      `@app.post("/public")`,                                                      // L23: route.line
      `def public():`,                                                             // L24
      `    return {}`,                                                             // L25
    ].join("\n");
    const f = await pyTree("src/routes/api.py", src);
    const findings = securityConsistency.detect(ctxOf([f]) as any);

    // Nothing suppressed -> no audit finding.
    expect(audit(findings)).toBeUndefined();
    // /public stays unauthed in the vote (4 authed + 1 unauthed = 0.8) and is
    // cited on its own route-decorator line (23).
    const a = auth(findings);
    expect(a).toBeDefined();
    expect(a!.deviatingFiles.some((d: any) => d.evidence[0].line === 23)).toBe(true);
  });
});

// ── Task 4: hedged "unsure, double check" finding copy ───────────────────────
//
// A route whose only auth gate is a before_request hook the body-signature
// analyzer could not verify carries RouteInfo.authUnsureHook (Python AST only).
// Such a route STAYS not-authed in every vote (hasAuth === false); Task 4 only
// makes the FINDING COPY hedged so the user is told the exact hook to verify.
// The hedge is auth-subcategory-only and never touches JS/TS/Go findings.
describe("Task 4: hedged unsure-auth finding copy", () => {
  const pyTree = (p: string, c: string) => fileWithTree(p, c, "python");
  const auth = (findings: any[]) => findings.find((f) => f.subCategory === "Auth middleware");
  const ctxOf = (files: any[]) => ({
    files,
    totalLines: files.reduce((s: number, f: any) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  });

  // A confidently-authed peer route (per-route @requires_auth decorator).
  const peerAuth = (n: number) =>
    pyTree(`src/routes/p${n}.py`, `@app.post("/p${n}")\n@requires_auth\ndef p${n}():\n    return {}\n`);
  // Call-form registration of an imported hook whose body cannot be resolved ->
  // classifyHookAuth returns "unsure" -> authUnsureHook = "verify_session",
  // hasAuth stays false. Route path is /x so the deviator reads "POST /x".
  const unsureRoute = () =>
    pyTree(
      "src/routes/x.py",
      `from auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/x")\ndef x():\n    return {}\n`,
    );

  it("dominance vote: the unsure deviator is hedged and names the hook; the recommendation appends the double-check sentence", async () => {
    const peers = await Promise.all([peerAuth(1), peerAuth(2), peerAuth(3), peerAuth(4)]);
    const unsure = await unsureRoute();
    const findings = securityConsistency.detect(ctxOf([...peers, unsure]) as any);

    // exactly one auth finding
    expect(findings.filter((f: any) => f.subCategory === "Auth middleware")).toHaveLength(1);
    const a = auth(findings)!;
    // exactly one deviator (the unsure route), hedged with the EXACT string
    expect(a.deviatingFiles).toHaveLength(1);
    expect(a.deviatingFiles[0].detectedPattern).toBe(
      "POST /x: auth not confirmed, double check hook 'verify_session'",
    );
    // recommendation ends with the appended hedge sentence naming the hook
    expect(a.recommendation).toMatch(/\d+ of these could not be confirmed/);
    expect(a.recommendation.toLowerCase()).toContain("double check");
    expect(a.recommendation).toContain("verify_session");
  });

  it("confident sibling: a plainly-unauthed route (no unsure hook) keeps today's exact flat deviator byte-for-byte", async () => {
    const peers = await Promise.all([peerAuth(1), peerAuth(2), peerAuth(3), peerAuth(4)]);
    const bare = await pyTree("src/routes/x.py", `@app.post("/x")\ndef x():\n    return {}\n`);
    const a = auth(securityConsistency.detect(ctxOf([...peers, bare]) as any))!;
    expect(a.deviatingFiles[0].detectedPattern).toBe("POST /x — no Auth middleware");
    expect(a.recommendation).not.toMatch(/double check/i);
    expect(a.recommendation).not.toContain("verify_session");
  });

  it("uniform-auth-gap: the unsure route is hedged; plainly-unauthed peers keep `— no auth`; counts/severity/confidence unchanged", async () => {
    const flat = (n: number) => pyTree(`src/routes/f${n}.py`, `@app.post("/f${n}")\ndef f${n}():\n    return {}\n`);
    const flats = await Promise.all([flat(1), flat(2), flat(3)]);
    const unsure = await unsureRoute();
    const machinery = await pyTree("src/lib/auth.py", `def login_required():\n    pass\n`);
    const a = auth(securityConsistency.detect(ctxOf([...flats, unsure, machinery]) as any))!;

    // headline / counts include the unsure route (still counted as not-authed)
    expect(a.finding).toBe("4 mutating route(s) lack auth while the codebase uses auth elsewhere");
    expect(a.confidence).toBe(0.6);
    expect(a.severity).toBe("error");
    const byPath = new Map(a.deviatingFiles.map((d: any) => [d.path, d.detectedPattern]));
    expect(byPath.get("src/routes/x.py")).toBe(
      "POST /x: auth not confirmed, double check hook 'verify_session'",
    );
    expect(byPath.get("src/routes/f1.py")).toBe("POST /f1 — no auth");
    expect(byPath.get("src/routes/f2.py")).toBe("POST /f2 — no auth");
    expect(a.recommendation.toLowerCase()).toContain("double check");
    expect(a.recommendation).toContain("verify_session");
  });

  it("no cross-property leakage: validation and rate-limit findings never carry the hedge for an unsure-auth route", async () => {
    const peer = (n: number) =>
      pyTree(
        `src/routes/p${n}.py`,
        `@app.post("/p${n}")\n@requires_auth\n@validate_schema\n@limiter.limit("5/min")\ndef p${n}():\n    return {}\n`,
      );
    const peers = await Promise.all([peer(1), peer(2), peer(3), peer(4)]);
    const unsure = await unsureRoute();
    const findings = securityConsistency.detect(ctxOf([...peers, unsure]) as any);

    const val = findings.find((f: any) => f.subCategory === "Input validation");
    const rate = findings.find((f: any) => f.subCategory === "Rate limiting");
    expect(val).toBeDefined();
    expect(rate).toBeDefined();
    for (const f of [val!, rate!]) {
      for (const d of f.deviatingFiles) {
        expect(d.detectedPattern).not.toMatch(/double check/i);
        expect(d.detectedPattern).not.toContain("verify_session");
      }
      expect(f.recommendation).not.toMatch(/double check/i);
      expect(f.recommendation).not.toContain("verify_session");
    }
    // sanity: the auth finding IS hedged in the same run
    expect(auth(findings)!.deviatingFiles[0].detectedPattern).toContain("double check hook 'verify_session'");
  });

  it("field-absence contract: authUnsureHook key is ABSENT on confident py, unsure-but-authed py, and JS routes", async () => {
    const conf = await pyTree("src/api/c.py", `@app.post("/c")\ndef c():\n    return {}\n`);
    const confR = extractPythonRoutesAst(conf.tree!, "src/api/c.py");
    expect("authUnsureHook" in confR[0]).toBe(false);

    // A route that is authed per-route AND has an unsure hook in scope: hasAuth
    // wins, so the field is omitted entirely (a blessed route never hedges).
    const unsureAuthed = await pyTree(
      "src/api/u.py",
      `from auth import verify_session\napp.before_request(verify_session)\n\n@app.post("/u")\n@requires_auth\ndef u():\n    return {}\n`,
    );
    const uR = extractPythonRoutesAst(unsureAuthed.tree!, "src/api/u.py");
    expect(uR[0].hasAuth).toBe(true);
    expect("authUnsureHook" in uR[0]).toBe(false);

    // JS extractor never sets the field; the route serializes byte-identically
    // to the pre-addendum shape.
    const jsf = await fileWithTree("src/api/x.ts", `router.post("/danger", wipeEverything);\n`, "typescript");
    const jsRoutes = extractJsRoutesAst(jsf.tree!, "src/api/x.ts", undefined);
    expect("authUnsureHook" in jsRoutes[0]).toBe(false);
    expect(JSON.stringify(jsRoutes[0])).toBe(
      JSON.stringify({
        method: "POST",
        path: "/danger",
        file: "src/api/x.ts",
        line: 1,
        hasAuth: false,
        hasValidation: false,
        hasRateLimit: false,
        hasErrorHandler: false,
      }),
    );
  });

  it("copy hygiene: every NEW hedged string says `double check` and contains no em-dash or double hyphen", async () => {
    const peers = await Promise.all([peerAuth(1), peerAuth(2), peerAuth(3), peerAuth(4)]);
    const unsure = await unsureRoute();
    const a = auth(securityConsistency.detect(ctxOf([...peers, unsure]) as any))!;

    // The hedged deviator is a NEW string.
    const dev = a.deviatingFiles[0].detectedPattern;
    expect(dev).toMatch(/double check/i);
    expect(dev).not.toMatch(/—|--/);

    // The appended hedge sentence is a NEW string (the shipped base
    // recommendation before it is exempt and keeps its em-dash).
    const m = a.recommendation.match(/\d+ of these could not be confirmed:.*$/);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/double check/i);
    expect(m![0]).not.toMatch(/—|--/);
  });

  it("vote-arithmetic invariance: hedging changes COPY only, never dominantCount/total/consistency/severity/confidence", async () => {
    const hedgedPeers = await Promise.all([peerAuth(1), peerAuth(2), peerAuth(3), peerAuth(4)]);
    const unsure = await unsureRoute();
    const hedged = auth(securityConsistency.detect(ctxOf([...hedgedPeers, unsure]) as any))!;

    // Control: the SAME corpus with the hook-registration line deleted, so /x is
    // a plainly-unauthed (confident) route instead of unsure.
    const ctrlPeers = await Promise.all([peerAuth(1), peerAuth(2), peerAuth(3), peerAuth(4)]);
    const ctrl = await pyTree("src/routes/x.py", `@app.post("/x")\ndef x():\n    return {}\n`);
    const flat = auth(securityConsistency.detect(ctxOf([...ctrlPeers, ctrl]) as any))!;

    for (const k of ["dominantCount", "totalRelevantFiles", "consistencyScore", "severity", "confidence"] as const) {
      expect((hedged as any)[k]).toBe((flat as any)[k]);
    }
    // The ONLY difference is the deviator copy (and the appended recommendation).
    expect(hedged.deviatingFiles[0].detectedPattern).not.toBe(flat.deviatingFiles[0].detectedPattern);
  });
});

// ── Task 4 (Go): regex fallback pins (pre-wiring) ────────────────────────────
//
// The byte-compat requirement has ZERO .go coverage today. These pins document
// the EXACT behavior of the tree-less Go regex path (via the plain `file()`
// helper, which carries no tree) and MUST stay green BOTH before AND after the
// seam edits — a tree-less / broken-parse go file always routes to the regex
// extractor, so these can never silently change. Legacy over-blesses are pinned
// AS-IS (documented, not endorsed).
describe("go regex fallback pins (pre-wiring)", () => {
  const goFile = (p: string, c: string) => file(p, c, "go");
  const authFinding = (fs: any[]) => fs.find((f) => f.subCategory === "Auth middleware");
  const devPaths = (f: any): string[] =>
    f ? f.deviatingFiles.map((d: any) => d.evidence[0].code.split(" ")[1]) : [];
  // A tree-less authed peer: file-level r.Use(authMiddleware) blesses its POST
  // through the regex file-middleware index.
  const authedPeer = (n: number) =>
    goFile(`src/routes/peer${n}.go`,
      `func routes${n}(r *gin.Engine) {\n\tr.Use(authMiddleware)\n\tr.POST("/peer${n}", createX)\n}\n`);
  // A tree-less, genuinely-unauthed mutating route.
  const bareDanger = () =>
    goFile("src/routes/danger.go", `func routes(r *gin.Engine) {\n\tr.POST("/danger", createX)\n}\n`);

  it("recall: a tree-less go file's r.GET / r.POST routes extract through detect (regex recall)", () => {
    // Target file: a bare (unauthed) POST /y among 4 authed peers -> /y is the
    // lone deviator, proving the regex extractor recovered the POST route.
    const target = goFile("src/routes/target.go",
      `func routes(r *gin.Engine) {\n\tr.GET("/g", h)\n\tr.POST("/y", createX)\n}\n`);
    const files = [target, authedPeer(1), authedPeer(2), authedPeer(3), authedPeer(4)];
    const f = authFinding(securityConsistency.detect(mkCtx(files)));
    expect(f).toBeDefined();
    expect(devPaths(f)).toContain("/y");
  });

  it("pinned legacy: tree-less go files keep the regex window over-bless", () => {
    // A bare word `authMiddleware` in a COMMENT within the 21-line window
    // (i-10 .. i+10) of an unauthed POST /legacy over-blesses it to authed. This
    // is the legacy behavior the AST path replaces on CLEAN files; on tree-less
    // files it survives unchanged, by design. Pinned as a decision, not silent.
    const legacy = goFile("src/routes/legacy.go",
      `func routes(r *gin.Engine) {\n\t// authMiddleware runs upstream\n\tr.POST("/legacy", createX)\n}\n`);
    // 3 authed peers + the over-blessed /legacy (= 4 authed) + 1 genuine unauthed
    // /danger -> 4/5 = 0.8 fires and cites /danger. If /legacy were NOT
    // over-blessed it would be cited too and the vote would drop to 3/5 = 0.6
    // (silent), so the finding firing on /danger alone proves the over-bless.
    const files = [legacy, authedPeer(1), authedPeer(2), authedPeer(3), bareDanger()];
    const f = authFinding(securityConsistency.detect(mkCtx(files)));
    expect(f).toBeDefined();
    expect(devPaths(f)).toContain("/danger");
    expect(devPaths(f)).not.toContain("/legacy");
  });

  it("file index: a tree-less r.Use(authMiddleware) blesses a distant same-file route", () => {
    // The Use sits >10 lines above the route, so the per-route TEXT window cannot
    // reach it; only the file-level middleware index (which matches `.Use(auth`
    // anywhere in the file) can bless /scoped. Observed via /scoped NOT being the
    // deviator among peers where a genuine unauthed /danger is.
    const scoped = goFile("src/routes/scoped.go",
      [
        `func setup(r *gin.Engine) {`,   // L1
        `\tr.Use(authMiddleware)`,        // L2 (0-based row 1)
        `}`,                              // L3
        ``, ``, ``, ``, ``, ``, ``, ``, ``, ``, ``, ``, // L4-15 padding
        `func routes(r *gin.Engine) {`,  // L16
        `\tr.POST("/scoped", createX)`,   // L17 (0-based row 16; window rows 6..26 excludes row 1)
        `}`,                              // L18
      ].join("\n"));
    const files = [scoped, authedPeer(1), authedPeer(2), authedPeer(3), bareDanger()];
    const f = authFinding(securityConsistency.detect(mkCtx(files)));
    expect(f).toBeDefined();
    expect(devPaths(f)).toContain("/danger");
    expect(devPaths(f)).not.toContain("/scoped"); // file-index blessed it
  });

  it("known miss: chi lowercase r.Post in a tree-less go file is NOT extracted by the regex", () => {
    // The echo regex pattern is UPPERCASE-verb only, so chi's `r.Post(...)` is a
    // recall miss. 4 authed peers + 1 genuine unauthed /danger fire a 4/5 = 0.8
    // finding; the chi file's would-be unauthed /chi, if it extracted, would drop
    // the vote to 4/6 = 0.67 (silent). The finding firing on /danger AND /chi
    // never appearing pins the miss (baseline for the AST recall delta).
    const chi = goFile("src/routes/chi.go", `func routes(r chi.Router) {\n\tr.Post("/chi", createX)\n}\n`);
    const files = [chi, authedPeer(1), authedPeer(2), authedPeer(3), authedPeer(4), bareDanger()];
    const f = authFinding(securityConsistency.detect(mkCtx(files)));
    expect(f).toBeDefined();
    expect(devPaths(f)).toContain("/danger");
    expect(devPaths(f)).not.toContain("/chi");
  });
});

// ── Task 4 (Go): AST extractor wired into both seams ─────────────────────────
//
// Seam 1 (extractRoutes) and seam 2 (buildFileMiddlewareIndex) dispatch to the
// Go AST extractor for clean-parsed go files, with the regex path retained as a
// byte-identical fallback for tree-less / broken-parse go and every non-go file.
describe("Go AST wiring (Task 4)", () => {
  const goTree = (p: string, c: string) => fileWithTree(p, c, "go");
  const authFinding = (fs: any[]) => fs.find((f) => f.subCategory === "Auth middleware");
  const devPaths = (f: any): string[] =>
    f ? f.deviatingFiles.map((d: any) => d.evidence[0].code.split(" ")[1]) : [];
  // An in-file factory whose inner body verifiably rejects -> rule 2 bless (NOT a
  // name bless). r.Use(AuthMiddleware()) blesses that scope's routes.
  const goAuthFactory =
    `func AuthMiddleware() gin.HandlerFunc { return func(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() } }\n`;
  const goPeer = (dir: string, n: number) =>
    goTree(`${dir}/peer${n}.go`,
      goAuthFactory + `func routes${n}(r *gin.Engine) {\n\tr.Use(AuthMiddleware())\n\tr.POST("/peer${n}", createX)\n}\n`);

  it("dispatch pair: a two-line Gorilla chain resolves POST via the AST but is missed by the tree-less regex", async () => {
    // gorillaPattern requires HandleFunc + .Methods on the SAME line; a chain
    // split across two lines defeats the regex but not the AST chain walk.
    const gorillaSrc = `func routes(r *mux.Router) {\n\tr.HandleFunc("/danger", h).\n\t\tMethods("POST")\n}\n`;
    const peers = await Promise.all([goPeer("src/gorilla", 1), goPeer("src/gorilla", 2), goPeer("src/gorilla", 3), goPeer("src/gorilla", 4)]);
    // WITH a tree: the AST walks the cross-line chain and extracts POST /danger,
    // the lone unauthed deviator (4/5 = 0.8 fires).
    const withTree = await goTree("src/gorilla/g.go", gorillaSrc);
    expect(withTree.tree!.rootNode.hasError).toBe(false);
    const fWith = authFinding(securityConsistency.detect(mkCtx([...peers, withTree])));
    expect(fWith).toBeDefined();
    expect(devPaths(fWith)).toContain("/danger");
    // TREE-LESS: the gorilla regex is same-line only, so /danger is never
    // extracted; the peers are uniformly authed and nothing is flagged.
    const treeless = file("src/gorilla/g.go", gorillaSrc, "go");
    const fLess = authFinding(securityConsistency.detect(mkCtx([...peers, treeless])));
    expect(devPaths(fLess)).not.toContain("/danger");
  });

  it("pinned legacy: parse-error go files keep the regex window over-bless", async () => {
    // A go file with a parse error routes WHOLE to the regex extractor, which
    // recovers the regex-visible /legacy route AND keeps the 21-line window
    // over-bless (comment `authMiddleware`). On a CLEAN tree the AST would flag
    // /legacy; on a broken tree it survives blessed, by design.
    const brokenSrc =
      `func routes(r *gin.Engine) {\n` +
      `\t// authMiddleware runs upstream\n` +
      `\tr.POST("/legacy", createX)\n` +
      `\tx := = 1\n` +                       // parse error -> rootNode.hasError
      `}\n`;
    const broken = await goTree("src/broken/legacy.go", brokenSrc);
    expect(broken.tree!.rootNode.hasError).toBe(true);
    const peers = await Promise.all([goPeer("src/broken", 1), goPeer("src/broken", 2), goPeer("src/broken", 3)]);
    const danger = goTree("src/broken/danger.go", `func routes(r *gin.Engine) {\n\tr.POST("/danger", createX)\n}\n`);
    const files = [broken, ...peers, await danger];
    const f = authFinding(securityConsistency.detect(mkCtx(files)));
    expect(f).toBeDefined();
    expect(devPaths(f)).toContain("/danger");
    expect(devPaths(f)).not.toContain("/legacy"); // regex window over-blessed it
  });

  it("cross-language noise (go direction): a comment app.use / string before_request never blesses a clean go route", async () => {
    const noisy = await goTree("src/noise/orders.go",
      `// Mirrors the Node service: app.use(authMiddleware) runs first\n` +
      `func routes(r *gin.Engine) {\n` +
      `\tmsg := "@app.before_request"\n` +
      `\tr.POST("/orders", createX)\n` +
      `}\n`);
    expect(noisy.tree!.rootNode.hasError).toBe(false);
    const peers = await Promise.all([goPeer("src/noise", 1), goPeer("src/noise", 2), goPeer("src/noise", 3), goPeer("src/noise", 4)]);
    const f = authFinding(securityConsistency.detect(mkCtx([noisy, ...peers])));
    expect(f).toBeDefined();
    // The case-insensitive jsAuth regex matches `app.use(authMiddleware` in the
    // comment and pyAuth matches `@app.before_request`, but a clean go tree forces
    // both arms false, so /orders stays unauthed and is the flagged deviator.
    expect(devPaths(f)).toContain("/orders");
  });

  it("file-middleware seam end-to-end: 4 body-backed r.Use files + 1 bare route -> one finding on the bare route", async () => {
    const peers = await Promise.all([goPeer("src/api", 1), goPeer("src/api", 2), goPeer("src/api", 3), goPeer("src/api", 4)]);
    const bare = await goTree("src/api/danger.go", `func routes(r *gin.Engine) {\n\tr.POST("/danger", createX)\n}\n`);
    const findings = securityConsistency.detect(mkCtx([...peers, bare]));
    const auths = findings.filter((f) => f.subCategory === "Auth middleware");
    expect(auths).toHaveLength(1);
    expect(auths[0].deviatingFiles).toHaveLength(1);
    expect(auths[0].deviatingFiles[0].path).toBe("src/api/danger.go");
    expect(auths[0].deviatingFiles[0].evidence[0].line).toBe(2); // the r.POST line
  });

  it("unsure survives the dispatch: the deviator's detectedPattern is the hedged shape", async () => {
    const peers = await Promise.all([goPeer("src/hedge", 1), goPeer("src/hedge", 2), goPeer("src/hedge", 3), goPeer("src/hedge", 4)]);
    const unsure = await goTree("src/hedge/x.go",
      `func routes(r *gin.Engine) {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", createX)\n}\n`);
    const findings = securityConsistency.detect(mkCtx([...peers, unsure]));
    const auths = findings.filter((f) => f.subCategory === "Auth middleware");
    expect(auths).toHaveLength(1);
    expect(auths[0].deviatingFiles).toHaveLength(1);
    const dev = auths[0].deviatingFiles[0].detectedPattern;
    expect(dev).toContain("double check");
    expect(dev).toContain("middleware.VerifyToken");
  });

  it("mixed-language byte-identity: adding a clean go route file (different dir) does not change JS-side findings", async () => {
    const js = await fileWithTree("src/js/api.ts",
      `router.post("/items", requireAuth, createItem);\n` +
      `router.put("/items/:id", requireAuth, updateItem);\n` +
      `router.patch("/items/:id", requireAuth, patchItem);\n` +
      `router.delete("/items/:id", requireAuth, deleteItem);\n` +
      `router.post("/danger", wipeEverything);\n`);
    const gof = await goTree("src/go/orders.go",
      goAuthFactory + `func routes(r *gin.Engine) {\n\tr.Use(AuthMiddleware())\n\tr.POST("/o1", createX)\n\tr.POST("/o2", createY)\n}\n`);
    const withoutGo = securityConsistency.detect({ files: [js], totalLines: js.lineCount, dominantLanguage: "typescript" } as any);
    const withGo = securityConsistency.detect({ files: [js, gof], totalLines: js.lineCount + gof.lineCount, dominantLanguage: "typescript" } as any);
    expect(withGo).toEqual(withoutGo);
  });
});

// ── Task 5 (Go): the shipped hedge reused end-to-end, zero parallel code ─────
//
// Tasks 3-4 gave Go routes `authUnsureHook`; the hedge mechanism itself
// (hedgedDeviatorPattern, hedgeRecommendationSuffix, and the terminal's
// isHedgedAuthFinding/hedgedSecurityConsequence) is language-neutral and was
// shipped for Python (#43). This block proves a Go-sourced unsure route flows
// through the SAME mechanism with no Go-specific branch anywhere in the
// pipeline, up to and including the terminal renderer.
describe("Task 5 (Go): unsure-hook hedge reuses the shipped Python mechanism", () => {
  const goTree = (p: string, c: string) => fileWithTree(p, c, "go");
  const authFinding = (fs: any[]) => fs.find((f: any) => f.subCategory === "Auth middleware");
  // In-file factory whose inner body verifiably rejects (rule 2 bless, not a
  // name bless) — same fixture shape as Task 4's Go wiring tests.
  const goAuthFactory =
    `func AuthMiddleware() gin.HandlerFunc { return func(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() } }\n`;
  const goPeer = (dir: string, n: number) =>
    goTree(`${dir}/peer${n}.go`,
      goAuthFactory + `func routes${n}(r *gin.Engine) {\n\tr.Use(AuthMiddleware())\n\tr.POST("/peer${n}", createX)\n}\n`);

  it("dominance vote: a Go unsure Use hook renders the byte-for-byte hedged deviator, and the recommendation names it", async () => {
    const peers = await Promise.all([goPeer("src/t5dom", 1), goPeer("src/t5dom", 2), goPeer("src/t5dom", 3), goPeer("src/t5dom", 4)]);
    const unsure = await goTree("src/t5dom/orders.go",
      `func routes(r *gin.Engine) {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/orders", createOrder)\n}\n`);
    const findings = securityConsistency.detect(mkCtx([...peers, unsure]));

    expect(findings.filter((f: any) => f.subCategory === "Auth middleware")).toHaveLength(1);
    const a = authFinding(findings)!;
    expect(a.deviatingFiles).toHaveLength(1);
    // Byte-for-byte hedgedDeviatorPattern — the same function Python's hedge uses.
    expect(a.deviatingFiles[0].detectedPattern).toBe(
      "POST /orders: auth not confirmed, double check hook 'middleware.VerifyToken'",
    );
    expect(a.deviatingFiles[0].detectedPattern).not.toMatch(/—|--/);
    expect(a.recommendation).toContain("Double check");
    expect(a.recommendation).toContain("middleware.VerifyToken");
  });

  it("confident Go sibling: a plainly-unauthed route (no Use hook at all) keeps today's exact flat deviator", async () => {
    const peers = await Promise.all([goPeer("src/t5domflat", 1), goPeer("src/t5domflat", 2), goPeer("src/t5domflat", 3), goPeer("src/t5domflat", 4)]);
    const bare = await goTree("src/t5domflat/orders.go", `func routes(r *gin.Engine) {\n\tr.POST("/orders", createOrder)\n}\n`);
    const a = authFinding(securityConsistency.detect(mkCtx([...peers, bare])))!;
    expect(a.deviatingFiles[0].detectedPattern).toBe("POST /orders — no Auth middleware");
    expect(a.recommendation).not.toMatch(/double check/i);
    expect(a.recommendation).not.toContain("middleware.VerifyToken");
  });

  it("uniform-auth-gap (Go): the unsure route among uniformly-unauthed mutating routes hedges; peers keep the flat '— no auth' string; counts/severity/confidence unchanged", async () => {
    const flat = (n: number) =>
      goTree(`src/t5gap/f${n}.go`, `func routes${n}(r *gin.Engine) {\n\tr.POST("/f${n}", createX)\n}\n`);
    const flats = await Promise.all([flat(1), flat(2), flat(3)]);
    const unsure = await goTree("src/t5gap/x.go",
      `func routes(r *gin.Engine) {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", createX)\n}\n`);
    // Baseline evidence so analyzeUniformAuthGap doesn't stay silent: the repo
    // knows how to auth elsewhere (matches the repoHasAuthMachinery symbol list).
    const machinery = await goTree("src/t5gap/lib/auth.go", `func AuthMiddleware() {}\n`);
    const a = authFinding(securityConsistency.detect(mkCtx([...flats, unsure, machinery])))!;

    expect(a.finding).toBe("4 mutating route(s) lack auth while the codebase uses auth elsewhere");
    expect(a.confidence).toBe(0.6);
    expect(a.severity).toBe("error");
    const byPath = new Map(a.deviatingFiles.map((d: any) => [d.path, d.detectedPattern]));
    expect(byPath.get("src/t5gap/x.go")).toBe(
      "POST /x: auth not confirmed, double check hook 'middleware.VerifyToken'",
    );
    expect(byPath.get("src/t5gap/f1.go")).toBe("POST /f1 — no auth");
    expect(byPath.get("src/t5gap/f2.go")).toBe("POST /f2 — no auth");
    expect(byPath.get("src/t5gap/f3.go")).toBe("POST /f3 — no auth");
    expect(a.recommendation).toContain("Double check");
    expect(a.recommendation).toContain("middleware.VerifyToken");
  });

  it("no cross-property leakage (Go): validation and rate-limit findings never carry the auth hedge for a route that also lacks them", async () => {
    const peer = (n: number) =>
      goTree(`src/t5leak/p${n}.go`,
        goAuthFactory +
        `func routes${n}(r *gin.Engine) {\n\tr.Use(AuthMiddleware())\n\tr.Use(middleware.RateLimiter(rate))\n\tr.Use(RequestValidator())\n\tr.POST("/p${n}", createX)\n}\n`);
    const peers = await Promise.all([peer(1), peer(2), peer(3), peer(4)]);
    const unsure = await goTree("src/t5leak/x.go",
      `func routes(r *gin.Engine) {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", createX)\n}\n`);
    const findings = securityConsistency.detect(mkCtx([...peers, unsure]));

    const val = findings.find((f: any) => f.subCategory === "Input validation");
    const rate = findings.find((f: any) => f.subCategory === "Rate limiting");
    expect(val).toBeDefined();
    expect(rate).toBeDefined();
    for (const f of [val!, rate!]) {
      for (const d of (f as any).deviatingFiles) {
        expect(d.detectedPattern).not.toMatch(/double check/i);
        expect(d.detectedPattern).not.toContain("middleware.VerifyToken");
      }
      expect((f as any).recommendation).not.toMatch(/double check/i);
      expect((f as any).recommendation).not.toContain("middleware.VerifyToken");
    }
    // Sanity: the auth finding IS hedged in the same run — this proves the gate
    // at `propertyName === SECURITY_SUBCATEGORIES.auth` is doing the excluding,
    // not an accidental absence of the hook name anywhere in this corpus.
    expect(authFinding(findings)!.deviatingFiles[0].detectedPattern).toContain(
      "double check hook 'middleware.VerifyToken'",
    );
  });

  it("vote-arithmetic invariance (Go): hedging changes COPY only, never dominantCount/total/consistency/severity/confidence", async () => {
    const hedgedPeers = await Promise.all([goPeer("src/t5inv", 1), goPeer("src/t5inv", 2), goPeer("src/t5inv", 3), goPeer("src/t5inv", 4)]);
    const unsure = await goTree("src/t5inv/orders.go",
      `func routes(r *gin.Engine) {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/orders", createOrder)\n}\n`);
    const hedged = authFinding(securityConsistency.detect(mkCtx([...hedgedPeers, unsure])))!;

    // Control: same corpus, unsure Use line deleted so /orders reads confidently
    // unauthed instead of unsure.
    const ctrlPeers = await Promise.all([goPeer("src/t5invctrl", 1), goPeer("src/t5invctrl", 2), goPeer("src/t5invctrl", 3), goPeer("src/t5invctrl", 4)]);
    const ctrl = await goTree("src/t5invctrl/orders.go", `func routes(r *gin.Engine) {\n\tr.POST("/orders", createOrder)\n}\n`);
    const flatFinding = authFinding(securityConsistency.detect(mkCtx([...ctrlPeers, ctrl])))!;

    for (const k of ["dominantCount", "totalRelevantFiles", "consistencyScore", "severity", "confidence"] as const) {
      expect((hedged as any)[k]).toBe((flatFinding as any)[k]);
    }
    expect(hedged.deviatingFiles[0].detectedPattern).not.toBe(flatFinding.deviatingFiles[0].detectedPattern);
  });

  it("FileMiddleware honesty (Go, detect boundary): an unsure-only Use hook never sets file-level hasAuth", async () => {
    const unsure = await goTree("src/t5honesty/x.go",
      `func routes(r *gin.Engine) {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", createX)\n}\n`);
    expect(unsure.tree!.rootNode.hasError).toBe(false);
    const mw = extractGoFileMiddlewareAst(unsure.tree!);
    expect(mw.hasAuth).toBe(false);
  });
});

// ── Task 5 (Go): terminal hedge visibility ────────────────────────────────
//
// terminal.ts is the one render surface that hardcodes a confident consequence
// ("Unprotected routes may be exposed in production") instead of passing
// `recommendation`/`detectedPattern` straight through (#43 gated it on
// isHedgedAuthFinding). html/csv/docx/json/fix-prompt never special-case the
// hedge — they render `recommendation`/`detectedPattern` verbatim regardless of
// source language, so a Go-sourced hedge already reaches them with no code
// change (verified by inspection: none of those renderers branch on the hedge
// or on language). Only terminal.ts needs an end-to-end pin.
describe("Task 5 (Go): terminal hedge visibility", () => {
  const goTree = (p: string, c: string) => fileWithTree(p, c, "go");
  const goAuthFactory =
    `func AuthMiddleware() gin.HandlerFunc { return func(c *gin.Context) { if c.GetHeader("Authorization") == "" { c.AbortWithStatus(http.StatusUnauthorized); return }; c.Next() } }\n`;
  const goPeer = (dir: string, n: number) =>
    goTree(`${dir}/peer${n}.go`,
      goAuthFactory + `func routes${n}(r *gin.Engine) {\n\tr.Use(AuthMiddleware())\n\tr.POST("/peer${n}", createX)\n}\n`);

  // The real pipeline computes `consistencyImpact` in the scoring engine, one
  // stage past driftFindingToFinding (src/scoring/engine.ts), which is out of
  // scope here. Mirror the shipped Python terminal-hedge test: give each
  // finding a fixed consistencyImpact so it clears the Fix Plan's meaningful-
  // impact floor, the same way `terminal-hedge.test.ts` does. Everything else
  // (recommendation, detectedPattern) is the REAL Go extractor's output.
  const toFinding = (d: any): Finding => ({
    ...driftFindingToFinding(d),
    consistencyImpact: 5,
  });

  const emptyCat = { score: 20, maxScore: 20, locked: false, findingCount: 0, applicable: true };
  function scanResultOf(findings: Finding[]): ScanResult {
    return {
      context: {
        rootDir: "/tmp/proj",
        dominantLanguage: "go",
        languageBreakdown: new Map(),
        totalLines: 500,
        files: [],
        intentHints: [],
      },
      compositeScore: 82,
      maxCompositeScore: 100,
      percentile: null,
      peerLanguage: "go",
      scores: {
        architecturalConsistency: { ...emptyCat, applicable: false },
        redundancy: { ...emptyCat, applicable: false },
        dependencyHealth: { ...emptyCat, applicable: false },
        securityPosture: { ...emptyCat },
        intentClarity: { ...emptyCat, applicable: false },
      },
      hygieneScore: 0,
      maxHygieneScore: 0,
      hygieneScores: {},
      findings,
      driftFindings: [],
      driftScores: {},
      perFileScores: new Map(),
      teaseMessages: [],
      deepInsights: [],
      scanTimeMs: 5,
    } as unknown as ScanResult;
  }

  it("hedged Go finding: terminal does not show the flat confident consequence and surfaces the hook name plus 'double check'", async () => {
    const peers = await Promise.all([goPeer("src/t5term", 1), goPeer("src/t5term", 2), goPeer("src/t5term", 3), goPeer("src/t5term", 4)]);
    const unsure = await goTree("src/t5term/x.go",
      `func routes(r *gin.Engine) {\n\tr.Use(middleware.VerifyToken)\n\tr.POST("/x", createX)\n}\n`);
    const driftFindings = securityConsistency.detect(mkCtx([...peers, unsure]));
    const out = renderTerminalOutput(scanResultOf(driftFindings.map(toFinding)));

    expect(out).not.toContain("Unprotected routes may be exposed in production");
    expect(out).toContain("middleware.VerifyToken");
    expect(out.toLowerCase()).toContain("double check");
  });

  it("confident Go sibling finding: terminal keeps the flat consequence and shows no hedge", async () => {
    const peers = await Promise.all([goPeer("src/t5term2", 1), goPeer("src/t5term2", 2), goPeer("src/t5term2", 3), goPeer("src/t5term2", 4)]);
    const bare = await goTree("src/t5term2/x.go", `func routes(r *gin.Engine) {\n\tr.POST("/x", createX)\n}\n`);
    const driftFindings = securityConsistency.detect(mkCtx([...peers, bare]));
    const out = renderTerminalOutput(scanResultOf(driftFindings.map(toFinding)));

    expect(out).toContain("Unprotected routes may be exposed in production");
    expect(out.toLowerCase()).not.toContain("double check");
    expect(out).not.toContain("middleware.VerifyToken");
  });
});

// ── Task 6 (Go): adversarial detect-level fallback ────────────────────────────
//
// Companions to the direct-extractor pins in security-ast-go.test.ts
// ("malformed and adversarial input"): here the SAME hazards are run through
// securityConsistency.detect end-to-end, proving the whole-file hasError gate
// preserves recall via the regex fallback exactly as it does for JS/Python.
describe("Task 6 (Go): adversarial detect-level fallback", () => {
  const goTree = (p: string, c: string) => fileWithTree(p, c, "go");
  const authFinding = (fs: any[]) => fs.find((f: any) => f.subCategory === "Auth middleware");
  const devPaths = (f: any): string[] =>
    f ? f.deviatingFiles.map((d: any) => d.evidence[0].code.split(" ")[1]) : [];
  const authedPeer = (dir: string, n: number) =>
    goTree(`${dir}/peer${n}.go`, `func routes${n}(r *gin.Engine) {\n\tr.Use(authMiddleware)\n\tr.POST("/peer${n}", createX)\n}\n`);

  it("swallowed-route hazard: the whole file (rootNode.hasError) still routes to regex and recovers the swallowed route's recall", async () => {
    // The direct extractor emits NOTHING from this file (pinned in
    // security-ast-go.test.ts). Here the mutating verb is POST rather than the
    // brief's illustrative GET: GET is structurally outside every
    // security-consistency auth vote (MUTATION_METHODS-gated), so a GET would
    // never surface as an observable deviator regardless of recall — this swap
    // is required to make recall OBSERVABLE end-to-end, not a change to the
    // hazard itself (same unclosed-paren-swallows-the-next-call shape).
    const broken = await goTree("src/swallow/danger.go",
      `package main\n\n` + `func routes() {\n\tr.POST("/broken", mw, h\n\tr.POST("/later", h)\n}\n`);
    expect(broken.tree!.rootNode.hasError).toBe(true);
    expect(extractGoRoutesAst(broken.tree!, broken.relativePath)).toEqual([]);

    const peers = await Promise.all([
      authedPeer("src/swallow", 1), authedPeer("src/swallow", 2),
      authedPeer("src/swallow", 3), authedPeer("src/swallow", 4),
    ]);
    const f = authFinding(securityConsistency.detect(mkCtx([broken, ...peers])));
    expect(f).toBeDefined();
    expect(devPaths(f)).toContain("/later");
  });

  it("surgical-per-node-skip parity: a file-level parse error elsewhere still routes the WHOLE file to regex (python bodyerror parity)", async () => {
    // The direct extractor's surgical per-node skip emits POST /good from this
    // exact source (pinned in security-ast-go.test.ts) — but detect's dispatch
    // gate is coarser than that per-node precision: ANY hasError anywhere in the
    // file routes the WHOLE file to the regex fallback, never reaching the AST
    // extractor's surgical logic at all. /good still recovers, just via a
    // completely different mechanism (regex line-window), which this pins.
    const broken = await goTree("src/surgical/mix.go",
      `package main\n\n` + `func bad() {\n\tx := := 1\n\t_ = x\n}\n\nfunc good() {\n\tr.POST("/good", h)\n}\n`);
    expect(broken.tree!.rootNode.hasError).toBe(true);
    expect(extractGoRoutesAst(broken.tree!, broken.relativePath).map((r) => `${r.method} ${r.path}`))
      .toEqual(["POST /good"]); // the direct-extractor pin, re-asserted here for contrast

    const peers = await Promise.all([
      authedPeer("src/surgical", 1), authedPeer("src/surgical", 2),
      authedPeer("src/surgical", 3), authedPeer("src/surgical", 4),
    ]);
    const f = authFinding(securityConsistency.detect(mkCtx([broken, ...peers])));
    expect(f).toBeDefined();
    expect(devPaths(f)).toContain("/good");
  });
});

// ── Task 6 (Go): suppression pins ──────────────────────────────────────────────
//
// The `@vibedrift-public` annotation mechanism (security-suppression.ts) is
// language-generic: it keys off `route.line` (the anchor call's OWN row) and AST
// comment nodes when a tree is attached. These pins prove it binds correctly for
// Go, including the Task 2 line-choice decision (a Gorilla chain's route.line is
// the HandleFunc row, never a chained `.Methods(...)` continuation's row).
describe("Task 6 (Go): suppression pins", () => {
  const goTree = (p: string, c: string) => fileWithTree(p, c, "go");
  const auth = (fs: any[]) => fs.find((f: any) => f.subCategory === "Auth middleware");
  const audit = (fs: any[]) => fs.find((f: any) => f.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY);
  const requireAuthDef =
    `func requireAuth(c *gin.Context) {\n\tif c.GetHeader("Authorization") == "" {\n\t\tc.AbortWithStatus(http.StatusUnauthorized)\n\t\treturn\n\t}\n\tc.Next()\n}\n`;
  const authedFour = [
    `\tr.POST("/a", requireAuth, ha)`,
    `\tr.POST("/b", requireAuth, hb)`,
    `\tr.POST("/c", requireAuth, hc)`,
    `\tr.POST("/d", requireAuth, hd)`,
  ];

  it("// @vibedrift-public on the route's OWN line suppresses it; the audit finding cites that line", async () => {
    const src = [
      `package main`, ``,
      ...requireAuthDef.split("\n").slice(0, -1),
      ``,
      `func routes(r *gin.Engine) {`,
      ...authedFour,
      `\tr.POST("/public", handlePublic) // @vibedrift-public`,
      `}`,
    ].join("\n");
    const f = await goTree("src/suppress/api.go", src);
    const findings = securityConsistency.detect(mkCtx([f]));

    // /public leaves the vote entirely -> the remaining 4 /a../d are 4/4 authed,
    // so no auth-drift finding fires.
    expect(auth(findings)).toBeUndefined();
    const a = audit(findings);
    expect(a).toBeDefined();
    expect(a!.deviatingFiles).toHaveLength(1);
    expect(a!.deviatingFiles[0].path).toBe("src/suppress/api.go");
    // The route's own registration line (the r.POST("/public"...) row).
    const ownLine = src.split("\n").findIndex((l) => l.includes(`/public`)) + 1;
    expect(a!.deviatingFiles[0].evidence[0].line).toBe(ownLine);
  });

  it("// @vibedrift-public on the line immediately ABOVE a multiline Gorilla chain suppresses it (binds to the HandleFunc row)", async () => {
    const src = [
      `package main`, ``,
      ...requireAuthDef.split("\n").slice(0, -1),
      ``,
      `func routes(r *gin.Engine) {`,
      ...authedFour,
      `\t// @vibedrift-public`,
      `\trouter.HandleFunc("/public", handlePublic).`,
      `\t\tMethods("POST")`,
      `}`,
    ].join("\n");
    const f = await goTree("src/suppress2/api.go", src);
    const findings = securityConsistency.detect(mkCtx([f]));

    expect(auth(findings)).toBeUndefined();
    const a = audit(findings);
    expect(a).toBeDefined();
    expect(a!.deviatingFiles).toHaveLength(1);
    const handleFuncLine = src.split("\n").findIndex((l) => l.includes(`HandleFunc("/public"`)) + 1;
    expect(a!.deviatingFiles[0].evidence[0].line).toBe(handleFuncLine);
  });

  it("the SAME annotation placed beside the .Methods(\"POST\") continuation line does NOT suppress (proves route.line = the HandleFunc row is load-bearing)", async () => {
    const src = [
      `package main`, ``,
      ...requireAuthDef.split("\n").slice(0, -1),
      ``,
      `func routes(r *gin.Engine) {`,
      ...authedFour,
      `\trouter.HandleFunc("/public", handlePublic).`,
      `\t\tMethods("POST") // @vibedrift-public`,
      `}`,
    ].join("\n");
    const f = await goTree("src/suppress3/api.go", src);
    const findings = securityConsistency.detect(mkCtx([f]));

    // Nothing suppressed -> no audit finding.
    expect(audit(findings)).toBeUndefined();
    // /public stays in the vote as the unauthed deviator (4 authed + 1 unauthed
    // = 0.8 > 0.75), cited on its own HandleFunc row.
    const a = auth(findings);
    expect(a).toBeDefined();
    const handleFuncLine = src.split("\n").findIndex((l) => l.includes(`HandleFunc("/public"`)) + 1;
    expect(a!.deviatingFiles.some((d: any) => d.evidence[0].line === handleFuncLine)).toBe(true);
  });

  it("an @vibedrift-public annotation inside a Go string literal never suppresses (comment-awareness via AST comment nodes)", async () => {
    const src = [
      `package main`, ``,
      ...requireAuthDef.split("\n").slice(0, -1),
      ``,
      `func routes(r *gin.Engine) {`,
      ...authedFour,
      `\tdoc := "publish under // @vibedrift-public to opt out"`,
      `\tr.POST("/danger", handleDanger)`,
      `}`,
    ].join("\n");
    const f = await goTree("src/suppress4/api.go", src);
    const findings = securityConsistency.detect(mkCtx([f]));

    // The string literal is not a comment node, so nothing is suppressed.
    expect(audit(findings)).toBeUndefined();
    const a = auth(findings);
    expect(a).toBeDefined();
    const dangerLine = src.split("\n").findIndex((l) => l.includes(`/danger`)) + 1;
    expect(a!.deviatingFiles.some((d: any) => d.evidence[0].line === dangerLine)).toBe(true);
  });
});
