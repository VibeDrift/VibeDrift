/**
 * Task 7: the enforced precision/recall calibration gate for the Python
 * security extractor (vitest discovers test/**\/*.test.ts, so this runs as
 * part of `npm test`, not just `npm run calibrate`).
 *
 * Nine scenarios against test/calibration/python-security-fixture.ts's
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
 *   S6  name-auth-but-body-isnt collision (verify_user_email that only emails):
 *       must NOT suppress the finding. RED-FIRST: pre-addendum the hook name
 *       blessed and the scenario produced ZERO findings.
 *   S7  body-is-real-auth positive (a boring gate() hook: session read +
 *       abort(401)): the body signature alone blesses; no auth-lexicon name
 *       anywhere. RED-FIRST: pre-addendum scenario A fails non-vacuity.
 *   S8  unresolvable-body UNSURE (imported before_request hook): stays flagged
 *       with HEDGED copy naming the hook; counts match S6; S1 stays flat.
 *   S9  methods=variable resolved from a same-file ("POST",) literal: every
 *       route resolves POST. RED-FIRST: pre-addendum they resolved ALL.
 *
 * Task 6 addendum (S10-S11) measures cross-file auth resolution (Tasks 1-5):
 *   S10 an imported before_request hook whose body lives in a SEPARATE
 *       in-repo file blesses via cross-file resolution.
 *   S11 the SAME shape importing from an EXTERNAL package instead stays
 *       hedged (UNSURE), never blesses.
 * INVARIANCE CLAIM: S0-S9 above are single-file / in-file fixtures and
 * reproduce BYTE-IDENTICALLY on this branch; their dominantCount /
 * consistencyScore / precision / recall assertions are untouched. Cross-file
 * resolution runs live in every scenario below (securityConsistency.detect
 * always builds the index), but it never changes an in-file verdict: local
 * defs take precedence over any cross-file candidate.
 */
import { describe, it, expect } from "vitest";
import { securityConsistency } from "../../src/drift/security-consistency.js";
import { SECURITY_SUBCATEGORIES } from "../../src/drift/types.js";
import type { DriftFile } from "../../src/drift/types.js";
import { extractPythonRoutesAst } from "../../src/drift/security-ast-python.js";
import { buildXFileIndex } from "../../src/drift/security-xfile-index.js";
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
  hookCollisionGroup,
  hookCollisionDeviatorPath,
  bodyAuthedGroup,
  sortedBodyRoutePaths,
  stripBodyHook,
  unsureHookGroup,
  unsureHookDeviatorPath,
  methodsVarGroup,
  sortedMethodsVarRoutePaths,
  stripMethodsVarAuth,
  crossFileAuthedGroup,
  pkgAuthFile,
  crossFileExternalGroup,
  sortedCrossFileRoutePaths,
  stripCrossFileAuth,
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

  it("the cross-file def-only support file (pkg/auth.py) contributes zero routes (S10/S11 recognition guard)", async () => {
    const driftFile = await fileWithTree(pkgAuthFile.path, pkgAuthFile.content, "python");
    const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
    expect(routes).toHaveLength(0);
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
  it("non-vacuity FIRST: extracts 13 routes across the corpus, every one authed, before silence can mean anything", async () => {
    // Self-contained guard: zero findings below only means "uniform auth" once we
    // know the routes were actually seen AND recognized as authed. 8 Flask + 5
    // FastAPI route files, one route each; the auth/app/deps support files carry
    // no routes.
    let total = 0;
    for (const f of uniformlyAuthed()) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      for (const r of routes) {
        expect(r.hasAuth, `${f.path} ${r.method} ${r.path}`).toBe(true);
        total += 1;
      }
    }
    expect(total).toBe(13);
  });

  it("produces zero security_posture findings across the whole Flask + FastAPI corpus, incl. validation and rate-limit", async () => {
    const ctx = await ctxFor(uniformlyAuthed());
    const findings = securityConsistency.detect(ctx as any);

    expect(findings.filter((f) => f.driftCategory === "security_posture")).toEqual([]);
    expect(findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.validation)).toEqual([]);
    expect(findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.rateLimit)).toEqual([]);
  });
});

