/**
 * Task 7: the enforced precision/recall calibration gate for the Python
 * security extractor (vitest discovers test/**\/*.test.ts, so this runs as
 * part of `npm test`, not just `npm run calibrate`).
 *
 * Five scenarios against test/calibration/python-security-fixture.ts's
 * realistic Flask/FastAPI corpus, each computing precision/recall explicitly
 * against planted ground truth (not just checking the finding fired):
 *   S0  recognition self-check — the route-loss guard. Regresses with a
 *       COUNT, not silent disappearance from the votes below.
 *   S1  primary dominance vote, Flask (8 files, 1 planted deviator).
 *   S2  primary dominance vote, FastAPI (5 files, 1 planted deviator).
 *   S3  uniform-auth-gap fallback (all 8 Flask routes stripped at once).
 *   S4  negative control — uniformly public webhook receivers. Non-vacuity
 *       (routes ARE extracted) is asserted BEFORE zero-findings, per
 *       NEVER-FALSE-BLESS: silence only proves something once we know the
 *       routes were actually seen.
 *   S5  uniformly-authed control — zero findings on every axis.
 */
import { describe, it, expect } from "vitest";
import { securityConsistency } from "../../src/drift/security-consistency.js";
import { SECURITY_SUBCATEGORIES } from "../../src/drift/types.js";
import type { DriftFile } from "../../src/drift/types.js";
import { extractPythonRoutesAst } from "../../src/drift/security-ast-python.js";
import { fileWithTree } from "../helpers/drift-tree.js";
import type { BaselineFile } from "./baseline.js";
import {
  flaskAuthedGroup,
  fastapiAuthedGroup,
  publicByDesignControl,
  uniformlyAuthed,
  pyAuthFile,
  pyAppFile,
  sortedFlaskRoutePaths,
  sortedFastapiRoutePaths,
  stripFlaskAuth,
  stripFastapiAuth,
} from "./python-security-fixture.js";

async function toDriftFiles(files: BaselineFile[]): Promise<DriftFile[]> {
  return Promise.all(files.map((f) => fileWithTree(f.path, f.content, "python")));
}

async function ctxFor(files: BaselineFile[]) {
  const driftFiles = await toDriftFiles(files);
  return {
    files: driftFiles,
    totalLines: driftFiles.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "python",
  };
}

function authFindings(findings: ReturnType<typeof securityConsistency.detect>) {
  return findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.auth);
}

describe("Python calibration: S0 recognition self-check (route-loss guard)", () => {
  it("extracts exactly one route per file across all 13 Flask + FastAPI route files, mixed receiver-naming conventions", async () => {
    const routeFiles = [...flaskAuthedGroup(), ...fastapiAuthedGroup()];
    let total = 0;
    for (const f of routeFiles) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      // A receiver-gate recall regression (structural OR convention-gated)
      // fails HERE with the offending file's path, instead of just silently
      // vanishing from a vote count several layers down.
      expect(routes, f.path).toHaveLength(1);
      total += routes.length;
    }
    expect(total).toBe(13);
  });

  it("extracts exactly 5 routes from the negative control", async () => {
    let total = 0;
    for (const f of publicByDesignControl()) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      total += routes.length;
    }
    expect(total).toBe(5);
  });
});

describe("Python calibration: S1 primary dominance vote, Flask", () => {
  it("flags exactly the one stripped file among 8 Flask blueprints (dominantCount 7, consistencyScore 88)", async () => {
    const strippedPath = sortedFlaskRoutePaths(flaskAuthedGroup())[0];
    const files = [...stripFlaskAuth(flaskAuthedGroup(), 1), pyAuthFile, pyAppFile];
    const ctx = await ctxFor(files);

    const findings = securityConsistency.detect(ctx as any);
    const auth = authFindings(findings);
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.dominantCount).toBe(7);
    expect(finding.totalRelevantFiles).toBe(8);
    expect(finding.consistencyScore).toBe(88);
    expect(finding.severity).toBe("warning");
    expect(finding.confidence).toBe(0.75);
    expect(finding.deviatingFiles.map((d) => d.path)).toEqual([strippedPath]);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([strippedPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Python calibration: S2 primary dominance vote, FastAPI", () => {
  it("flags exactly the one stripped file among 5 FastAPI routers (dominantCount 4, consistencyScore 80)", async () => {
    const strippedPath = sortedFastapiRoutePaths(fastapiAuthedGroup())[0];
    const files = stripFastapiAuth(fastapiAuthedGroup(), 1);
    const ctx = await ctxFor(files);

    const findings = securityConsistency.detect(ctx as any);
    const auth = authFindings(findings);
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.dominantCount).toBe(4);
    expect(finding.totalRelevantFiles).toBe(5);
    expect(finding.consistencyScore).toBe(80);
    expect(finding.severity).toBe("warning");
    expect(finding.confidence).toBe(0.75);
    expect(finding.deviatingFiles.map((d) => d.path)).toEqual([strippedPath]);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([strippedPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Python calibration: S3 uniform-auth-gap fallback", () => {
  it("flags all 8 mutating Flask routes when the primary vote goes silent but the repo uses auth elsewhere", async () => {
    const plantedPaths = sortedFlaskRoutePaths(flaskAuthedGroup());
    // pysrv/auth.py retained (carries the repoHasAuthMachinery evidence);
    // pysrv/app.py deliberately NOT included here — the gap must fire from
    // auth.py's login_required token alone.
    const files = [...stripFlaskAuth(flaskAuthedGroup(), 8), pyAuthFile];
    const ctx = await ctxFor(files);

    const findings = securityConsistency.detect(ctx as any);
    const auth = authFindings(findings);
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.finding).toContain(
      "8 mutating route(s) lack auth while the codebase uses auth elsewhere",
    );
    expect(finding.severity).toBe("error");
    expect(finding.confidence).toBe(0.6);
    expect(finding.deviatingFiles.map((d) => d.path).sort()).toEqual(plantedPaths);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set(plantedPaths);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Python calibration: S4 negative control (uniformly public by design)", () => {
  const MACHINERY =
    /\b(requireAuth|isAuthenticated|verifyToken|authMiddleware|ensureAuth|withAuth|jwt_required|login_required|AuthMiddleware|passport)\b/;

  it("negative control contains no repo auth-machinery token (self-check)", () => {
    for (const f of publicByDesignControl()) {
      expect(MACHINERY.test(f.content), f.path).toBe(false);
    }
  });

  it("non-vacuity FIRST: extracts exactly 5 mutating, unauthed routes before silence can mean anything", async () => {
    let total = 0;
    for (const f of publicByDesignControl()) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
      expect(["POST", "PUT", "PATCH", "DELETE", "ALL"], f.path).toContain(routes[0].method);
      total += routes.length;
    }
    expect(total).toBe(5);
  });

  it("THEN: produces zero security_posture findings", async () => {
    const ctx = await ctxFor(publicByDesignControl());
    const findings = securityConsistency.detect(ctx as any);
    expect(findings.filter((f) => f.driftCategory === "security_posture")).toEqual([]);
  });
});

describe("Python calibration: S5 uniformly-authed control", () => {
  it("produces zero security_posture findings across the whole Flask + FastAPI corpus, incl. validation and rate-limit", async () => {
    const ctx = await ctxFor(uniformlyAuthed());
    const findings = securityConsistency.detect(ctx as any);

    expect(findings.filter((f) => f.driftCategory === "security_posture")).toEqual([]);
    expect(findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.validation)).toEqual([]);
    expect(findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.rateLimit)).toEqual([]);
  });
});
