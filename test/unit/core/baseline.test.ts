import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBaseline,
  assembleBaseline,
  writeBaseline,
  loadBaseline,
  loadBaselineUnchecked,
  computeBaselineKey,
  votesFromFindings,
  securitySubVotesFromFindings,
} from "../../../src/core/baseline.js";
import { buildAnalysisContext } from "../../../src/core/discovery.js";
import { runDriftDetection } from "../../../src/drift/index.js";
import { parseFiles } from "../../../src/utils/ast.js";
import { securityConsistency } from "../../../src/drift/security-consistency.js";
import {
  SECURITY_SUPPRESSION_SUBCATEGORY,
  SECURITY_SUPPRESSION_ANALYZER_ID,
} from "../../../src/drift/security-suppression.js";
import { fileDriftFromBaseline } from "../../../src/tools-core/tools/check-file-drift.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { DriftContext } from "../../../src/drift/types.js";
import type { DriftFinding } from "../../../src/drift/types.js";

function fakeFinding(overrides: Partial<DriftFinding>): DriftFinding {
  return {
    detector: "test",
    driftCategory: "async_patterns",
    severity: "warning",
    confidence: 0.9,
    finding: "x",
    dominantPattern: "async_await",
    dominantCount: 8,
    totalRelevantFiles: 10,
    consistencyScore: 80,
    deviatingFiles: [{ path: "c.ts", detectedPattern: "then_chains", evidence: [] }],
    dominantFiles: ["a.ts", "b.ts"],
    recommendation: "use async/await",
    ...overrides,
  };
}

describe("votesFromFindings", () => {
  it("maps each driftCategory to a vote carrying the dominant tally + deviator paths", () => {
    const votes = votesFromFindings([
      fakeFinding({ driftCategory: "async_patterns" }),
      fakeFinding({
        driftCategory: "naming_conventions",
        dominantPattern: "camelCase",
        dominantCount: 12,
        totalRelevantFiles: 14,
        consistencyScore: 86,
        dominantFiles: ["x.ts"],
        deviatingFiles: [{ path: "snake.ts", detectedPattern: "snake_case", evidence: [] }],
      }),
    ]);
    expect(Object.keys(votes).sort()).toEqual(["async_patterns", "naming_conventions"]);
    const a = votes.async_patterns!;
    expect(a.dominantPattern).toBe("async_await");
    expect(a.dominantCount).toBe(8);
    expect(a.totalRelevantFiles).toBe(10);
    expect(a.consistencyScore).toBe(80);
    expect(a.dominantFiles).toEqual(["a.ts", "b.ts"]);
    expect(a.deviators).toEqual([{ path: "c.ts", detectedPattern: "then_chains" }]);
    expect(votes.naming_conventions!.dominantPattern).toBe("camelCase");
    expect(votes.naming_conventions!.deviators).toEqual([{ path: "snake.ts", detectedPattern: "snake_case" }]);
  });

  it("when a category has multiple findings, keeps the one covering the most files", () => {
    const votes = votesFromFindings([
      fakeFinding({ driftCategory: "architectural_consistency", dominantPattern: "repository", totalRelevantFiles: 3 }),
      fakeFinding({ driftCategory: "architectural_consistency", dominantPattern: "raw_sql", totalRelevantFiles: 9 }),
    ]);
    expect(votes.architectural_consistency!.dominantPattern).toBe("raw_sql"); // 9 > 3
    expect(votes.architectural_consistency!.totalRelevantFiles).toBe(9);
  });

  it("handles a missing optional dominantFiles as an empty array", () => {
    const votes = votesFromFindings([fakeFinding({ dominantFiles: undefined })]);
    expect(votes.async_patterns!.dominantFiles).toEqual([]);
  });

  it("keeps auth/validation/rate-limit as SEPARATE security sub-votes (no collision)", () => {
    const subVotes = securitySubVotesFromFindings([
      fakeFinding({ driftCategory: "security_posture", subCategory: "Auth middleware", dominantPattern: "Auth middleware applied", totalRelevantFiles: 5, consistencyScore: 80 }),
      fakeFinding({ driftCategory: "security_posture", subCategory: "Rate limiting", dominantPattern: "Rate limiting applied", totalRelevantFiles: 12, consistencyScore: 60 }),
    ]);
    // Both survive under their own key — the widest-denominator finding does NOT
    // evict the other (which is the perCategoryVote collision this fixes).
    expect(subVotes["Auth middleware"]!.dominantPattern).toBe("Auth middleware applied");
    expect(subVotes["Rate limiting"]!.dominantPattern).toBe("Rate limiting applied");
    expect(subVotes["Auth middleware"]!.totalRelevantFiles).toBe(5);
  });
});

