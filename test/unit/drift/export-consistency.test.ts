import { describe, it, expect } from "vitest";
import { exportConsistency } from "../../../src/drift/export-consistency.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string): DriftFile {
  return { relativePath: path, language: "typescript", content, lineCount: content.split("\n").length };
}

describe("export-consistency detector", () => {
  it("flags a default-export file when named exports dominate", () => {
    const files: DriftFile[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(file(`src/a${i}.ts`, `export const foo${i} = 1;\nexport function bar${i}() {}\n`));
    }
    files.push(file(`src/odd.ts`, `function thing() {}\nexport default thing;\n`));
    const findings = exportConsistency.detect(mkCtx(files));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.driftCategory === "export_style")).toBe(true);
  });

  it("no finding when the project unanimously uses default exports", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file(`src/a${i}.ts`, `function thing${i}() {}\nexport default thing${i};\n`),
    );
    expect(exportConsistency.detect(mkCtx(files))).toHaveLength(0);
  });

  it("emits one plurality-based 'no convention' finding when there is no export convention", () => {
    // 50/50 split of default vs named across many files → entropy gate returns
    // no_convention. For a self-consistency score, having NO dominant pattern is
    // the floor of consistency, so the detector emits ONE category-level finding
    // whose deviation is 1 - plurality share (smooth + granular: 50/50 → 0.5,
    // a 4-way even split → 0.75), naming no specific deviating files.
    const files: DriftFile[] = [];
    for (let i = 0; i < 6; i++) {
      files.push(file(`src/named${i}.ts`, `export const v${i} = 1;\nexport function f${i}() {}\n`));
    }
    for (let i = 0; i < 6; i++) {
      files.push(file(`src/def${i}.ts`, `function thing${i}() {}\nexport default thing${i};\n`));
    }
    const findings = exportConsistency.detect(mkCtx(files));
    expect(findings).toHaveLength(1);
    expect(findings[0].dominantPattern).toBe("no dominant convention");
    expect(findings[0].deviatingFiles).toHaveLength(0);
    // perfect 50/50 split → plurality share 0.5 → consistencyScore 50 → deviation 0.5
    // (smooth/granular; a more-fragmented split would score lower, i.e. more drift)
    expect(findings[0].consistencyScore).toBe(50);
    expect(findings[0].severity).toBe("warning");
  });

  it("emits no 'no convention' finding when the sample is too small to distinguish chaos from sparse data", () => {
    // 1-vs-1 split: high entropy but below the minimum sample — insufficient
    // data, not chaos, so no finding.
    const files: DriftFile[] = [
      file("src/a.ts", `export const a = 1;\n`),
      file("src/b.ts", `function t() {}\nexport default t;\n`),
      file("src/c.ts", `export const c = 1;\n`),
    ];
    expect(exportConsistency.detect(mkCtx(files))).toHaveLength(0);
  });
});

describe("export-consistency: async-only export files", () => {
  it("counts a file whose only exports are async functions", () => {
    // `export async function` matched neither branch of the classifier — not
    // `export default`, and `async` is not one of the declaration keywords — so
    // such a file was read as having NO exports and left the vote entirely.
    // The four async-only files below ARE the named-export majority here;
    // without them only `d.ts` profiles at all and the detector returns [] on
    // its `fileProfiles.length < 3` guard.
    const files: DriftFile[] = [
      file("src/h/a.ts", `export async function loadA() { return 1; }
`),
      file("src/h/b.ts", `export async function loadB() { return 2; }
`),
      file("src/h/c.ts", `export async function loadC() { return 3; }
`),
      file("src/h/e.ts", `export async function loadE() { return 5; }
`),
      file("src/h/d.ts", `async function loadD() { return 4; }
export default loadD;
`),
    ];
    const findings = exportConsistency.detect(mkCtx(files));
    const v = findings.find((f) => f.driftCategory === "export_style");
    expect(v).toBeDefined();
    expect(v!.dominantPattern).toBe("named exports only");
    expect(v!.dominantCount).toBe(4);
    expect(v!.totalRelevantFiles).toBe(5);
    expect(v!.deviatingFiles.map((d) => d.path)).toEqual(["src/h/d.ts"]);
  });
});

describe("export-consistency: intent-hint vocabulary guard", () => {
  function withHint(files: DriftFile[], pattern: string): DriftContext {
    return {
      ...mkCtx(files),
      intentHints: [{
        category: "export_style",
        pattern,
        label: "named exports",
        source: "CLAUDE.md",
        line: 3,
        text: "- Prefer named exports",
        confidence: 0.9,
      }],
    };
  }

  // `src/a/` is unanimously named so the PROJECT-wide entropy gate passes
  // (8 named vs 2 default), while `src/h/` splits 2-2 — under the 70%
  // per-directory dominance threshold, so an unseeded vote reports nothing
  // there. A seed is the only thing that can make `src/h/` emit.
  const files: DriftFile[] = [
    ...Array.from({ length: 6 }, (_, i) => file(`src/a/a${i}.ts`, `export const a${i} = ${i};
`)),
    file("src/h/n1.ts", `export const n1 = 1;
`),
    file("src/h/n2.ts", `export const n2 = 2;
`),
    file("src/h/d1.ts", `function d1() {}
export default d1;
`),
    file("src/h/d2.ts", `function d2() {}
export default d2;
`),
  ];

  it("emits nothing without a hint (the 2-2 directory is below the dominance gate)", () => {
    expect(exportConsistency.detect(mkCtx(files))).toHaveLength(0);
  });

  it("an out-of-vocabulary hint does not bypass the dominance gate", () => {
    // A seeded vote SKIPS the 70% dominance threshold. `named` is the string
    // the intent parser used to emit; the detector's enum key is `named_only`.
    // The mismatch injected a phantom pattern into the vote and forced a
    // finding out of a directory no raw vote would report.
    expect(exportConsistency.detect(withHint(files, "named"))).toHaveLength(0);
  });

  it("the same declaration written in the detector's vocabulary still binds", () => {
    const findings = exportConsistency.detect(withHint(files, "named_only"));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.dominantPattern === "named exports only")).toBe(true);
  });
});
