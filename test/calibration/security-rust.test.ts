/**
 * Task 6: the enforced precision/recall calibration gate for the Rust
 * security extractor (vitest discovers test/**\/*.test.ts, so this runs as
 * part of `npm test`, not just `npm run calibrate`).
 *
 * Scenarios S0-S8 against test/calibration/rust-security-fixture.ts's
 * realistic Axum + Actix corpus, each computing precision/recall explicitly
 * against planted ground truth (not just checking the finding fired).
 * Mirrors security-go.test.ts / security-python.test.ts's S0-S8 structure.
 *
 * LOCKED decision (security-ast-rust.ts, task-6-brief.md): Rust v1 blesses a
 * route ONLY when a covering (ancestor) `.layer`/`.route_layer` wraps a
 * `middleware::from_fn`/`from_fn_with_state` whose in-file body VERIFIABLY
 * rejects (401-family). There is no name-only bless and no type-name bless.
 * So the authed corpora below (S1, S2, S5, and the four confident peers in
 * S6/S8) bless because their middleware is DEFINED IN-FILE with a body that
 * rejects, never because the middleware's NAME sounds like auth.
 *
 *   S0  recognition self-check — the route-loss guard, PLUS the no-name-bless
 *       classifier pin (an unresolved name hedges, an in-file reject blesses).
 *   S1  primary dominance vote, Axum from_fn (8 files, 2 routes each, 1
 *       planted deviator).
 *   S2  primary dominance vote, Axum from_fn_with_state (5 files, 1 planted
 *       deviator) — a SECOND bless mechanism, proving S1 is not a single code
 *       path.
 *   S3  uniform-auth-gap fallback (all 8 Axum route files stripped at once).
 *   S4  negative control — uniformly public webhook receivers. Non-vacuity
 *       (routes ARE extracted) is asserted BEFORE zero-findings.
 *   S5  uniformly-authed control — zero findings on every axis.
 *   S6  name-auth-but-body-isnt collision (auth_check that only logs): must
 *       NOT suppress the finding.
 *   S7  body-is-real-auth positive (a boring gate() hook): the body signature
 *       alone blesses; no auth-lexicon name anywhere.
 *   S8  unresolvable-body UNSURE (imported require_auth): stays flagged with
 *       HEDGED copy naming the hook; counts match S6; S1 stays flat in the
 *       same run.
 *   Actix addendum: method+path recognition works identically to Axum, but
 *       `.wrap`/request-guard/extractor-typed auth never blesses (the v1
 *       boundary).
 *
 * ARITHMETIC NOTE (audit-first): the task brief's S1 shorthand describes
 * "dominantCount 7, totalRelevantFiles 8" by file count. The actual fixture
 * carries 2 mutating routes per file (POST + DELETE) per the brief's own
 * "realistic code shape", so the applicable-ROUTES denominator is 16, not 8,
 * and stripping 1 file's layer removes auth from its 2 routes. The RATIO is
 * identical (7/8 == 14/16 == 0.875, consistencyScore rounds to 88 either
 * way), but the literal dominantCount/totalRelevantFiles fields are computed
 * and asserted here as 14/16 — verified against analyzeSecurityProperty's own
 * arithmetic (src/drift/security-consistency.ts), not copied from the brief.
 */
import { describe, it, expect } from "vitest";
import { securityConsistency } from "../../src/drift/security-consistency.js";
import { SECURITY_SUBCATEGORIES } from "../../src/drift/types.js";
import type { DriftFile } from "../../src/drift/types.js";
import {
  extractRustRoutesAst,
  classifyRustAuth,
  collectRustFunctionDefs,
} from "../../src/drift/security-ast-rust.js";
import { fileWithTree } from "../helpers/drift-tree.js";
import type { BaselineFile } from "./baseline.js";
import {
  axumAuthedGroup,
  axumStateAuthedGroup,
  rustAuthTokensFile,
  sortedAxumRoutePaths,
  sortedStateRoutePaths,
  stripAxumAuth,
  stripStateAuth,
  publicByDesignControl,
  uniformlyAuthed,
  bodyCollisionGroup,
  bodyCollisionDeviatorPath,
  bodyGateGroup,
  sortedBodyGateRoutePaths,
  stripBodyGate,
  bodyUnsureGroup,
  bodyUnsureDeviatorPath,
  actixRecognitionGroup,
} from "./rust-security-fixture.js";

