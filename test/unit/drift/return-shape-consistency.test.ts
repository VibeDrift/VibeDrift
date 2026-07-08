import { describe, it, expect } from "vitest";
import { returnShapeConsistency, classifyReturnShapeLabel } from "../../../src/drift/return-shape-consistency.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function makeCtx(files: Partial<DriftFile>[]): DriftContext {
  const fullFiles: DriftFile[] = files.map((f) => ({
    relativePath: f.relativePath ?? "src/test.ts",
    language: f.language ?? "typescript",
    content: f.content ?? "",
    lineCount: (f.content ?? "").split("\n").length,
  }));
  return {
    files: fullFiles,
    totalLines: fullFiles.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

// Sibling helpers in the same dir — reach the MIN_GROUP_SIZE=3 threshold.
function makeHandlers(entries: { name: string; body: string }[]): DriftFile[] {
  return entries.map((e) => ({
    relativePath: `src/handlers/${e.name}.ts`,
    language: "typescript",
    content: `export function ${e.name}() {\n${e.body}\n}\n`,
    lineCount: e.body.split("\n").length + 2,
  }));
}

describe("return-shape-consistency detector", () => {
  it("flags the odd result-object sibling when peers all throw", () => {
    const ctx = makeCtx(
      makeHandlers([
        { name: "getUser", body: "  if (!id) throw new NotFoundError('no id');\n  return db.user(id);" },
        { name: "getOrder", body: "  if (!id) throw new NotFoundError('no order');\n  return db.order(id);" },
        { name: "getItem", body: "  if (!id) throw new NotFoundError('no item');\n  return db.item(id);" },
        { name: "getProduct", body: "  if (!id) throw new NotFoundError('no prod');\n  return db.prod(id);" },
        { name: "getCart", body: "  if (!id) return { status: 404, error: 'not found' };\n  return db.cart(id);" },
      ]),
    );

    const findings = returnShapeConsistency.detect(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].driftCategory).toBe("return_shape_consistency");
    expect(findings[0].dominantPattern).toBe("throws on error");
    expect(findings[0].dominantCount).toBe(4);
    expect(findings[0].deviatingFiles).toHaveLength(1);
    expect(findings[0].deviatingFiles[0].path).toContain("getCart");
    expect(findings[0].deviatingFiles[0].detectedPattern).toBe("error-object returns");
  });

  it("returns no finding when all siblings agree", () => {
    const ctx = makeCtx(
      makeHandlers([
        { name: "getA", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getB", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getC", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getD", body: "  if (!id) throw new Error('x');\n  return data;" },
      ]),
    );

    expect(returnShapeConsistency.detect(ctx)).toHaveLength(0);
  });

  it("skips groups with fewer than 3 error-handling functions", () => {
    const ctx = makeCtx(
      makeHandlers([
        { name: "getA", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getB", body: "  if (!id) return null;\n  return data;" },
      ]),
    );

    // Only 2 functions — below threshold, no finding.
    expect(returnShapeConsistency.detect(ctx)).toHaveLength(0);
  });

  it("upgrades severity to error when 5+ files deviate", () => {
    // 12 throws + 5 nulls → 12/17 ≈ 70.6%, just over the 70% dominance gate.
    const throwers = Array.from({ length: 12 }, (_, i) => ({
      name: `getA${i}`,
      body: "  if (!id) throw new NotFoundError('x');\n  return data;",
    }));
    const deviants = Array.from({ length: 5 }, (_, i) => ({
      name: `getB${i}`,
      body: "  if (!id) return null;\n  return data;",
    }));
    const ctx = makeCtx(makeHandlers([...throwers, ...deviants]));

    const findings = returnShapeConsistency.detect(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].deviatingFiles).toHaveLength(5);
  });

  it("classifies Go tuple-return shape correctly", () => {
    // 4 Go funcs returning (x, err); 1 Go func panicking. Tuple dominates.
    const ctx = makeCtx([
      {
        relativePath: "handlers/a.go",
        language: "go",
        content: `func getA(id string) (User, error) {\n  if id == "" { return nil, err }\n  return user, nil\n}\n`,
      },
      {
        relativePath: "handlers/b.go",
        language: "go",
        content: `func getB(id string) (User, error) {\n  if id == "" { return nil, err }\n  return user, nil\n}\n`,
      },
      {
        relativePath: "handlers/c.go",
        language: "go",
        content: `func getC(id string) (User, error) {\n  if id == "" { return nil, err }\n  return user, nil\n}\n`,
      },
      {
        relativePath: "handlers/d.go",
        language: "go",
        content: `func getD(id string) (User, error) {\n  if id == "" { return nil, err }\n  return user, nil\n}\n`,
      },
      {
        relativePath: "handlers/e.go",
        language: "go",
        content: `func getE(id string) { if id == "" { panic("bad id") } }\n`,
      },
    ]);

    const findings = returnShapeConsistency.detect(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].dominantPattern).toBe("tuple returns (value, error)");
    expect(findings[0].deviatingFiles[0].detectedPattern).toBe("throws on error");
  });

  it("ignores test and fixture files", () => {
    const ctx = makeCtx([
      ...makeHandlers([
        { name: "getA", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getB", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getC", body: "  if (!id) throw new Error('x');\n  return data;" },
      ]),
      {
        relativePath: "src/handlers/getA.test.ts",
        language: "typescript",
        content: `it("does x", () => { if (!x) return null; });\n`,
      },
    ]);

    // Test file ignored by isAnalyzableSource — group has 3 throwers, no deviants.
    expect(returnShapeConsistency.detect(ctx)).toHaveLength(0);
  });

  it("ignores plain-return functions with no error paths", () => {
    const ctx = makeCtx(
      makeHandlers([
        { name: "getA", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getB", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getC", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "formatX", body: "  return x.toUpperCase();" }, // no error path
      ]),
    );

    // formatX has no error-handling shape — excluded from the group.
    // Remaining 3 all throw → unanimous → no finding.
    expect(returnShapeConsistency.detect(ctx)).toHaveLength(0);
  });

  it("does not trip on 'throw' inside comments or strings", () => {
    const ctx = makeCtx(
      makeHandlers([
        {
          name: "getA",
          body: "  // this handler used to throw new Error('bad') but we fixed it\n  if (!id) return null;\n  return data;",
        },
        {
          name: "getB",
          body: "  if (!id) return null;\n  return data;",
        },
        {
          name: "getC",
          body: "  if (!id) return null;\n  return data;",
        },
      ]),
    );

    // Three unanimous null-sentinels — comment-stripping should prevent the
    // first from being classified as 'throws'. No finding expected.
    expect(returnShapeConsistency.detect(ctx)).toHaveLength(0);
  });

  it("requires 70% dominance before flagging", () => {
    // 3 throws, 2 nulls → 3/5 = 60% < 70% threshold → no clear winner → no finding.
    const ctx = makeCtx(
      makeHandlers([
        { name: "getA", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getB", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getC", body: "  if (!id) throw new Error('x');\n  return data;" },
        { name: "getD", body: "  if (!id) return null;\n  return data;" },
        { name: "getE", body: "  if (!id) return null;\n  return data;" },
      ]),
    );

    expect(returnShapeConsistency.detect(ctx)).toHaveLength(0);
  });

  describe("intent-hint seeding", () => {
    it("emits divergence when team declares one shape but code uses another", () => {
      // 4 handlers all throw. CLAUDE.md says "use Result type". Code
      // disagrees unanimously with the declaration — divergence finding
      // should fire even though the directory itself is internally
      // consistent.
      const ctx: DriftContext = {
        ...makeCtx(
          makeHandlers([
            { name: "getA", body: "  if (!id) throw new Error('x');\n  return data;" },
            { name: "getB", body: "  if (!id) throw new Error('x');\n  return data;" },
            { name: "getC", body: "  if (!id) throw new Error('x');\n  return data;" },
            { name: "getD", body: "  if (!id) throw new Error('x');\n  return data;" },
          ]),
        ),
        intentHints: [{
          category: "return_shape_consistency",
          pattern: "result_type",
          label: "Result<T>/Either",
          source: "CLAUDE.md",
          line: 10,
          text: "use Result type for all error returns",
          confidence: 0.95,
        }],
      };

      const findings = returnShapeConsistency.detect(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0].finding).toContain("declared");
      expect(findings[0].finding).toContain("CLAUDE.md");
      expect(findings[0].recommendation).toContain("declaration");
    });

    it("suppresses the finding when declared pattern matches the dominant", () => {
      // 4 handlers all throw. Declaration says "throw on error". Agreement.
      const ctx: DriftContext = {
        ...makeCtx(
          makeHandlers([
            { name: "getA", body: "  if (!id) throw new Error('x');\n  return data;" },
            { name: "getB", body: "  if (!id) throw new Error('x');\n  return data;" },
            { name: "getC", body: "  if (!id) throw new Error('x');\n  return data;" },
            { name: "getD", body: "  if (!id) throw new Error('x');\n  return data;" },
          ]),
        ),
        intentHints: [{
          category: "return_shape_consistency",
          pattern: "throws",
          label: "throw on error",
          source: "CLAUDE.md",
          line: 10,
          text: "throw on error",
          confidence: 0.9,
        }],
      };

      // Agreement + no deviators = no finding.
      expect(returnShapeConsistency.detect(ctx)).toHaveLength(0);
    });

    it("without an intent hint, behavior is unchanged (70% threshold applies)", () => {
      const ctx = makeCtx(
        makeHandlers([
          { name: "getA", body: "  if (!id) throw new Error('x');\n  return data;" },
          { name: "getB", body: "  if (!id) throw new Error('x');\n  return data;" },
          { name: "getC", body: "  if (!id) throw new Error('x');\n  return data;" },
          { name: "getD", body: "  if (!id) return null;\n  return data;" },
          { name: "getE", body: "  if (!id) return null;\n  return data;" },
        ]),
      );

      expect(returnShapeConsistency.detect(ctx)).toHaveLength(0);
    });
  });
});

