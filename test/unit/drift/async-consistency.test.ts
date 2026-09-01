import { describe, it, expect } from "vitest";
import { asyncConsistency } from "../../../src/drift/async-consistency.js";
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

describe("async-consistency detector", () => {
  it("runs on a mixed async/then corpus and returns a well-formed array", () => {
    // Note: async-consistency uses directory-scoped voting with strict
    // thresholds. We verify the detector runs cleanly and returns the
    // expected shape without over-constraining its dominance math.
    const files: DriftFile[] = [];
    for (let i = 0; i < 8; i++) {
      files.push(file(
        `src/svc/file${i}.ts`,
        `async function work${i}() { const x = await loadData(); return x; }\nasync function other${i}() { await save(); }\n`,
      ));
    }
    // `asyncCounts` counts matching LINES, not occurrences, so a chain written
    // on ONE line is a single vote and falls under the 2-operation floor —
    // `classifyAsyncStyle` returns null and the file leaves the corpus. The
    // original fixture did exactly that, which is why this test could pass on
    // an empty findings array.
    files.push(file(
      `src/svc/odd.ts`,
      `function work() {\n  return loadData()\n    .then((x) => save(x))\n    .then(() => finalize());\n}\n`,
    ));
    const findings = asyncConsistency.detect(mkCtx(files));
    expect(Array.isArray(findings)).toBe(true);
    // Without this the shape loop below is vacuous: an empty array passes it,
    // so the test stayed green no matter what the detector did.
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.driftCategory).toBe("async_patterns");
    }
  });

  it("no finding when everyone uses the same async style", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file(`src/a${i}.ts`, `async function fn${i}() { await go(); }\n`),
    );
    expect(asyncConsistency.detect(mkCtx(files))).toHaveLength(0);
  });
});

describe("async-consistency: intent-hint vocabulary guard", () => {
  function withHint(files: DriftFile[], pattern: string): DriftContext {
    return {
      ...mkCtx(files),
      intentHints: [{
        category: "async_patterns",
        pattern,
        label: ".then() chains",
        source: "CLAUDE.md",
        line: 7,
        text: "- Prefer .then() chains",
        confidence: 0.9,
      }],
    };
  }

  // `src/a/` is unanimously async/await so the PROJECT-wide entropy gate
  // passes, while `src/h/` splits 2-2 — under the 70% per-directory dominance
  // threshold, so an unseeded vote reports nothing there.
  // One await/then PER LINE: `asyncCounts` counts matching lines, not
  // occurrences, and `classifyAsyncStyle` needs 2 operations to classify at all.
  const AWAIT = `async function go() {
  await a();
  await b();
}
`;
  const THEN = `function go() {
  return a()
    .then(b)
    .then(c);
}
`;
  const files: DriftFile[] = [
    ...Array.from({ length: 6 }, (_, i) => file(`src/a/a${i}.ts`, AWAIT)),
    file("src/h/w1.ts", AWAIT),
    file("src/h/w2.ts", AWAIT),
    file("src/h/t1.ts", THEN),
    file("src/h/t2.ts", THEN),
  ];

  it("emits nothing without a hint (the 2-2 directory is below the dominance gate)", () => {
    expect(asyncConsistency.detect(mkCtx(files))).toHaveLength(0);
  });

  it("an out-of-vocabulary hint does not bypass the dominance gate", () => {
    // A seeded vote SKIPS the 70% threshold. `then_chain` (singular) is the
    // string the intent parser used to emit; AsyncStyle's key is `then_chains`.
    // The mismatch injected a phantom pattern and forced a finding out of a
    // directory no raw vote would report.
    expect(asyncConsistency.detect(withHint(files, "then_chain"))).toHaveLength(0);
    expect(asyncConsistency.detect(withHint(files, "callback"))).toHaveLength(0);
  });

  it("the same declaration written in AsyncStyle's vocabulary still binds", () => {
    const findings = asyncConsistency.detect(withHint(files, "then_chains"));
    expect(findings.length).toBeGreaterThan(0);
  });
});
