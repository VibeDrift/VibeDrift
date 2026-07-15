/**
 * Task 7: the enforced precision/recall calibration gate for the Go security
 * extractor (vitest discovers test/**\/*.test.ts, so this runs as part of
 * `npm test`, not just `npm run calibrate`).
 *
 * Nine scenarios against test/calibration/go-security-fixture.ts's realistic
 * Gin/Gorilla corpus, each computing precision/recall explicitly against
 * planted ground truth (not just checking the finding fired). Mirrors
 * security-python.test.ts's S0-S8 structure and ordering; Go has no S9
 * analog (Go deliberately emits "ALL" for a variable-methods form instead of
 * resolving it, so there is no same-file-literal-resolution scenario to
 * pin).
 *
 * LOCKED decision (task-7-brief.md): blessing requires a verifiable reject in
 * a READABLE IN-FILE body, never a name alone. So the authed corpora below
 * (S1, S2, S5, and the four confident peers in S6/S8) bless because their
 * middleware is DEFINED IN-FILE with a body that rejects, never because the
 * middleware's NAME sounds like auth.
 *
 *   S0  recognition self-check — the route-loss guard, PLUS the no-name-bless
 *       classifier pin (imported selector hedges, in-file reject blesses).
 *   S1  primary dominance vote, Gin (8 files, 1 planted deviator).
 *   S2  primary dominance vote, Gorilla (5 files, 1 planted deviator, through
 *       the wrapped-handler bless path).
 *   S3  uniform-auth-gap fallback (all 8 Gin routes stripped at once).
 *   S4  negative control — uniformly public webhook receivers. Non-vacuity
 *       (routes ARE extracted) is asserted BEFORE zero-findings.
 *   S5  uniformly-authed control — zero findings on every axis.
 *   S6  name-auth-but-body-isnt collision (authCheck that only logs): must
 *       NOT suppress the finding.
 *   S7  body-is-real-auth positive (a boring guard() hook): the body
 *       signature alone blesses; no auth-lexicon name anywhere.
 *   S8  unresolvable-body UNSURE (imported auth-flavored middleware): stays
 *       flagged with HEDGED copy naming the hook; counts match S6; S1 stays
 *       flat in the same run.
 */
import { describe, it, expect } from "vitest";
import { securityConsistency } from "../../src/drift/security-consistency.js";
import { SECURITY_SUBCATEGORIES } from "../../src/drift/types.js";
import type { DriftFile } from "../../src/drift/types.js";
import {
  extractGoRoutesAst,
  collectGoFunctionDefs,
  classifyGoMiddlewareAuth,
} from "../../src/drift/security-ast-go.js";
import { fileWithTree } from "../helpers/drift-tree.js";
import type { BaselineFile } from "./baseline.js";
import {
  ginAuthedGroup,
  muxAuthedGroup,
  publicByDesignControl,
  uniformlyAuthed,
  goAuthFile,
  goMainFile,
  sortedGinRoutePaths,
  sortedMuxRoutePaths,
  stripGinAuth,
  stripMuxAuth,
  bodyCollisionGroup,
  bodyCollisionDeviatorPath,
  bodyGateGroup,
  sortedBodyGateRoutePaths,
  stripBodyGate,
  bodyUnsureGroup,
  bodyUnsureDeviatorPath,
} from "./go-security-fixture.js";

async function toDriftFiles(files: BaselineFile[]): Promise<DriftFile[]> {
  return Promise.all(files.map((f) => fileWithTree(f.path, f.content, "go")));
}

async function ctxFor(files: BaselineFile[]) {
  const driftFiles = await toDriftFiles(files);
  return {
    files: driftFiles,
    totalLines: driftFiles.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "go",
  };
}

function authFindings(findings: ReturnType<typeof securityConsistency.detect>) {
  return findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.auth);
}