// ── Suppression-audit finding must never enter the persisted baseline votes ──
//
// buildSuppressionAuditFinding (security-suppression.ts) emits a hygiene audit
// trail ("N routes excluded"), tagged driftCategory: security_posture and
// subCategory: SECURITY_SUPPRESSION_SUBCATEGORY, so it can render in the CLI's
// hygiene pane. Left unfiltered, it also satisfied both vote builders above:
// it could win the widest-denominator perCategoryVote.security_posture slot
// (worse, it was the ONLY security_posture finding when a suppression removed
// the repo's one real deviator), and it always populated a bogus
// securitySubVotes["Suppression audit"] entry. Either leak means
// check_file_drift's fileDriftFromBaseline (src/tools-core/tools/check-file-drift.ts)
// could report a nonsensical deviation ("route excluded from the security
// consistency check") for a file that was correctly suppressed, not drifting.
describe("suppression-audit finding excluded from persisted baseline votes", () => {
  function mkCtx(files: Awaited<ReturnType<typeof fileWithTree>>[]): DriftContext {
    return { files, totalLines: files.reduce((s, f) => s + f.lineCount, 0), dominantLanguage: "typescript" };
  }

  it("does not let the audit finding win securitySubVotes or displace a real security_posture vote", async () => {
    // Mixed fixture: a trailing annotation suppresses /public, but the
    // un-annotated /danger route on the next line still drifts (no auth) —
    // so this scan produces BOTH the audit finding and a real "Auth
    // middleware" dominance finding for the same security_posture category.
    const f = await fileWithTree(
      "src/routes/api.ts",
      `router.post("/items", requireAuth, createItem);\n` +
        `router.put("/items/:id", requireAuth, updateItem);\n` +
        `router.patch("/items/:id", requireAuth, patchItem);\n` +
        `router.delete("/items/:id", requireAuth, deleteItem);\n` +
        `router.post("/public", handlePublic); // @vibedrift-public\n` +
        `router.post("/danger", wipeEverything);\n`,
    );
    const findings = securityConsistency.detect(mkCtx([f]));
    expect(findings.some((fnd) => fnd.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY)).toBe(true);
    expect(findings.some((fnd) => fnd.subCategory === "Auth middleware")).toBe(true);

    const subVotes = securitySubVotesFromFindings(findings);
    expect(subVotes[SECURITY_SUPPRESSION_SUBCATEGORY]).toBeUndefined();
    expect(Object.keys(subVotes)).not.toContain("Suppression audit");

    const votes = votesFromFindings(findings);
    expect(votes.security_posture).toBeDefined();
    expect(votes.security_posture!.dominantPattern).not.toBe(
      "route excluded from the security consistency check",
    );
    expect(votes.security_posture!.dominantPattern).toBe("Auth middleware applied");
  });

  // The key scenario: suppression removes the repo's ONLY deviator, so no
  // real security dominance finding fires at all. Before the fix, the audit
  // finding was the sole security_posture finding and so WON the
  // perCategoryVote slot by default, and check_file_drift would then report
  // the suppressed file itself as deviating in security_posture.
  it("when suppression removes the only deviator, no real vote fires: perCategoryVote.security_posture is ABSENT (not the audit finding), and the suppressed file gets no bogus deviation", async () => {
    const f = await fileWithTree(
      "src/routes/api.ts",
      `router.post("/items", requireAuth, createItem);\n` +
        `router.put("/items/:id", requireAuth, updateItem);\n` +
        `router.patch("/items/:id", requireAuth, patchItem);\n` +
        `router.delete("/items/:id", requireAuth, deleteItem);\n` +
        `// @vibedrift-public\n` +
        `router.post("/public/webhook", handleWebhook);\n`,
    );
    const findings = securityConsistency.detect(mkCtx([f]));

    // Only the audit finding fires — suppression made the remaining routes
    // 4-of-4 authed, so no auth-drift finding exists to compete with it.
    expect(findings).toHaveLength(1);
    expect(findings[0].subCategory).toBe(SECURITY_SUPPRESSION_SUBCATEGORY);

    const votes = votesFromFindings(findings);
    expect(votes.security_posture).toBeUndefined();

    const subVotes = securitySubVotesFromFindings(findings);
    expect(subVotes[SECURITY_SUPPRESSION_SUBCATEGORY]).toBeUndefined();

    const baseline = {
      key: "k",
      rootDir: "/repo",
      ctxFiles: [],
      perCategoryVote: votes,
      securitySubVotes: subVotes,
      intentHints: [],
      minhashIndex: [],
      builtAt: 0,
    };
    const { fits, deviations } = fileDriftFromBaseline(baseline, "src/routes/api.ts");
    expect(deviations.find((d) => d.dimension === "security_posture")).toBeUndefined();
    expect(fits).toBe(true);
  });

  // End-to-end through the real scan pipeline (buildAnalysisContext +
  // runDriftDetection + assembleBaseline), confirming: (1) the audit finding
  // still reaches result.findings so the CLI render is unaffected, while (2)
  // it is excluded from the persisted baseline this same scan writes.
  describe("end-to-end scan (buildAnalysisContext -> runDriftDetection -> assembleBaseline)", () => {
    let repo: string;
    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), "vd-baseline-suppression-"));
      writeFileSync(
        join(repo, "api.ts"),
        `router.post("/items", requireAuth, createItem);\n` +
          `router.put("/items/:id", requireAuth, updateItem);\n` +
          `router.patch("/items/:id", requireAuth, patchItem);\n` +
          `router.delete("/items/:id", requireAuth, deleteItem);\n` +
          `// @vibedrift-public\n` +
          `router.post("/public/webhook", handleWebhook);\n`,
      );
    });
    afterAll(() => rmSync(repo, { recursive: true, force: true }));

    it("keeps the audit finding in result.findings but not in the persisted baseline votes", async () => {
      const { ctx } = await buildAnalysisContext(repo);
      await parseFiles(ctx.files);
      const { findings, driftFindings } = runDriftDetection(ctx);

      // Render path unaffected: the audit finding still lands in result.findings.
      expect(findings.some((fnd) => fnd.analyzerId === SECURITY_SUPPRESSION_ANALYZER_ID)).toBe(true);

      const baseline = assembleBaseline(repo, ctx, driftFindings);
      expect(baseline.perCategoryVote.security_posture).toBeUndefined();
      expect(baseline.securitySubVotes?.[SECURITY_SUPPRESSION_SUBCATEGORY]).toBeUndefined();

      const { deviations } = fileDriftFromBaseline(baseline, "api.ts");
      expect(deviations.find((d) => d.dimension === "security_posture")).toBeUndefined();
    });
  });
});

