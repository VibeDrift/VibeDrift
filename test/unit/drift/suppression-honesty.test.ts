/**
 * Suppression-honesty, end to end (Task 7, Step 3).
 *
 * `test/unit/drift/security-suppression.test.ts` and
 * `test/unit/drift/security-consistency.test.ts` already cover
 * `applyRouteSuppressions` / `securityConsistency.detect` in isolation (raw
 * `DriftFinding[]`). This file adds the one level those don't reach: the REAL
 * `runDriftDetection` entry point (the same function the CLI scan path calls),
 * which converts drift findings to the `Finding[]` shape the CLI, MCP, and
 * scoring engine all consume. It asserts the full chain in one place:
 * suppressing a route removes it from the denominator (no spurious security
 * finding survives to `Finding[]`), AND the exclusion is still cited via a
 * `security-suppression` finding in that same `Finding[]` — suppression never
 * means "disappears without a trace."
 *
 * Covers both suppression mechanisms: the inline `// @vibedrift-public`
 * annotation and the config `security.allowlist` glob.
 */
import { describe, it, expect } from "vitest";
import { runDriftDetection } from "../../../src/drift/index.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import { SECURITY_SUPPRESSION_ANALYZER_ID } from "../../../src/drift/security-suppression.js";
import type { AnalysisContext } from "../../../src/core/types.js";
import type { DriftFile } from "../../../src/drift/types.js";

const SECURITY_DRIFT_ANALYZER_ID = "drift-security_posture";

function ctxFrom(files: DriftFile[], projectConfig?: AnalysisContext["projectConfig"]): AnalysisContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
    projectConfig,
  } as unknown as AnalysisContext;
}

// 4 authed + 1 unauthed mutating route, all in one file: without suppression,
// the unauthed route trips the "Auth middleware" dominance vote (4/5 = 0.8 >
// 0.75). Used by the annotation-based tests, where suppression targets a
// single LINE within the file.
async function fourAuthedOneUnauthed(unauthedLine: (n: string) => string): Promise<DriftFile> {
  return fileWithTree(
    "src/routes/api.ts",
    `router.post("/items", requireAuth, createItem);\n` +
      `router.put("/items/:id", requireAuth, updateItem);\n` +
      `router.patch("/items/:id", requireAuth, patchItem);\n` +
      `router.delete("/items/:id", requireAuth, deleteItem);\n` +
      unauthedLine("router.post"),
  );
}

// Same 4-authed/1-unauthed shape, but the unauthed route lives in its OWN
// file (src/routes/webhook.ts). The config allowlist glob suppresses at FILE
// granularity, so it needs the unauthed route isolated from the 4 authed
// ones to test "suppress exactly the one route" rather than "suppress the
// whole file the 4 authed routes also live in."
async function fourAuthedFile(): Promise<DriftFile> {
  return fileWithTree(
    "src/routes/items.ts",
    `router.post("/items", requireAuth, createItem);\n` +
      `router.put("/items/:id", requireAuth, updateItem);\n` +
      `router.patch("/items/:id", requireAuth, patchItem);\n` +
      `router.delete("/items/:id", requireAuth, deleteItem);\n`,
  );
}
async function oneUnauthedFile(): Promise<DriftFile> {
  return fileWithTree("src/routes/webhook.ts", `router.post("/public/webhook", handleWebhook);\n`);
}

describe("suppression honesty end to end (runDriftDetection)", () => {
  it("sanity: WITHOUT suppression, the unauthed route trips a security_posture finding through the full pipeline", async () => {
    const f = await fourAuthedOneUnauthed(() => `router.post("/public/webhook", handleWebhook);\n`);
    const result = runDriftDetection(ctxFrom([f]));

    const authFinding = result.findings.find((fnd) => fnd.analyzerId === SECURITY_DRIFT_ANALYZER_ID);
    expect(authFinding, "expected the unauthed route to trip a security_posture finding").toBeDefined();
    expect(result.findings.find((fnd) => fnd.analyzerId === SECURITY_SUPPRESSION_ANALYZER_ID)).toBeUndefined();
  });

  it("@vibedrift-public annotation: no security finding is emitted, and the suppression audit finding carries the count", async () => {
    const f = await fourAuthedOneUnauthed(
      () => `// @vibedrift-public\nrouter.post("/public/webhook", handleWebhook);\n`,
    );
    const result = runDriftDetection(ctxFrom([f]));

    // Denominator stays honest: the annotated route is out, remaining 4 are
    // 4/4 authed, so no auth-drift finding survives to Finding[].
    const authFinding = result.findings.find((fnd) => fnd.analyzerId === SECURITY_DRIFT_ANALYZER_ID);
    expect(authFinding, "suppressed route must not produce a security_posture finding").toBeUndefined();

    // The exclusion is still cited and counted.
    const auditFinding = result.findings.find((fnd) => fnd.analyzerId === SECURITY_SUPPRESSION_ANALYZER_ID);
    expect(auditFinding, "expected a suppression audit finding").toBeDefined();
    expect(auditFinding!.message).toContain("1 route(s)");
    expect(auditFinding!.message).toContain("src/routes/api.ts:6");
    expect(auditFinding!.message).toContain("annotation");
  });

  it("config security.allowlist: no security finding is emitted, and the suppression audit finding cites the matching glob", async () => {
    const items = await fourAuthedFile();
    const webhook = await oneUnauthedFile();
    const ctx = ctxFrom([items, webhook], { version: 1, security: { allowlist: ["src/routes/webhook.ts"] } });
    const result = runDriftDetection(ctx);

    const authFinding = result.findings.find((fnd) => fnd.analyzerId === SECURITY_DRIFT_ANALYZER_ID);
    expect(authFinding, "allowlisted route must not produce a security_posture finding").toBeUndefined();

    const auditFinding = result.findings.find((fnd) => fnd.analyzerId === SECURITY_SUPPRESSION_ANALYZER_ID);
    expect(auditFinding, "expected a suppression audit finding").toBeDefined();
    expect(auditFinding!.message).toContain("1 route(s)");
    expect(auditFinding!.message).toContain("allowlist");
    expect(auditFinding!.message).toContain("src/routes/webhook.ts");
  });

  it("a non-matching allowlist glob does not suppress: the security finding still fires and no audit finding appears", async () => {
    const items = await fourAuthedFile();
    const webhook = await oneUnauthedFile();
    const ctx = ctxFrom([items, webhook], { version: 1, security: { allowlist: ["src/completely/unrelated/**"] } });
    const result = runDriftDetection(ctx);

    expect(result.findings.find((fnd) => fnd.analyzerId === SECURITY_DRIFT_ANALYZER_ID)).toBeDefined();
    expect(result.findings.find((fnd) => fnd.analyzerId === SECURITY_SUPPRESSION_ANALYZER_ID)).toBeUndefined();
  });
});
