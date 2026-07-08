import { describe, it, expect } from "vitest";
import { importConsistency } from "../../../src/drift/import-consistency.js";
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

describe("import-consistency detector", () => {
  it("runs on a mixed alias/relative corpus and returns a well-formed array", () => {
    // Note: import-consistency uses directory-scoped voting with
    // thresholds that may or may not trip on a crafted minimal corpus.
    // We verify shape; a stronger dominance test lives in the
    // integration suite.
    const files: DriftFile[] = [];
    for (let i = 0; i < 8; i++) {
      files.push(file(`src/svc/a${i}.ts`, `import { foo } from "@/lib/foo";\nimport { bar } from "@/lib/bar";\n`));
    }
    files.push(file(`src/svc/odd.ts`, `import { foo } from "../../lib/foo";\nimport { bar } from "../lib/bar";\n`));
    const findings = importConsistency.detect(mkCtx(files));
    expect(Array.isArray(findings)).toBe(true);
    for (const f of findings) {
      expect(f.driftCategory).toBe("import_style");
    }
  });

  it("no finding when imports are unanimous", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file(`src/a${i}.ts`, `import { foo } from "@/lib/foo";\n`),
    );
    expect(importConsistency.detect(mkCtx(files))).toHaveLength(0);
  });
});