describe("computeBaselineKey", () => {
  const files = [
    { path: "b.ts", hash: "bbb" },
    { path: "a.ts", hash: "aaa" },
  ];

  it("is order-independent (sorted by path before hashing)", () => {
    const k1 = computeBaselineKey(files);
    const k2 = computeBaselineKey([...files].reverse());
    expect(k1).toBe(k2);
  });

  it("changes when any file's content hash changes", () => {
    const k1 = computeBaselineKey(files);
    const k2 = computeBaselineKey([{ path: "a.ts", hash: "aaa" }, { path: "b.ts", hash: "ZZZ" }]);
    expect(k1).not.toBe(k2);
  });
});

describe("buildBaseline + persistence round-trip", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "vd-baseline-"));
    writeFileSync(join(repo, "a.ts"), "export async function a(){ return await fetch('/x'); }\n");
    writeFileSync(join(repo, "b.ts"), "export async function b(){ return await fetch('/y'); }\n");
    writeFileSync(join(repo, "c.ts"), "export function c(){ return fetch('/z').then(r => r.json()); }\n");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("builds a structurally-valid baseline whose key matches its files", async () => {
    const b = await buildBaseline(repo);
    expect(b.rootDir).toBe(repo);
    expect(b.key).toBe(computeBaselineKey(b.ctxFiles));
    expect(b.ctxFiles.length).toBe(3);
    expect(typeof b.builtAt).toBe("number");
    expect(Array.isArray(b.intentHints)).toBe(true);
    expect(typeof b.perCategoryVote).toBe("object");
    // three top-level functions extracted, each with a 128-wide MinHash signature
    expect(b.minhashIndex.length).toBeGreaterThanOrEqual(3);
    expect(b.minhashIndex[0].signature).toBeInstanceOf(Uint32Array);
    expect(b.minhashIndex[0].signature.length).toBe(128);
    expect(b.minhashIndex[0].tokens.length).toBeGreaterThan(0);
  });

  it("persists and reloads an identical baseline (signatures survive as Uint32Array)", async () => {
    const built = await buildBaseline(repo);
    await writeBaseline(built);
    const loaded = await loadBaseline(repo, built.key);
    expect(loaded).not.toBeNull();
    expect(loaded!.key).toBe(built.key);
    expect(loaded!.minhashIndex.length).toBe(built.minhashIndex.length);
    expect(loaded!.minhashIndex[0].signature).toBeInstanceOf(Uint32Array);
    expect(loaded!.minhashIndex[0].signature.length).toBe(128);
    expect(Array.from(loaded!.minhashIndex[0].signature)).toEqual(Array.from(built.minhashIndex[0].signature));
  });

  it("loadBaseline returns null on a key mismatch (content changed)", async () => {
    const built = await buildBaseline(repo);
    await writeBaseline(built);
    expect(await loadBaseline(repo, "deadbeef".repeat(8))).toBeNull();
  });

  it("loadBaselineUnchecked returns the stored baseline regardless of key (for staleness checks)", async () => {
    const built = await buildBaseline(repo);
    await writeBaseline(built);
    const loaded = await loadBaselineUnchecked(repo);
    expect(loaded).not.toBeNull();
    expect(loaded!.key).toBe(built.key);
    expect(loaded!.rootDir).toBe(repo);
  });

  it("assembleBaseline (the scan side-effect path) agrees with standalone buildBaseline", async () => {
    const { ctx } = await buildAnalysisContext(repo);
    const { driftFindings } = runDriftDetection(ctx);
    const assembled = assembleBaseline(repo, ctx, driftFindings);
    const standalone = await buildBaseline(repo);
    expect(assembled.key).toBe(standalone.key);
    expect(assembled.minhashIndex.length).toBe(standalone.minhashIndex.length);
    expect(Object.keys(assembled.perCategoryVote).sort()).toEqual(
      Object.keys(standalone.perCategoryVote).sort(),
    );
  });
});