async function toDriftFiles(files: BaselineFile[]): Promise<DriftFile[]> {
  return Promise.all(files.map((f) => fileWithTree(f.path, f.content, "rust")));
}

async function ctxFor(files: BaselineFile[]) {
  const driftFiles = await toDriftFiles(files);
  return {
    files: driftFiles,
    totalLines: driftFiles.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "rust",
  };
}

function authFindings(findings: ReturnType<typeof securityConsistency.detect>) {
  return findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.auth);
}

const MACHINERY =
  /\b(requireAuth|isAuthenticated|verifyToken|authMiddleware|ensureAuth|withAuth|jwt_required|login_required|AuthMiddleware|passport)\b/;

describe("Rust calibration: S0 recognition self-check (route-loss guard + no-name-bless pin)", () => {
  it("axumAuthedGroup extracts exactly 2 routes per file (POST + DELETE, both authed), 16 total", async () => {
    let total = 0;
    for (const f of axumAuthedGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      // A recognition or in-file body-resolution regression fails HERE with a
      // count and the offending file's path, instead of silently vanishing
      // from a vote count several layers down.
      expect(routes, f.path).toHaveLength(2);
      expect(routes.map((r) => r.method)).toEqual(["POST", "DELETE"]);
      expect(routes.every((r) => r.hasAuth), f.path).toBe(true);
      total += routes.length;
    }
    expect(total).toBe(16);
  });

  it("axumStateAuthedGroup extracts exactly 1 route per file (from_fn_with_state bless), 5 total", async () => {
    let total = 0;
    for (const f of axumStateAuthedGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].method).toBe("POST");
      expect(routes[0].hasAuth, f.path).toBe(true);
      total += routes.length;
    }
    expect(total).toBe(5);
  });

  it("the negative control extracts exactly 5 unauthed routes (non-vacuity)", async () => {
    let total = 0;
    for (const f of publicByDesignControl()) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
      total += routes.length;
    }
    expect(total).toBe(5);
  });

  it("the support / def-only file contributes zero routes", async () => {
    const driftFile = await fileWithTree(rustAuthTokensFile.path, rustAuthTokensFile.content, "rust");
    const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
    expect(routes).toHaveLength(0);
  });

  it("no-name-bless classifier pin: 'require_auth' and 'AuthUser' hedge on name alone; an in-file rejecting body DOES bless", async () => {
    // Negative: an unresolvable (body-less) name is opaque at best, never a
    // bless on its own. If a name-bless-on-opaque regression landed, these
    // would flip to "auth".
    expect(classifyRustAuth("require_auth", null, new Map())).toBe("unsure");
    expect(classifyRustAuth("AuthUser", null, new Map())).toBe("unsure");

    // Positive: this is HOW the S1/S2/S6/S8 corpus actually blesses — an
    // in-file def whose body verifiably rejects. If in-file body resolution
    // broke, S1-S5 would silently collapse (their finding counts would go to
    // zero, not throw), so this is pinned as its own assertion.
    const driftFile = await fileWithTree(
      "x.rs",
      `async fn require_auth(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
        `    let tok = req.headers().get("Authorization");\n` +
        `    if tok.is_none() { return Err(StatusCode::UNAUTHORIZED); }\n` +
        `    Ok(next.run(req).await)\n}\n`,
      "rust",
    );
    const defs = collectRustFunctionDefs(driftFile.tree!.rootNode);
    const def = defs.get("require_auth")!;
    const body = def.childForFieldName("body")!;
    expect(classifyRustAuth("require_auth", body, defs)).toBe("auth");
  });
});

describe("Rust calibration: S1 primary dominance vote, Axum from_fn", () => {
  it("flags exactly the one stripped file's routes among 8 Axum route files (dominantCount 14, consistencyScore 88)", async () => {
    const strippedPath = sortedAxumRoutePaths(axumAuthedGroup())[0];
    const files = [...stripAxumAuth(axumAuthedGroup(), 1), rustAuthTokensFile];
    const ctx = await ctxFor(files);

    const findings = securityConsistency.detect(ctx as any);
    const auth = authFindings(findings);
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    // 8 files x 2 mutating routes = 16 applicable routes; stripping 1 file's
    // layer removes auth from its 2 routes: 14/16 = 0.875 (same ratio as the
    // brief's file-count shorthand 7/8) -> consistencyScore rounds to 88.
    expect(finding.dominantCount).toBe(14);
    expect(finding.totalRelevantFiles).toBe(16);
    expect(finding.consistencyScore).toBe(88);
    expect(finding.severity).toBe("warning");
    expect(finding.confidence).toBe(0.75);
    expect(finding.deviatingFiles).toHaveLength(2); // both routes in the stripped file
    expect(finding.deviatingFiles.every((d) => d.path === strippedPath)).toBe(true);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set([strippedPath]);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Rust calibration: S2 primary dominance vote, Axum from_fn_with_state", () => {
  it("flags exactly the one stripped file among 5 state-scoped route files (dominantCount 4, consistencyScore 80)", async () => {
    const strippedPath = sortedStateRoutePaths(axumStateAuthedGroup())[0];
    const ctx = await ctxFor(stripStateAuth(axumStateAuthedGroup(), 1));

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

describe("Rust calibration: S3 uniform-auth-gap fallback", () => {
  it("flags all 16 mutating Axum routes when the primary vote goes silent but the repo uses auth elsewhere", async () => {
    const plantedPaths = sortedAxumRoutePaths(axumAuthedGroup());
    // rustsrv/auth_tokens.rs retained (carries the repoHasAuthMachinery
    // evidence via the literal `login_required` token); the gap must fire
    // from that token alone, with every in-file require_auth layer stripped.
    const files = [...stripAxumAuth(axumAuthedGroup(), 8), rustAuthTokensFile];
    const ctx = await ctxFor(files);

    const findings = securityConsistency.detect(ctx as any);
    const auth = authFindings(findings);
    expect(auth).toHaveLength(1);
    const finding = auth[0];

    expect(finding.finding).toContain(
      "16 mutating route(s) lack auth while the codebase uses auth elsewhere",
    );
    expect(finding.severity).toBe("error");
    expect(finding.confidence).toBe(0.6);
    expect(finding.dominantCount).toBe(0);
    expect(finding.totalRelevantFiles).toBe(16);
    expect(finding.consistencyScore).toBe(0);
    expect(finding.deviatingFiles).toHaveLength(16); // 8 files x 2 routes
    expect([...new Set(finding.deviatingFiles.map((d) => d.path))].sort()).toEqual(plantedPaths);

    const flagged = new Set(auth.flatMap((f) => f.deviatingFiles.map((d) => d.path)));
    const planted = new Set(plantedPaths);
    const tp = [...flagged].filter((p) => planted.has(p)).length;
    expect(tp / flagged.size).toBe(1); // precision
    expect(tp / planted.size).toBe(1); // recall
  });
});

describe("Rust calibration: S4 negative control (uniformly public by design)", () => {
  it("negative control contains no repo auth-machinery token, no limit/validate token, no CLAUDE.md/AGENTS.md file (self-check)", () => {
    for (const f of publicByDesignControl()) {
      expect(MACHINERY.test(f.content), f.path).toBe(false);
      expect(/limit|validate/i.test(f.content), f.path).toBe(false);
      expect(f.path.toLowerCase()).not.toMatch(/claude\.md|agents\.md/);
    }
  });

  it("non-vacuity FIRST: extracts exactly 5 mutating, unauthed routes before silence can mean anything", async () => {
    let total = 0;
    for (const f of publicByDesignControl()) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
      expect(routes[0].method, f.path).toBe("POST");
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

describe("Rust calibration: S5 uniformly-authed control", () => {
  it("non-vacuity FIRST: extracts 21 routes across the corpus, every one authed, before silence can mean anything", async () => {
    let total = 0;
    for (const f of uniformlyAuthed()) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      for (const r of routes) {
        expect(r.hasAuth, `${f.path} ${r.method} ${r.path}`).toBe(true);
        total += 1;
      }
    }
    expect(total).toBe(21); // 8 files x 2 routes (axum) + 5 routes (state)
  });

  it("produces zero security_posture findings across the whole corpus, incl. validation and rate-limit", async () => {
    const ctx = await ctxFor(uniformlyAuthed());
    const findings = securityConsistency.detect(ctx as any);

    expect(findings.filter((f) => f.driftCategory === "security_posture")).toEqual([]);
    expect(findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.validation)).toEqual([]);
    expect(findings.filter((f) => f.subCategory === SECURITY_SUBCATEGORIES.rateLimit)).toEqual([]);
  });
});

// ─── S6-S8: body-signature scenarios ──────────────────────────────────────────

describe("Rust calibration: S6 name-auth-but-body-isnt collision (negative)", () => {
  it("non-vacuity FIRST: 5 routes; the collision route hasAuth false, the unsure key ABSENT", async () => {
    let total = 0;
    for (const f of bodyCollisionGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
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

describe("Rust calibration: S7 body-is-real-auth positive (boring gate() hook)", () => {
  it("self-check: the S7 corpus contains no auth-lexicon identifier (only the BODY blesses)", () => {
    for (const f of bodyGateGroup()) {
      expect(MACHINERY.test(f.content), f.path).toBe(false);
    }
  });

  it("scenario A (uniform): all 5 routes hasAuth true via the body signature, THEN zero security_posture findings", async () => {
    let total = 0;
    for (const f of bodyGateGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
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

describe("Rust calibration: S8 unresolvable-body UNSURE (imported require_auth)", () => {
  it("non-vacuity FIRST: the unsure route is POST/hasAuth false with authUnsureHook 'require_auth'; the 4 peers omit the key", async () => {
    for (const f of bodyUnsureGroup()) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      if (f.path === bodyUnsureDeviatorPath) {
        expect(routes[0].method).toBe("POST");
        expect(routes[0].hasAuth).toBe(false);
        expect(routes[0].authUnsureHook).toBe("require_auth");
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
    expect(dp).toContain("require_auth");
    expect(dp.toLowerCase()).toContain("double check");
    expect(dp).not.toMatch(/—|--/); // hedged deviator copy carries no em-dash / double hyphen

    expect(finding.recommendation).toContain("Double check");
    expect(finding.recommendation).toContain("require_auth");

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
    const s1Path = sortedAxumRoutePaths(axumAuthedGroup())[0];
    const s1Files = [...stripAxumAuth(axumAuthedGroup(), 1), rustAuthTokensFile];
    const s1Auth = authFindings(securityConsistency.detect((await ctxFor(s1Files)) as any));
    expect(s1Auth).toHaveLength(1);
    expect(s1Auth[0].deviatingFiles.every((d) => d.path === s1Path)).toBe(true);
    expect(
      s1Auth[0].deviatingFiles.every((d) => !d.detectedPattern.toLowerCase().includes("double check")),
    ).toBe(true);
  });
});

// ─── S9: guarded-403 produce-gate (T3 fix #3) ─────────────────────────────────
// A credential-guarded 403 blesses ONLY when the 403 is PRODUCED inside the
// consequence (a `return`/`?`/block-tail reject) — the same produce-position
// gate the 401 path uses. A 403 that merely APPEARS in the guarded branch as a
// call argument, a comparison operand, a struct field, or a discarded `let`
// binding is a MENTION: the middleware reads the header, does NOT reject, and
// falls through to `next.run(...)`, so it must NEVER bless (NEVER-FALSE-BLESS).
// Each negative uses a credential-read guard (so the guarded-403 lane is truly
// exercised) and the auth-flavored name `require_auth`, so a regressed
// (position-agnostic) 403 scan would return "auth"; the correct gate returns
// "unsure" (opaque body + flavored name), which hedges and never blesses.

describe("Rust calibration: S9 guarded-403 produce-gate (never-false-bless)", () => {
  async function classifyFromFn(name: string, src: string) {
    const driftFile = await fileWithTree("mw.rs", src, "rust");
    const defs = collectRustFunctionDefs(driftFile.tree!.rootNode);
    const def = defs.get(name)!;
    const body = def.childForFieldName("body")!;
    return classifyRustAuth(name, body, defs);
  }

  const guard = 'req.headers().get("Authorization").is_none()';

  it("I1: 403 as a call/log argument in the guarded branch does NOT bless (falls through)", async () => {
    const outcome = await classifyFromFn(
      "require_auth",
      `async fn require_auth(req: Request, next: Next) -> Response {\n` +
        `    if ${guard} {\n` +
        `        audit_log(StatusCode::FORBIDDEN, &req);\n` +
        `    }\n` +
        `    next.run(req).await\n}\n`,
    );
    expect(outcome).not.toBe("auth"); // invariant pin
    expect(outcome).toBe("unsure"); // opaque body + flavored name -> hedge, never bless
  });

  it("I2: 403 as a comparison operand in the guarded branch does NOT bless", async () => {
    const outcome = await classifyFromFn(
      "require_auth",
      `async fn require_auth(req: Request, next: Next) -> Response {\n` +
        `    if ${guard} {\n` +
        `        let denied = latest == StatusCode::FORBIDDEN;\n` +
        `        note(denied);\n` +
        `    }\n` +
        `    next.run(req).await\n}\n`,
    );
    expect(outcome).not.toBe("auth");
    expect(outcome).toBe("unsure");
  });

  it("I3: 403 as a struct-literal field in the guarded branch does NOT bless", async () => {
    const outcome = await classifyFromFn(
      "require_auth",
      `async fn require_auth(req: Request, next: Next) -> Response {\n` +
        `    if ${guard} {\n` +
        `        let e = ErrInfo { code: StatusCode::FORBIDDEN, msg: "x" };\n` +
        `        log_err(e);\n` +
        `    }\n` +
        `    next.run(req).await\n}\n`,
    );
    expect(outcome).not.toBe("auth");
    expect(outcome).toBe("unsure");
  });

  it("H: 403 in a discarded `let` binding in the guarded branch does NOT bless", async () => {
    const outcome = await classifyFromFn(
      "require_auth",
      `async fn require_auth(req: Request, next: Next) -> Response {\n` +
        `    if ${guard} {\n` +
        `        let _resp = StatusCode::FORBIDDEN;\n` +
        `    }\n` +
        `    next.run(req).await\n}\n`,
    );
    expect(outcome).not.toBe("auth");
    expect(outcome).toBe("unsure");
  });

  it("PC1 (positive): a guarded `return Err(StatusCode::FORBIDDEN)` produce position DOES bless", async () => {
    const outcome = await classifyFromFn(
      "gate",
      `async fn gate(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
        `    if ${guard} {\n` +
        `        return Err(StatusCode::FORBIDDEN);\n` +
        `    }\n` +
        `    Ok(next.run(req).await)\n}\n`,
    );
    expect(outcome).toBe("auth"); // body-only bless (name 'gate' is not auth-flavored)
  });

  it("PC2 (positive): a guarded block-TAIL `Err(StatusCode::FORBIDDEN)` (if/else value) DOES bless", async () => {
    const outcome = await classifyFromFn(
      "gate",
      `async fn gate(req: Request, next: Next) -> Result<Response, StatusCode> {\n` +
        `    if ${guard} {\n` +
        `        Err(StatusCode::FORBIDDEN)\n` +
        `    } else {\n` +
        `        Ok(next.run(req).await)\n` +
        `    }\n}\n`,
    );
    expect(outcome).toBe("auth");
  });
});