describe("Go calibration: S0 recognition self-check (route-loss guard + no-name-bless pin)", () => {
  it("extracts exactly one route per file across all 13 gosrv + muxsrv route files, mixed receiver-recognition paths", async () => {
    const routeFiles = [...ginAuthedGroup(), ...muxAuthedGroup()];
    let total = 0;
    for (const f of routeFiles) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      // A receiver-gate or wrap-recognition regression fails HERE with a count
      // and the offending file's path, instead of silently vanishing from a
      // vote count several layers down.
      expect(routes, f.path).toHaveLength(1);
      total += routes.length;
    }
    expect(total).toBe(13);
  });

  it("every muxsrv route resolves method exactly POST (a Methods-chain regression to ALL still passes S2/S5, so this is the only place that pins it)", async () => {
    for (const f of muxAuthedGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes[0].method, f.path).toBe("POST");
    }
  });

  it("extracts exactly 5 routes from the negative control", async () => {
    let total = 0;
    for (const f of publicByDesignControl()) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      total += routes.length;
    }
    expect(total).toBe(5);
  });

  it("no-name-bless classifier pin: an imported selector with no in-file def HEDGES, never blesses; an in-file rejecting body DOES bless", async () => {
    // Negative: a package-qualified selector with no in-file def to resolve
    // is opaque, never a bless. If a name-bless-on-opaque regression landed,
    // these would flip to "auth".
    expect(classifyGoMiddlewareAuth("middleware.AuthMiddleware", null, new Map())).toBe("unsure");
    expect(classifyGoMiddlewareAuth("middleware.RequireAuth", null, new Map())).toBe("unsure");

    // Positive: this is HOW the S1/S2 corpus actually blesses — an in-file
    // def whose body verifiably rejects. If in-file body resolution broke,
    // S1-S5 would silently collapse (their finding counts would go to zero,
    // not throw), so this is pinned as its own assertion.
    const driftFile = await fileWithTree(
      "x.go",
      `package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func AuthMiddleware(c *gin.Context) {
	if c.GetHeader("Authorization") == "" {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	c.Next()
}
`,
      "go",
    );
    const defs = collectGoFunctionDefs(driftFile.tree!.rootNode);
    const def = defs.get("AuthMiddleware")!;
    const body = def.childForFieldName("body")!;
    expect(classifyGoMiddlewareAuth("AuthMiddleware", body, defs)).toBe("auth");
  });
});

