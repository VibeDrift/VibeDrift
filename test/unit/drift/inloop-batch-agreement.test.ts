/**
 * Pins the "in-loop can never disagree with batch" guarantee (Task 7).
 *
 * `classifyRouteAuth` (src/drift/route-auth-classify.ts) is the single-body,
 * in-loop `validate_change` security check. It is documented to reuse the
 * SAME AST route extractor the batch security detector uses
 * (`extractJsRoutesAst`), specifically so its verdict can never contradict
 * the batch detector for the same body. That is true "by construction" today
 * — this test makes it executable, so a future change that makes the
 * in-loop path re-derive auth some other way (instead of delegating to
 * `extractJsRoutesAst`) fails a test instead of silently shipping a
 * classifier that can disagree with the scanner.
 *
 * For every fixture body below, we independently recompute the same
 * aggregate `classifyRouteAuth` is documented to compute — straight from
 * `extractJsRoutesAst`, called with no file-level middleware (mirroring the
 * in-loop path, which cannot see router-scope `router.use(...)`) — and
 * assert the two agree.
 */
import { describe, it, expect } from "vitest";
import { classifyRouteAuth } from "../../../src/drift/route-auth-classify.js";
import { extractJsRoutesAst, SECURITY_AST } from "../../../src/drift/security-ast.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import { generateBaseline } from "../../calibration/baseline.js";

interface BatchVerdict {
  isMutatingRoute: boolean;
  hasVisibleAuth: boolean;
}

/**
 * Independently recomputed "batch" verdict for a single body: parse it, run
 * the batch AST route extractor with no file middleware (same invisibility
 * constraint the in-loop check operates under), and reduce to the same shape
 * `classifyRouteAuth` reports. This is a SEPARATE call path from
 * `classifyRouteAuth` (a fresh parse, a fresh `extractJsRoutesAst` call) —
 * not a call into the classifier itself — so a divergence in the classifier's
 * internals shows up as a mismatch here.
 */
async function batchVerdict(body: string, relTarget: string): Promise<BatchVerdict | null> {
  const ext = relTarget.split(".").pop() ?? "";
  const language = ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs" ? "javascript" : "typescript";
  const file = await fileWithTree(relTarget, body, language);
  if (!file.tree) return null;

  const routes = extractJsRoutesAst(file.tree, relTarget, undefined);
  if (routes.length === 0) return null;

  const mutating = routes.filter((r) => SECURITY_AST.MUTATING.has(r.method.toLowerCase()));
  return {
    isMutatingRoute: mutating.length > 0,
    hasVisibleAuth: mutating.every((r) => r.hasAuth === true),
  };
}

/** Asserts classifyRouteAuth and the independently-recomputed batch verdict
 *  agree in full (both null, or both non-null with identical fields). */
async function assertAgreement(body: string, relTarget = "src/routes/new.ts"): Promise<void> {
  const inLoop = await classifyRouteAuth(body, relTarget);
  const batch = await batchVerdict(body, relTarget);
  expect(inLoop, `classifyRouteAuth verdict for ${relTarget}`).toEqual(batch);
}

describe("in-loop classifier vs batch extractor: no-disagreement pin", () => {
  it("agrees on an authed mutating route", async () => {
    await assertAgreement('router.post("/x", requireAuth, (req, res) => { res.json({}); });');
  });

  it("agrees on an unauthed mutating route", async () => {
    await assertAgreement('router.post("/x", (req, res) => { res.json({}); });');
  });

  it("agrees on a GET-only (non-mutating) route", async () => {
    await assertAgreement('router.get("/x", (req, res) => { res.json({}); });');
  });

  it("agrees on array-literal middleware", async () => {
    await assertAgreement('router.post("/x", [requireAuth, validate], (req, res) => { res.json({}); });');
  });

  it("agrees on a non-route body (both null)", async () => {
    await assertAgreement("export function add(a, b) { return a + b; }");
  });

  it("agrees on a body mixing an authed and an unauthed mutating route (conservative case)", async () => {
    const body = [
      'router.post("/a", requireAuth, (req, res) => { res.json({}); });',
      'router.delete("/b", (req, res) => { res.json({}); });',
    ].join("\n");
    await assertAgreement(body);
  });

  it("agrees on a body mixing a mutating and a read-only route", async () => {
    const body = [
      'router.get("/a", (req, res) => { res.json({}); });',
      'router.put("/b", requireAuth, (req, res) => { res.json({}); });',
    ].join("\n");
    await assertAgreement(body);
  });

  // Reuse the calibration fixture route bodies (test/calibration/baseline.ts
  // `route()` output) so the pin covers the SAME bodies the precision/recall
  // corpus scores, not just hand-written cases here.
  it("agrees on every route body in the calibration fixture corpus", async () => {
    const baseline = generateBaseline();
    const routeFiles = baseline.filter((f) => /^src\/routes\//.test(f.path));
    expect(routeFiles.length).toBeGreaterThan(0); // sanity: fixture isn't empty
    for (const f of routeFiles) {
      await assertAgreement(f.content, f.path);
    }
  });
});