// Classify a function by its DOMINANT on-error shape, not by a single throw.
// Regression for the bandcamp-player-extension audit: html-fallback.ts returns
// error-object sentinels ~4x with one defensive `throw error` in a catch, yet
// was mislabeled "throws on error" because throws had top priority.
describe("classifyReturnShapeLabel — dominant shape, defensive rethrow discounted", () => {
  it("a function that returns error-objects but defensively rethrows is NOT 'throws on error'", () => {
    const body = `
      async function fetchHtml(url) {
        if (!url) return { html: "", resolvedUrl: "", error: "invalid-url" };
        if (bad)  return { html: "", resolvedUrl: "", error: "malformed-url" };
        try {
          const r = await fetch(url);
          if (!r.ok) return { html: "", resolvedUrl: "", error: "HTTP " + r.status };
          return { html: await r.text(), resolvedUrl: r.url, error: "" };
        } catch (error) {
          if (isAbort(error)) throw error;
          return { html: "", resolvedUrl: "", error: String(error) };
        }
      }`;
    expect(classifyReturnShapeLabel(body)).toBe("error-object returns");
  });

  it("still classifies a genuine thrower as 'throws on error'", () => {
    expect(
      classifyReturnShapeLabel("if (!id) throw new NotFoundError('x');\n return data;"),
    ).toBe("throws on error");
  });

  it("classifies a pure null-sentinel returner as 'null/undefined sentinels'", () => {
    expect(
      classifyReturnShapeLabel("if (!id) return null;\n return data;"),
    ).toBe("null/undefined sentinels");
  });

  it("a function that ONLY rethrows (no other return shape) stays 'throws on error'", () => {
    expect(
      classifyReturnShapeLabel("try { run(); } catch (e) { cleanup(); throw e; }"),
    ).toBe("throws on error");
  });

  it("dominant throws still wins when it returns one sentinel but throws twice", () => {
    expect(
      classifyReturnShapeLabel("if (!a) throw new Error('a');\n if (!b) throw new Error('b');\n if (z) return null;\n return v;"),
    ).toBe("throws on error");
  });

  // A plain state/config object with a `status`/`success` field is NOT an
  // error-return shape. Regression for constants.ts mislabeled "error-object
  // returns" because the result-object regex matched a benign `status:` field.
  it("does not classify a state/config object (status field, no error) as error-object returns", () => {
    const body = "return {\n enabled: false,\n target: 'none',\n status: 0,\n phase: 'phase-1',\n };";
    expect(classifyReturnShapeLabel(body)).toBe(null);
  });

  it("still classifies a true error-result object (has error field) as error-object returns", () => {
    expect(
      classifyReturnShapeLabel("if (bad) return { success: false, error: 'x' };\n return value;"),
    ).toBe("error-object returns");
  });
});