// ─── Actix addendum: method+path recognition without ever blessing ──────────

describe("Rust calibration: Actix recognition addendum (v1 boundary)", () => {
  it("recognizes method+path via attribute macros; an auth-flavored extractor type hedges, never blesses", async () => {
    const f = actixRecognitionGroup().find((x) => x.path.endsWith("orders.rs"))!;
    const driftFile = await fileWithTree(f.path, f.content, "rust");
    const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: "POST", path: "/orders", hasAuth: false, authUnsureHook: "Identity" });
  });

  it("recognizes method+path with a path param; a non-auth extractor type resolves flat not-auth, never blesses", async () => {
    const f = actixRecognitionGroup().find((x) => x.path.endsWith("products.rs"))!;
    const driftFile = await fileWithTree(f.path, f.content, "rust");
    const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("GET");
    expect(routes[0].path).toBe("/products/{id}");
    expect(routes[0].hasAuth).toBe(false);
    expect("authUnsureHook" in routes[0]).toBe(false);
  });

  it("a scope-level .wrap(HttpAuthentication::bearer(...)) never covers an attribute-macro route (structurally invisible), never blesses", async () => {
    const f = actixRecognitionGroup().find((x) => x.path.endsWith("reviews.rs"))!;
    const driftFile = await fileWithTree(f.path, f.content, "rust");
    const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe("DELETE");
    expect(routes[0].path).toBe("/reviews/{id}");
    expect(routes[0].hasAuth).toBe(false);
    expect("authUnsureHook" in routes[0]).toBe(false);
  });
});

