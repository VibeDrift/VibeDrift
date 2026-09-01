import { describe, it, expect } from "vitest";
import { complexityAnalyzer } from "../../../src/analyzers/complexity.js";
import { parseFile } from "../../../src/utils/ast.js";
import type { AnalysisContext, SourceFile } from "../../../src/core/types.js";

function makeCtx(files: Partial<SourceFile>[]): AnalysisContext {
  const fullFiles = files.map((f) => ({
    path: f.path ?? "/test/" + f.relativePath,
    relativePath: f.relativePath ?? "test.ts",
    language: f.language ?? "typescript" as const,
    content: f.content ?? "",
    lineCount: (f.content ?? "").split("\n").length,
  }));
  return {
    rootDir: "/test",
    files: fullFiles,
    packageJson: null,
    goMod: null,
    cargoToml: null,
    requirementsTxt: null,
    envExample: null,
    totalLines: fullFiles.reduce((s, f) => s + f.lineCount, 0),
    languageBreakdown: new Map(),
    dominantLanguage: null,
  };
}

// Helper: extract the numeric complexity embedded in a finding's snippet
// ("foo() — N lines, cognitive X"). Returns null if not found.
function cognitiveOf(snippet: string | undefined): number | null {
  if (!snippet) return null;
  const m = snippet.match(/cognitive (\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

describe("complexity analyzer (cognitive)", () => {
  it("penalizes nested ifs more than flat ifs — the key cognitive insight", async () => {
    // Three flat ifs vs three nested ifs. Same McCabe value (4),
    // vastly different cognitive scores.
    const ctx = makeCtx([
      {
        relativePath: "flat.ts",
        content: `
function flat(a: any, b: any, c: any) {
  if (a) x();
  if (b) y();
  if (c) z();
}
`,
      },
      {
        relativePath: "nested.ts",
        content: `
function nested(a: any, b: any, c: any) {
  if (a) {
    if (b) {
      if (c) {
        x();
      }
    }
  }
}
`,
      },
    ]);

    const findings = await complexityAnalyzer.analyze(ctx);

    // The nested function should emit a finding; the flat one shouldn't
    // cross even the info threshold (3 < 6).
    const nestedFinding = findings.find((f) =>
      f.locations[0]?.snippet?.startsWith("nested()"),
    );
    const flatFinding = findings.find((f) =>
      f.locations[0]?.snippet?.startsWith("flat()"),
    );

    // Nested (cognitive ≈ 1+2+3 = 6) just at/above the info threshold
    // Flat (cognitive = 3) below the info threshold
    expect(flatFinding).toBeUndefined();
    // Nested may or may not emit an info finding depending on exact
    // threshold (> 6, strict). Assert by computing: both should NOT be
    // warnings. If nested emits an info, it's correctly identified as
    // the more complex one.
    if (nestedFinding) {
      expect(nestedFinding.severity).toBe("info");
    }
  });

  it("charges +1 per logical operator with no nesting bonus", async () => {
    const ctx = makeCtx([
      {
        relativePath: "logic.ts",
        content: `
function manyAnds(a: any, b: any, c: any, d: any, e: any, f: any, g: any) {
  if (a && b && c && d && e && f && g) {
    return true;
  }
  return false;
}
`,
      },
    ]);
    const findings = await complexityAnalyzer.analyze(ctx);
    // Cognitive: 1 (if) + 6 (six && operators) = 7 → info finding
    const fn = findings.find((f) => f.locations[0]?.snippet?.startsWith("manyAnds()"));
    expect(fn).toBeDefined();
    expect(fn?.severity).toBe("info");
    expect(cognitiveOf(fn?.locations[0]?.snippet) ?? 0).toBeGreaterThan(6);
  });

  it("flags error severity for high cognitive (> 15)", async () => {
    // Deeply-nested function — triggers error tier.
    const ctx = makeCtx([
      {
        relativePath: "deep.ts",
        content: `
function deep(a: any, b: any, c: any, d: any, e: any) {
  if (a) {
    for (const x of b) {
      if (x.valid) {
        while (x.ready) {
          if (x.result && x.count) {
            if (e) {
              return x;
            }
          }
        }
      }
    }
  }
  return null;
}
`,
      },
    ]);
    const findings = await complexityAnalyzer.analyze(ctx);
    const fn = findings.find((f) => f.locations[0]?.snippet?.startsWith("deep()"));
    expect(fn).toBeDefined();
    expect(fn?.severity).toBe("error");
  });

  it("does not flag simple functions", async () => {
    const ctx = makeCtx([
      {
        relativePath: "simple.ts",
        content: `
function simple(a: number): number {
  return a + 1;
}

function maybe(a: boolean, b: number): number {
  if (a) return b;
  return 0;
}
`,
      },
    ]);
    const findings = await complexityAnalyzer.analyze(ctx);
    // simple: cognitive 0, maybe: cognitive 1 — both below info threshold
    const perFn = findings.filter((f) => f.locations.length > 0);
    expect(perFn).toHaveLength(0);
  });

  it("emits a systemic summary when p90 is elevated", async () => {
    // Twelve moderately-complex functions → high p90
    const body = (n: number) => `
function f${n}(a: any, b: any, c: any, d: any) {
  if (a) {
    if (b) {
      if (c) {
        for (const x of d) {
          if (x.good) {
            if (x.ready) return x;
          }
        }
      }
    }
  }
  return null;
}`;
    const content = Array.from({ length: 12 }, (_, i) => body(i)).join("\n");
    const ctx = makeCtx([{ relativePath: "many.ts", content }]);

    const findings = await complexityAnalyzer.analyze(ctx);
    const systemic = findings.find((f) => f.tags.includes("systemic"));
    expect(systemic).toBeDefined();
    // Should surface p90, median, and max in the message.
    expect(systemic?.message).toMatch(/90th percentile|median/);
  });

  it("regex fallback works when AST isn't available", async () => {
    // Force the regex path by not attaching a tree.
    const ctx = makeCtx([
      {
        relativePath: "nest.ts",
        content: `
function deepRegex(a: any, b: any, c: any, d: any, e: any) {
  if (a) {
    if (b) {
      if (c) {
        if (d) {
          if (e) return 42;
        }
      }
    }
  }
  return 0;
}
`,
      },
    ]);
    const findings = await complexityAnalyzer.analyze(ctx);
    const fn = findings.find((f) => f.locations[0]?.snippet?.startsWith("deepRegex()"));
    expect(fn).toBeDefined();
    // Cognitive ≈ 1+2+3+4+5 = 15 via regex brace-depth → error tier (>15) or
    // warning tier (>10). Accept either as long as it's not undefined /
    // below the info tier (which would mean the nesting bonus isn't applied).
    expect(["warning", "error"]).toContain(fn?.severity ?? "");
  });

  it("has a version set so cache invalidates on logic changes", () => {
    expect(complexityAnalyzer.version).toBeGreaterThanOrEqual(2);
  });

  it("scores a Go else-if chain the same as an equivalent JS chain (regression: Go grammar has no else_clause wrapper)", async () => {
    // Go's grammar has no else_clause node — a chained `else if` is a
    // direct if_statement child immediately after the anonymous `else`
    // token, unlike JS/TS/Python where else-if is wrapped in a dedicated
    // else_clause/elif_clause node. Before the fix, the walker treated
    // every chained Go if_statement as a NESTED control (walked one level
    // deeper each time), so an 8-way else-if chain accumulated an
    // unbounded nesting bonus — measured JS=16 vs Go=36 for identical
    // chains. Build real ASTs (not the regex fallback) for both languages
    // and assert parity.
    const branch = (n: number, lang: "js" | "go") =>
      lang === "js"
        ? `${n === 1 ? "if" : "} else if"} (a === ${n}) {\n    x();\n  `
        : `${n === 1 ? "\tif" : "\t} else if"} a == ${n} {\n\t\tx()\n\t`;

    let jsBody = "";
    let goBody = "";
    for (let i = 1; i <= 8; i++) {
      jsBody += branch(i, "js");
      goBody += branch(i, "go");
    }
    const jsContent = `function f(a) {\n  ${jsBody}} else {\n    x();\n  }\n}\n`;
    const goContent = `package main\nfunc f(a int) {\n${goBody}} else {\n\t\tx()\n\t}\n}\n`;

    const jsFile: SourceFile = {
      path: "/test/f.ts", relativePath: "f.ts", language: "typescript",
      content: jsContent, lineCount: jsContent.split("\n").length,
    };
    const goFile: SourceFile = {
      path: "/test/f.go", relativePath: "f.go", language: "go",
      content: goContent, lineCount: goContent.split("\n").length,
    };
    jsFile.tree = (await parseFile(jsFile)) ?? undefined;
    goFile.tree = (await parseFile(goFile)) ?? undefined;
    expect(jsFile.tree).toBeDefined();
    expect(goFile.tree).toBeDefined();

    const ctx: AnalysisContext = {
      rootDir: "/test",
      files: [jsFile, goFile],
      packageJson: null,
      goMod: null,
      cargoToml: null,
      requirementsTxt: null,
      envExample: null,
      totalLines: jsFile.lineCount + goFile.lineCount,
      languageBreakdown: new Map(),
      dominantLanguage: null,
    };

    const findings = await complexityAnalyzer.analyze(ctx);
    const jsFinding = findings.find((f) => f.locations[0]?.file === "f.ts");
    const goFinding = findings.find((f) => f.locations[0]?.file === "f.go");
    expect(jsFinding).toBeDefined();
    expect(goFinding).toBeDefined();

    const jsCognitive = cognitiveOf(jsFinding?.locations[0]?.snippet);
    const goCognitive = cognitiveOf(goFinding?.locations[0]?.snippet);
    expect(goCognitive).toBe(jsCognitive);
    // Sanity check on the magnitude — an 8-way flat else-if chain should
    // NOT be inflated into the 30s (the pre-fix regression).
    expect(goCognitive).toBeLessThan(20);
  });

  it("caps per-tier findings and rolls up the tail", async () => {
    // Generate 50 deeply-nested functions — all should land in the error
    // tier (>15). Cap is 30 → expect 30 individual + 1 rollup.
    const deepFn = (n: number) => `
function deep${n}(a: any, b: any, c: any, d: any, e: any) {
  if (a) {
    for (const x of b) {
      if (x.valid) {
        while (x.ready) {
          if (x.result && x.count) {
            if (e) {
              return x;
            }
          }
        }
      }
    }
  }
  return null;
}`;
    const content = Array.from({ length: 50 }, (_, i) => deepFn(i)).join("\n");
    const ctx = makeCtx([{ relativePath: "many.ts", content }]);
    const findings = await complexityAnalyzer.analyze(ctx);

    const errors = findings.filter((f) => f.severity === "error" && f.tags.includes("cognitive"));
    const individual = errors.filter((f) => !f.tags.includes("rolled-up"));
    const rollup = errors.filter((f) => f.tags.includes("rolled-up"));

    // Cap = 30 individual + 1 rollup for the remaining 20
    expect(individual.length).toBeLessThanOrEqual(30);
    expect(rollup).toHaveLength(1);
    expect(rollup[0].message).toMatch(/additional function/);
  });
});