// ─── S6-S9: body-signature + methods-var scenarios (addendum) ────────────────
// Each red-first-verified against pre-addendum behavior (checkout 353a939): S6
// blessed on the hook NAME and produced zero findings; S7 scenario A failed
// non-vacuity (no body-bless); S8 blessed the imported hook by name; S9 routes
// resolved ALL, not POST. S0-S5 above stay byte-identical.

describe("Python calibration: S6 name-auth-but-body-isnt collision (negative)", () => {
  it("non-vacuity FIRST: 5 routes; the verify_user_email collision route hasAuth false, the unsure key ABSENT", async () => {
    let total = 0;
    for (const f of hookCollisionGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      if (f.path === hookCollisionDeviatorPath) {
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
    const ctx = await ctxFor(hookCollisionGroup());
    const auth = authFindings(securityConsistency.detect(ctx as any));
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.dominantCount).toBe(4);
    expect(finding.totalRelevantFiles).toBe(5);
    expect(finding.consistencyScore).toBe(80);
    expect(finding.deviatingFiles.map((d) => d.path)).toEqual([hookCollisionDeviatorPath]);

    const dp = finding.deviatingFiles[0].detectedPattern;
    expect(dp.toLowerCase()).toContain("no auth");
    expect(dp.toLowerCase()).not.toContain("double check");

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([hookCollisionDeviatorPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Python calibration: S7 body-is-real-auth positive (boring gate() hook)", () => {
  const MACHINERY =
    /\b(requireAuth|isAuthenticated|verifyToken|authMiddleware|ensureAuth|withAuth|jwt_required|login_required|AuthMiddleware|passport)\b/;

  it("self-check: the S7 corpus contains no auth-lexicon identifier (only the BODY blesses)", () => {
    for (const f of bodyAuthedGroup()) {
      expect(MACHINERY.test(f.content), f.path).toBe(false);
    }
  });

  it("scenario A (uniform): all 5 routes hasAuth true via the body signature, THEN zero security_posture findings", async () => {
    let total = 0;
    for (const f of bodyAuthedGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(true);
      total += 1;
    }
    expect(total).toBe(5);

    const ctx = await ctxFor(bodyAuthedGroup());
    const findings = securityConsistency.detect(ctx as any);
    expect(findings.filter((f) => f.driftCategory === "security_posture")).toEqual([]);
  });

  it("scenario B: stripping the gate hook from the first sorted file flags exactly it, precision 1 recall 1", async () => {
    const strippedPath = sortedBodyRoutePaths(bodyAuthedGroup())[0];
    const ctx = await ctxFor(stripBodyHook(bodyAuthedGroup(), 1));
    const auth = authFindings(securityConsistency.detect(ctx as any));
    expect(auth).toHaveLength(1);
    expect(auth[0].deviatingFiles.map((d) => d.path)).toEqual([strippedPath]);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([strippedPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Python calibration: S8 unresolvable-body UNSURE (imported before_request hook)", () => {
  it("non-vacuity FIRST: the unsure route is POST/hasAuth false with authUnsureHook 'verify_session'; the 4 peers omit the key", async () => {
    for (const f of unsureHookGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      if (f.path === unsureHookDeviatorPath) {
        expect(routes[0].method).toBe("POST");
        expect(routes[0].hasAuth).toBe(false);
        expect(routes[0].authUnsureHook).toBe("verify_session");
      } else {
        expect(routes[0].hasAuth, f.path).toBe(true);
        expect("authUnsureHook" in routes[0], f.path).toBe(false);
      }
    }
  });

  it("flags the unsure file with HEDGED copy; counts match the S6 control; the S1 deviator stays FLAT in the same run", async () => {
    const auth = authFindings(securityConsistency.detect((await ctxFor(unsureHookGroup())) as any));
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.deviatingFiles.map((d) => d.path)).toEqual([unsureHookDeviatorPath]);
    const dp = finding.deviatingFiles[0].detectedPattern;
    expect(dp).toContain("verify_session");
    expect(dp.toLowerCase()).toContain("double check");
    expect(dp).not.toMatch(/—|--/); // hedged deviator copy carries no em-dash / double hyphen

    // Vote-arithmetic invariance: S8's counts equal the S6 control (5 files, 1 deviator).
    expect(finding.dominantCount).toBe(4);
    expect(finding.totalRelevantFiles).toBe(5);
    expect(finding.consistencyScore).toBe(80);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([unsureHookDeviatorPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall

    // No hedge leakage: a plain stripped-auth deviator (S1 shape) stays flat.
    const s1Path = sortedFlaskRoutePaths(flaskAuthedGroup())[0];
    const s1Files = [...stripFlaskAuth(flaskAuthedGroup(), 1), pyAuthFile, pyAppFile];
    const s1Auth = authFindings(securityConsistency.detect((await ctxFor(s1Files)) as any));
    expect(s1Auth).toHaveLength(1);
    expect(s1Auth[0].deviatingFiles.map((d) => d.path)).toEqual([s1Path]);
    expect(s1Auth[0].deviatingFiles[0].detectedPattern.toLowerCase()).not.toContain("double check");
  });
});

describe("Python calibration: S9 methods=variable resolved from a same-file literal", () => {
  it("non-vacuity FIRST: every one of the 5 routes resolves method exactly POST (never ALL, never GET)", async () => {
    let total = 0;
    for (const f of methodsVarGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].method, f.path).toBe("POST"); // red-first: pre-addendum resolved ALL
      total += 1;
    }
    expect(total).toBe(5);
  });

  it("flags exactly the stripped file among the methods-var-resolved routes, precision 1 recall 1", async () => {
    const strippedPath = sortedMethodsVarRoutePaths(methodsVarGroup())[0];
    const auth = authFindings(
      securityConsistency.detect((await ctxFor(stripMethodsVarAuth(methodsVarGroup(), 1))) as any),
    );
    expect(auth).toHaveLength(1);
    expect(auth[0].deviatingFiles.map((d) => d.path)).toEqual([strippedPath]);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([strippedPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

// ─── S10/S11: cross-file auth resolution (Task 6) ─────────────────────────────
// Measures the cross-file resolution built in Tasks 1-5: a before_request hook
// imported from a SEPARATE in-repo file blesses when its body verifiably
// rejects (S10); the SAME shape importing from an EXTERNAL package instead
// never blesses, only hedges (S11). Both groups share the same 5 relativePaths
// (pkg/<name>_routes.py), so S11's second test recombines files from both to
// build a mixed corpus without a new fixture helper.

describe("Python calibration: S10 cross-file positive (imported hook blesses via cross-file resolution)", () => {
  it("non-vacuity FIRST: every route resolves hasAuth true with authUnsureHook ABSENT via cross-file resolution; pre-cross-file (index absent) the SAME files resolve hasAuth false with authUnsureHook 'verify_session' (the exact S8 shape, the regression S10 pins)", async () => {
    const group = crossFileAuthedGroup();
    const files = [...group, pkgAuthFile];
    const driftFiles = await toDriftFiles(files);
    const index = buildXFileIndex(driftFiles);
    let total = 0;
    for (const f of group) {
      const driftFile = driftFiles.find((d) => d.relativePath === f.path)!;
      const withIndex = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath, index);
      expect(withIndex, f.path).toHaveLength(1);
      expect(withIndex[0].hasAuth, f.path).toBe(true);
      expect("authUnsureHook" in withIndex[0], f.path).toBe(false);

      const withoutIndex = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(withoutIndex[0].hasAuth, f.path).toBe(false);
      expect(withoutIndex[0].authUnsureHook, f.path).toBe("verify_session");
      total += withIndex.length;
    }
    expect(total).toBe(5);
  });

  it("uniform corpus: zero security_posture findings", async () => {
    const ctx = await ctxFor([...crossFileAuthedGroup(), pkgAuthFile]);
    const findings = securityConsistency.detect(ctx as any);
    expect(findings.filter((f) => f.driftCategory === "security_posture")).toEqual([]);
  });

  it("STRIP variant: stripping the first sorted file's cross-file auth flags exactly it (dominantCount 4, score 80), precision 1 recall 1", async () => {
    const strippedPath = sortedCrossFileRoutePaths(crossFileAuthedGroup())[0];
    const files = [...stripCrossFileAuth(crossFileAuthedGroup(), 1), pkgAuthFile];
    const ctx = await ctxFor(files);
    const auth = authFindings(securityConsistency.detect(ctx as any));
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

  it("self-check: pkg/auth.py yields ZERO routes, and stripCrossFileAuth's output still parses cleanly with an unauthed route", async () => {
    const authDriftFile = await fileWithTree(pkgAuthFile.path, pkgAuthFile.content, "python");
    expect(extractPythonRoutesAst(authDriftFile.tree!, authDriftFile.relativePath)).toHaveLength(0);

    for (const f of stripCrossFileAuth(crossFileAuthedGroup(), 5)) {
      const driftFile = await fileWithTree(f.path, f.content, "python");
      expect(driftFile.tree?.rootNode.hasError, f.path).toBe(false);
      expect(f.content, f.path).not.toContain("verify_session");
      const routes = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
    }
  });
});

describe("Python calibration: S11 cross-file external stays unsure (never blesses)", () => {
  it("non-vacuity FIRST: every route hedges (hasAuth false, authUnsureHook 'verify_session'), byte-identical with and without the index (cross-file resolution runs live and still refuses the absolute import)", async () => {
    const group = crossFileExternalGroup();
    const driftFiles = await toDriftFiles(group);
    const index = buildXFileIndex(driftFiles);
    let total = 0;
    for (const f of group) {
      const driftFile = driftFiles.find((d) => d.relativePath === f.path)!;
      const withIndex = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath, index);
      const withoutIndex = extractPythonRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(withIndex, f.path).toEqual(withoutIndex);
      expect(withIndex, f.path).toHaveLength(1);
      expect(withIndex[0].hasAuth, f.path).toBe(false);
      expect(withIndex[0].authUnsureHook, f.path).toBe("verify_session");
      total += withIndex.length;
    }
    expect(total).toBe(5);
  });

  it("mixed with the S10 in-repo group (4 resolve, 1 external): flags the hedged file, dominantCount 4, score 80, no em-dash copy; counts match the S8 control", async () => {
    const authed = crossFileAuthedGroup();
    const external = crossFileExternalGroup();
    const deviatorPath = sortedCrossFileRoutePaths(authed)[0];
    const files = [
      ...authed.filter((f) => f.path !== deviatorPath),
      external.find((f) => f.path === deviatorPath)!,
      pkgAuthFile,
    ];
    const ctx = await ctxFor(files);
    const auth = authFindings(securityConsistency.detect(ctx as any));
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.dominantCount).toBe(4);
    expect(finding.totalRelevantFiles).toBe(5);
    expect(finding.consistencyScore).toBe(80);
    expect(finding.deviatingFiles.map((d) => d.path)).toEqual([deviatorPath]);

    const dp = finding.deviatingFiles[0].detectedPattern;
    expect(dp).toContain("verify_session");
    expect(dp.toLowerCase()).toContain("double check");
    expect(dp).not.toMatch(/—|--/); // hedged deviator copy carries no em-dash / double hyphen

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([deviatorPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });

  it("NO-LEAK cross-check: an S1-shape plain stripped-auth deviator stays FLAT (not hedged) in the same run", async () => {
    const s1Path = sortedFlaskRoutePaths(flaskAuthedGroup())[0];
    const s1Files = [...stripFlaskAuth(flaskAuthedGroup(), 1), pyAuthFile, pyAppFile];
    const s1Auth = authFindings(securityConsistency.detect((await ctxFor(s1Files)) as any));
    expect(s1Auth).toHaveLength(1);
    expect(s1Auth[0].deviatingFiles.map((d) => d.path)).toEqual([s1Path]);
    expect(s1Auth[0].deviatingFiles[0].detectedPattern.toLowerCase()).not.toContain("double check");
  });
});
