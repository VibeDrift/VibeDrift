import { describe, it, expect } from "vitest";
import {
  applyRouteSuppressions,
  buildSuppressionAuditFinding,
  SECURITY_SUPPRESSION_ANALYZER_ID,
  SECURITY_SUPPRESSION_SUBCATEGORY,
} from "../../../src/drift/security-suppression.js";
import { computeScores } from "../../../src/scoring/engine.js";
import { fileWithTree } from "../../helpers/drift-tree.js";
import type { DriftFile } from "../../../src/drift/types.js";
import type { RouteInfo } from "../../../src/drift/security-consistency.js";
import type { Finding } from "../../../src/core/types.js";

function file(path: string, content: string, language: DriftFile["language"] = "typescript"): DriftFile {
  return { relativePath: path, language, content, lineCount: content.split("\n").length };
}

function route(overrides: Partial<RouteInfo> & { file: string; line: number }): RouteInfo {
  return {
    method: "POST",
    path: "/x",
    hasAuth: false,
    hasValidation: false,
    hasRateLimit: false,
    hasErrorHandler: false,
    ...overrides,
  };
}

describe("applyRouteSuppressions", () => {
  it("filters out a route whose own line carries // @vibedrift-public", () => {
    const files = [file("src/routes/a.ts", `router.post("/x", handler); // @vibedrift-public\n`)];
    const routes = [route({ file: "src/routes/a.ts", line: 1 })];

    const { kept, suppressed } = applyRouteSuppressions(routes, files);

    expect(kept).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toEqual({
      path: "src/routes/a.ts",
      line: 1,
      reason: "annotation",
      source: "@vibedrift-public",
    });
  });

  it("filters out a route annotated on the line immediately above it", () => {
    const files = [
      file(
        "src/routes/a.ts",
        `// @vibedrift-public\nrouter.post("/x", handler);\n`,
      ),
    ];
    const routes = [route({ file: "src/routes/a.ts", line: 2 })];

    const { kept, suppressed } = applyRouteSuppressions(routes, files);

    expect(kept).toHaveLength(0);
    expect(suppressed).toEqual([
      { path: "src/routes/a.ts", line: 2, reason: "annotation", source: "@vibedrift-public" },
    ]);
  });

  it("matches a block comment annotation", () => {
    const files = [file("src/routes/a.ts", `/* @vibedrift-public */\nrouter.post("/x", handler);\n`)];
    const routes = [route({ file: "src/routes/a.ts", line: 2 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);
    expect(kept).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
  });

  it("matches a Python-style hash comment annotation on a python file", () => {
    const files = [file("src/routes/a.py", `# @vibedrift-public\n@app.route("/x")\n`, "python")];
    const routes = [route({ file: "src/routes/a.py", line: 2 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);
    expect(kept).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
  });

  it("keeps a route with no annotation on its own or preceding line", () => {
    const files = [file("src/routes/a.ts", `router.post("/x", handler);\n`)];
    const routes = [route({ file: "src/routes/a.ts", line: 1 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);
    expect(kept).toEqual(routes);
    expect(suppressed).toHaveLength(0);
  });

  it("does NOT suppress a route just because @vibedrift-public appears elsewhere in the file (precision)", () => {
    const files = [
      file(
        "src/routes/a.ts",
        `// @vibedrift-public\nrouter.post("/annotated", h1);\n\nrouter.post("/unrelated", h2);\n`,
      ),
    ];
    // /unrelated is on line 4; its own line and line 3 (blank) carry no
    // annotation — only line 1, two lines above it, does. Scanning the whole
    // file (instead of just the two adjacent lines) would wrongly suppress it.
    const routes = [
      route({ file: "src/routes/a.ts", line: 2, path: "/annotated" }),
      route({ file: "src/routes/a.ts", line: 4, path: "/unrelated" }),
    ];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);

    expect(kept).toHaveLength(1);
    expect(kept[0].path).toBe("/unrelated");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].path).toBe("src/routes/a.ts");
    expect(suppressed[0].line).toBe(2);
  });

  it("keeps mixed suppressed/kept routes in a multi-route file, suppressing only the annotated one", () => {
    const files = [
      file(
        "src/routes/a.ts",
        `router.post("/one", h1);\n` +
          `router.put("/two", h2);\n` +
          `// @vibedrift-public\n` +
          `router.delete("/three", h3);\n`,
      ),
    ];
    const routes = [
      route({ file: "src/routes/a.ts", line: 1, path: "/one" }),
      route({ file: "src/routes/a.ts", line: 2, path: "/two" }),
      route({ file: "src/routes/a.ts", line: 4, path: "/three" }),
    ];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);

    expect(kept.map((r) => r.path)).toEqual(["/one", "/two"]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].path).toBe("src/routes/a.ts");
    expect(suppressed[0].line).toBe(4);
  });

  it("does not crash and keeps the route when it has no line above it (line 1) and carries no annotation", () => {
    const files = [file("src/routes/a.ts", `router.post("/x", handler);\n`)];
    const routes = [route({ file: "src/routes/a.ts", line: 1 })];
    expect(() => applyRouteSuppressions(routes, files)).not.toThrow();
    const { kept, suppressed } = applyRouteSuppressions(routes, files);
    expect(kept).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });

  it("keeps a route safely when its file cannot be found among the provided files (no crash, no over-suppression)", () => {
    const routes = [route({ file: "src/routes/missing.ts", line: 1 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, []);
    expect(kept).toHaveLength(1);
    expect(suppressed).toHaveLength(0);
  });

  // ── Finding 1: a trailing annotation must bind to its OWN route only ──
  //
  // A trailing `// @vibedrift-public` on route N's own line ALSO sits on the
  // line immediately above route N+1 when they are consecutive. The preceding-
  // line arm must NOT bind that comment to N+1 (which would silently drop an
  // un-annotated route from the vote and hide its auth drift). The comment
  // belongs to N, whose own registration line it shares.
  it("does NOT let a trailing annotation on route N leak onto the consecutive route N+1 (over-suppression)", () => {
    const files = [
      file(
        "src/routes/api.ts",
        `router.post("/public", h); // @vibedrift-public\n` +
          `router.post("/danger", wipeEverything);\n`,
      ),
    ];
    const routes = [
      route({ file: "src/routes/api.ts", line: 1, path: "/public" }),
      route({ file: "src/routes/api.ts", line: 2, path: "/danger" }),
    ];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);

    // Only /public (its own trailing comment) is suppressed. /danger, on the
    // line below, is kept — its "preceding line" is /public's own route line.
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].line).toBe(1);
    expect(kept.map((r) => r.path)).toEqual(["/danger"]);
  });

  // A genuine standalone annotation above a route still binds (regression that
  // the Finding 1 guard didn't over-correct and break the normal case).
  it("still binds a STANDALONE annotation on the line above (preceding line is not a route)", () => {
    const files = [
      file(
        "src/routes/api.ts",
        `router.post("/one", h1);\n` +
          `// @vibedrift-public\n` +
          `router.post("/two", h2);\n`,
      ),
    ];
    const routes = [
      route({ file: "src/routes/api.ts", line: 1, path: "/one" }),
      route({ file: "src/routes/api.ts", line: 3, path: "/two" }),
    ];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].line).toBe(3);
    expect(kept.map((r) => r.path)).toEqual(["/one"]);
  });

  // ── Finding 2: comment-vs-code awareness (no string-literal / cross-lang FPs) ──
  it("does NOT suppress when @vibedrift-public appears inside a STRING LITERAL on the line above (regex fallback)", () => {
    const files = [
      file(
        "src/routes/api.ts",
        `const msg = "see // @vibedrift-public docs";\n` +
          `router.post("/x", handler);\n`,
      ),
    ];
    const routes = [route({ file: "src/routes/api.ts", line: 2 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);
    expect(suppressed).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it("does NOT suppress when @vibedrift-public appears inside a STRING LITERAL on the route's own line (regex fallback)", () => {
    const files = [
      file("src/routes/api.ts", `router.post("/x", handler, "// @vibedrift-public");\n`),
    ];
    const routes = [route({ file: "src/routes/api.ts", line: 1 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);
    expect(suppressed).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it("does NOT apply the Python `#` comment form to a JS/TS route (regex fallback)", () => {
    const files = [
      file(
        "src/routes/api.ts",
        `# @vibedrift-public\n` + `router.post("/x", handler);\n`,
      ),
    ];
    const routes = [route({ file: "src/routes/api.ts", line: 2 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, files);
    expect(suppressed).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it("still suppresses a genuine `// @vibedrift-public` comment (trailing and standalone-above) in the regex fallback", () => {
    const trailing = applyRouteSuppressions(
      [route({ file: "src/routes/a.ts", line: 1 })],
      [file("src/routes/a.ts", `router.post("/x", handler); // @vibedrift-public\n`)],
    );
    expect(trailing.suppressed).toHaveLength(1);

    const above = applyRouteSuppressions(
      [route({ file: "src/routes/b.ts", line: 2 })],
      [file("src/routes/b.ts", `// @vibedrift-public\nrouter.post("/x", handler);\n`)],
    );
    expect(above.suppressed).toHaveLength(1);
  });

  // ── Finding 2, AST path: comment NODES only, string literals excluded ──
  it("uses comment NODES (AST path): a string-literal `// @vibedrift-public` above a route does not suppress", async () => {
    const f = await fileWithTree(
      "src/routes/api.ts",
      `const msg = "see // @vibedrift-public docs";\n` + `router.post("/x", handler);\n`,
    );
    const routes = [route({ file: "src/routes/api.ts", line: 2 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, [f]);
    expect(suppressed).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it("uses comment NODES (AST path): a genuine trailing `// @vibedrift-public` still suppresses", async () => {
    const f = await fileWithTree(
      "src/routes/api.ts",
      `router.post("/x", handler); // @vibedrift-public\n`,
    );
    const routes = [route({ file: "src/routes/api.ts", line: 1 })];
    const { kept, suppressed } = applyRouteSuppressions(routes, [f]);
    expect(suppressed).toHaveLength(1);
    expect(kept).toHaveLength(0);
  });

  it("AST path honors Finding 1: trailing annotation on route N does not leak onto consecutive route N+1", async () => {
    const f = await fileWithTree(
      "src/routes/api.ts",
      `router.post("/public", h); // @vibedrift-public\n` +
        `router.post("/danger", wipeEverything);\n`,
    );
    const routes = [
      route({ file: "src/routes/api.ts", line: 1, path: "/public" }),
      route({ file: "src/routes/api.ts", line: 2, path: "/danger" }),
    ];
    const { kept, suppressed } = applyRouteSuppressions(routes, [f]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].line).toBe(1);
    expect(kept.map((r) => r.path)).toEqual(["/danger"]);
  });
});

describe("buildSuppressionAuditFinding", () => {
  it("cites every exclusion (path:line, reason, source) and counts them accurately", () => {
    const finding = buildSuppressionAuditFinding([
      { path: "src/routes/a.ts", line: 4, reason: "annotation", source: "@vibedrift-public" },
      { path: "src/routes/b.ts", line: 9, reason: "annotation", source: "@vibedrift-public" },
    ]);

    expect(finding.severity).toBe("info");
    expect(finding.driftCategory).toBe("security_posture");
    expect(finding.subCategory).toBe(SECURITY_SUPPRESSION_SUBCATEGORY);
    expect(finding.countBased).toBe(true);
    expect(finding.totalRelevantFiles).toBe(2);
    expect(finding.deviatingFiles).toHaveLength(2);
    expect(finding.finding).toContain("2 route(s)");
    expect(finding.finding).toContain("src/routes/a.ts:4");
    expect(finding.finding).toContain("src/routes/b.ts:9");
    expect(finding.finding).toContain("annotation");
    expect(finding.finding).toContain("@vibedrift-public");
  });

  it("never truncates the reported count, even when the inline citation list is capped", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      path: `src/routes/r${i}.ts`,
      line: 1,
      reason: "annotation" as const,
      source: "@vibedrift-public",
    }));
    const finding = buildSuppressionAuditFinding(many);
    expect(finding.totalRelevantFiles).toBe(15);
    expect(finding.deviatingFiles).toHaveLength(15);
    expect(finding.finding).toContain("15 route(s)");
  });

  it("has no em-dashes or double hyphens in any user-facing string", () => {
    const finding = buildSuppressionAuditFinding([
      { path: "src/routes/a.ts", line: 4, reason: "annotation", source: "@vibedrift-public" },
    ]);
    for (const text of [finding.finding, finding.recommendation]) {
      expect(text).not.toMatch(/—|--/);
    }
  });
});

describe("composite invariance (constraint: a suppression-audit finding never dents the Vibe Drift composite)", () => {
  function driftFinding(): Finding {
    // A real drift-kind finding so the composite starts below 100 — makes
    // the invariance assertion meaningful rather than a vacuous 100 === 100.
    return {
      analyzerId: "naming",
      severity: "error",
      confidence: 0.9,
      message: "naming drift",
      locations: [{ file: "src/a.ts", line: 1 }],
      tags: [],
    };
  }

  function suppressionAuditFinding(): Finding {
    return {
      analyzerId: SECURITY_SUPPRESSION_ANALYZER_ID,
      severity: "info",
      confidence: 1,
      message: "3 route(s) excluded from the security consistency check via @vibedrift-public: a.ts:1, b.ts:2, c.ts:3",
      locations: [{ file: "src/routes/a.ts", line: 1 }],
      tags: ["drift", "security_posture", "cross-file"],
    };
  }

  it("adding a suppression-audit finding does not change compositeScore", () => {
    const base = [driftFinding(), driftFinding()];
    const without = computeScores(base, 30000);
    const withAudit = computeScores([...base, suppressionAuditFinding()], 30000);

    expect(without.compositeScore).toBeLessThan(without.maxCompositeScore);
    expect(withAudit.compositeScore).toBe(without.compositeScore);
    expect(withAudit.scores.securityPosture.score).toBe(without.scores.securityPosture.score);

    // Sanity: the suppression-audit finding IS being processed (proves the
    // invariance above isn't vacuous — it lands on the hygiene track, not
    // that it was silently dropped). An INFO-severity, size-normalized
    // finding barely moves the rounded aggregate hygieneScore in a 30k-line
    // repo (by design — same size-fairness as every other count-based
    // hygiene signal), so assert on the deterministic finding count instead
    // of the float-rounding-sensitive composite.
    expect(without.hygieneScores.securityPosture.findingCount).toBe(0);
    expect(withAudit.hygieneScores.securityPosture.findingCount).toBe(1);
    expect(withAudit.hygieneScore).toBeLessThanOrEqual(without.hygieneScore);
  });

  it("a suppression-audit-only finding set still scores 100 on the drift composite", () => {
    const { compositeScore, maxCompositeScore } = computeScores([suppressionAuditFinding()], 30000);
    expect(compositeScore).toBe(maxCompositeScore);
  });
});
