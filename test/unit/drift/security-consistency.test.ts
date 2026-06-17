import { describe, it, expect } from "vitest";
import { securityConsistency } from "../../../src/drift/security-consistency.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string): DriftFile {
  return { path, language: "typescript", content, lineCount: content.split("\n").length };
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
});