// ─── Fixture self-check ───────────────────────────────────────────────────────
// Every strip*() helper is exercised at its maximal count (every eligible
// file in the group stripped at once), proving the deterministic string
// surgery never corrupts the surrounding Rust source: each output still
// parses error-free and still yields exactly the planted, now-unauthed
// route(s). A broken strip would otherwise show up ONLY as an unexplained
// vote-count drop in S1/S2/S3/S7, several layers away from the actual bug.

describe("Rust calibration: fixture self-check (every strip*() output stays parseable and correctly unauthed)", () => {
  it("stripAxumAuth(axumAuthedGroup(), 8): every file parses error-free, 2 unauthed routes, no leftover route_layer call", async () => {
    for (const f of stripAxumAuth(axumAuthedGroup(), 8)) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      expect(driftFile.tree?.rootNode.hasError, f.path).toBe(false);
      expect(f.content, f.path).not.toContain("route_layer");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(2);
      expect(routes.every((r) => !r.hasAuth), f.path).toBe(true);
    }
  });

  it("stripStateAuth(axumStateAuthedGroup(), 5): every file parses error-free, 1 unauthed route, no leftover from_fn_with_state call", async () => {
    for (const f of stripStateAuth(axumStateAuthedGroup(), 5)) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      expect(driftFile.tree?.rootNode.hasError, f.path).toBe(false);
      expect(f.content, f.path).not.toContain("from_fn_with_state");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
    }
  });

  it("stripBodyGate(bodyGateGroup(), 5): every file parses error-free, 1 unauthed route, no leftover gate hook call", async () => {
    for (const f of stripBodyGate(bodyGateGroup(), 5)) {
      const driftFile = await fileWithTree(f.path, f.content, "rust");
      expect(driftFile.tree?.rootNode.hasError, f.path).toBe(false);
      expect(f.content, f.path).not.toContain("from_fn(gate)");
      const routes = extractRustRoutesAst(driftFile.tree!, driftFile.relativePath);
      expect(routes, f.path).toHaveLength(1);
      expect(routes[0].hasAuth, f.path).toBe(false);
    }
  });
});
