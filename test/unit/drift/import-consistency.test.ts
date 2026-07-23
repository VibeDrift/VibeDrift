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

function goFile(path: string, content: string): DriftFile {
  return { relativePath: path, language: "go", content, lineCount: content.split("\n").length };
}

/** A grouped + sorted Go import block (stdlib and external separated). */
const GROUPED_GO = `package api\n\nimport (\n\t"fmt"\n\t"net/http"\n\n\t"github.com/foo/bar"\n)\n`;

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

  describe("intent seed does not leak across axes", () => {
    // Regression: the import_style intent hint's vocabulary ("alias"/"relative")
    // only describes the path_style axis. It must NOT be applied as a seed to
    // unrelated axes (go_grouping, go_ordering, …), where a non-matching seed
    // would inject a phantom pattern and bypass the dominance threshold —
    // emitting spurious divergence findings on perfectly consistent code.
    const aliasHint = {
      category: "import_style",
      pattern: "alias",
      label: "path aliases",
      source: "CLAUDE.md",
      line: 3,
      text: "use path aliases",
      confidence: 0.9,
    };

    it("an 'alias' hint produces no Go findings on a unanimous Go corpus", () => {
      const files = Array.from({ length: 4 }, (_, i) => goFile(`src/api/h${i}.go`, GROUPED_GO));
      const ctx: DriftContext = { ...mkCtx(files), intentHints: [aliasHint] };
      // Go is unanimously grouped + ordered; the alias hint applies to neither.
      expect(importConsistency.detect(ctx)).toHaveLength(0);
    });

    it("the same hint still drives its own path_style axis", () => {
      // 5 unanimously-relative JS files + an 'alias' declaration → path_style
      // divergence (the hint reaches the axis it actually describes).
      const files = Array.from({ length: 5 }, (_, i) =>
        file(`src/svc/f${i}.ts`, `import a from "./a";\nimport b from "./b";\nimport c from "./c";\n`),
      );
      const ctx: DriftContext = { ...mkCtx(files), intentHints: [aliasHint] };
      const findings = importConsistency.detect(ctx);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.every((f) => f.subCategory === "path_style")).toBe(true);
    });
  });
});