describe("Go calibration: S1 primary dominance vote, Gin", () => {
  it("flags exactly the one stripped file among 8 Gin route files (dominantCount 7, consistencyScore 88)", async () => {
    const strippedPath = sortedGinRoutePaths(ginAuthedGroup())[0];
    const files = [...stripGinAuth(ginAuthedGroup(), 1), goAuthFile, goMainFile];
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

describe("Go calibration: S2 primary dominance vote, Gorilla (through the wrapped-handler bless path)", () => {
  it("flags exactly the one stripped file among 5 Gorilla route files (dominantCount 4, consistencyScore 80)", async () => {
    const strippedPath = sortedMuxRoutePaths(muxAuthedGroup())[0];
    const files = stripMuxAuth(muxAuthedGroup(), 1);
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

describe("Go calibration: S3 uniform-auth-gap fallback", () => {
  it("flags all 8 mutating Gin routes when the primary vote goes silent but the repo uses auth elsewhere", async () => {
    const plantedPaths = sortedGinRoutePaths(ginAuthedGroup());
    // gosrv/middleware/auth.go retained (carries the repoHasAuthMachinery
    // evidence); gosrv/main.go deliberately NOT included here — the gap must
    // fire from auth.go's AuthMiddleware token alone.
    const files = [...stripGinAuth(ginAuthedGroup(), 8), goAuthFile];
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

describe("Go calibration: S4 negative control (uniformly public by design)", () => {
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
      const driftFile = await fileWithTree(f.path, f.content, "go");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
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

describe("Go calibration: S5 uniformly-authed control", () => {
  it("non-vacuity FIRST: extracts 13 routes across the corpus, every one authed, before silence can mean anything", async () => {
    let total = 0;
    for (const f of uniformlyAuthed()) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      for (const r of routes) {
        expect(r.hasAuth, `${f.path} ${r.method} ${r.path}`).toBe(true);
        total += 1;
      }
    }
    expect(total).toBe(13);
  });

  it("produces zero security_posture findings across the whole Gin + Gorilla corpus, incl. validation and rate-limit", async () => {
    const ctx = await ctxFor(uniformlyAuthed());
    const findings = securityConsistency.detect(ctx as any);

    expect(findings.filter((f) => f.driftCategory === "security_posture")).toEqual([]);
    expect(findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.validation)).toEqual([]);
    expect(findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.rateLimit)).toEqual([]);
  });
});

// ─── S6-S8: body-signature scenarios ──────────────────────────────────────────
// Each RED-FIRST-verified against a pre-body-first (name-only) classifier: S6's
// authCheck name would have blessed the collision route (zero findings); S7's
// scenario A would have failed non-vacuity (no body-bless, name-only sees
// nothing under "guard"); S8's VerifyToken name would have blessed the
// imported hook (zero findings). All three only pass once body-first lands.

describe("Go calibration: S6 name-auth-but-body-isnt collision (negative)", () => {
  it("non-vacuity FIRST: 5 routes; the authCheck collision route hasAuth false, the unsure key ABSENT", async () => {
    let total = 0;
    for (const f of bodyCollisionGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      if (f.path === bodyCollisionDeviatorPath) {
        expect(routes[0].hasAuth).toBe(false);
        expect("authUnsureHook" in routes[0]).toBe(false); // visible non-auth body: flat, not hedged
      } else {
        expect(routes[0].hasAuth, f.path).toBe(true);
      }
      total += 1;
    }
    expect(total).toBe(5);
  });

  it("flags exactly the collision file (dominantCount 4, score 80), precision 1 recall 1, no-auth copy that is NOT hedged", async () => {
    const ctx = await ctxFor(bodyCollisionGroup());
    const auth = authFindings(securityConsistency.detect(ctx as any));
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.dominantCount).toBe(4);
    expect(finding.totalRelevantFiles).toBe(5);
    expect(finding.consistencyScore).toBe(80);
    expect(finding.deviatingFiles.map((d) => d.path)).toEqual([bodyCollisionDeviatorPath]);

    const dp = finding.deviatingFiles[0].detectedPattern;
    expect(dp.toLowerCase()).toContain("no auth");
    expect(dp.toLowerCase()).not.toContain("double check");

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([bodyCollisionDeviatorPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Go calibration: S7 body-is-real-auth positive (boring guard() hook)", () => {
  const MACHINERY =
    /\b(requireAuth|isAuthenticated|verifyToken|authMiddleware|ensureAuth|withAuth|jwt_required|login_required|AuthMiddleware|passport)\b/;

  it("self-check: the S7 corpus contains no auth-lexicon identifier (only the BODY blesses)", () => {
    for (const f of bodyGateGroup()) {
      expect(MACHINERY.test(f.content), f.path).toBe(false);
    }
  });

  it("scenario A (uniform): all 5 routes hasAuth true via the body signature, THEN zero security_posture findings", async () => {
    let total = 0;
    for (const f of bodyGateGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(true);
      total += 1;
    }
    expect(total).toBe(5);

    const ctx = await ctxFor(bodyGateGroup());
    const findings = securityConsistency.detect(ctx as any);
    expect(findings.filter((f) => f.driftCategory === "security_posture")).toEqual([]);
  });

  it("scenario B: stripping the guard hook from the first sorted file flags exactly it, precision 1 recall 1", async () => {
    const strippedPath = sortedBodyGateRoutePaths(bodyGateGroup())[0];
    const ctx = await ctxFor(stripBodyGate(bodyGateGroup(), 1));
    const auth = authFindings(securityConsistency.detect(ctx as any));
    expect(auth).toHaveLength(1);
    expect(auth[0].dominantCount).toBe(4);
    expect(auth[0].totalRelevantFiles).toBe(5);
    expect(auth[0].consistencyScore).toBe(80);
    expect(auth[0].deviatingFiles.map((d) => d.path)).toEqual([strippedPath]);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([strippedPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Go calibration: S8 unresolvable-body UNSURE (imported auth-flavored middleware)", () => {
  it("non-vacuity FIRST: the unsure route is POST/hasAuth false with authUnsureHook 'middleware.VerifyToken'; the 4 peers omit the key", async () => {
    for (const f of bodyUnsureGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      if (f.path === bodyUnsureDeviatorPath) {
        expect(routes[0].method).toBe("POST");
        expect(routes[0].hasAuth).toBe(false);
        expect(routes[0].authUnsureHook).toBe("middleware.VerifyToken");
      } else {
        expect(routes[0].hasAuth, f.path).toBe(true);
        expect("authUnsureHook" in routes[0], f.path).toBe(false);
      }
    }
  });

  it("flags the unsure file with HEDGED copy; counts match the S6 control; the S1 deviator stays FLAT in the same run", async () => {
    const auth = authFindings(securityConsistency.detect((await ctxFor(bodyUnsureGroup())) as any));
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.deviatingFiles.map((d) => d.path)).toEqual([bodyUnsureDeviatorPath]);
    const dp = finding.deviatingFiles[0].detectedPattern;
    expect(dp).toContain("middleware.VerifyToken");
    expect(dp.toLowerCase()).toContain("double check");
    expect(dp).not.toMatch(/—|--/); // hedged deviator copy carries no em-dash / double hyphen

    expect(finding.recommendation).toContain("Double check");
    expect(finding.recommendation).toContain("middleware.VerifyToken");

    // Vote-arithmetic invariance: S8's counts equal the S6 control (5 files, 1 deviator).
    expect(finding.dominantCount).toBe(4);
    expect(finding.totalRelevantFiles).toBe(5);
    expect(finding.consistencyScore).toBe(80);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([bodyUnsureDeviatorPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall

    // No hedge leakage: a plain stripped-auth deviator (S1 shape) stays flat.
    const s1Path = sortedGinRoutePaths(ginAuthedGroup())[0];
    const s1Files = [...stripGinAuth(ginAuthedGroup(), 1), goAuthFile, goMainFile];
    const s1Auth = authFindings(securityConsistency.detect((await ctxFor(s1Files)) as any));
    expect(s1Auth).toHaveLength(1);
    expect(s1Auth[0].deviatingFiles.map((d) => d.path)).toEqual([s1Path]);
    expect(s1Auth[0].deviatingFiles[0].detectedPattern.toLowerCase()).not.toContain("double check");
  });
});

// ─── Fixture self-check ───────────────────────────────────────────────────────
// Every strip*() helper is exercised at its maximal count (every eligible file
// in the group stripped at once), proving the deterministic string surgery
// never corrupts the surrounding Go source: each output still parses
// error-free and still yields exactly one still-mutating, now-unauthed route.
// A broken strip would otherwise show up ONLY as an unexplained vote-count
// drop in S1/S2/S3/S7, several layers away from the actual bug.

describe("Go calibration: fixture self-check (every strip*() output stays parseable and correctly unauthed)", () => {
  it("stripGinAuth(ginAuthedGroup(), 8): every file parses error-free, one unauthed route, no leftover AuthMiddleware token", async () => {
    for (const f of stripGinAuth(ginAuthedGroup(), 8)) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      expect(driftFile.tree?.rootNode.hasError, f.path).toBe(false);
      expect(f.content, f.path).not.toContain("AuthMiddleware");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
      expect(routes[0].method, f.path).toBe("POST");
    }
  });

  it("stripMuxAuth(muxAuthedGroup(), 5): every file parses error-free, one unauthed route", async () => {
    for (const f of stripMuxAuth(muxAuthedGroup(), 5)) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      expect(driftFile.tree?.rootNode.hasError, f.path).toBe(false);
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
      expect(routes[0].method, f.path).toBe("POST");
    }
  });

  it("stripBodyGate(bodyGateGroup(), 5): every file parses error-free, one unauthed route, no leftover guard token", async () => {
    for (const f of stripBodyGate(bodyGateGroup(), 5)) {
      const driftFile = await fileWithTree(f.path, f.content, "go");
      expect(driftFile.tree?.rootNode.hasError, f.path).toBe(false);
      expect(f.content, f.path).not.toContain("func guard(");
      const routes = extractGoRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
      expect(routes[0].method, f.path).toBe("POST");
    }
  });
});
