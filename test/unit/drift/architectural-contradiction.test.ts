import { describe, it, expect } from "vitest";
import { architecturalContradiction } from "../../../src/drift/architectural-contradiction.js";
import type { DriftContext, DriftFile } from "../../../src/drift/types.js";

function mkCtx(files: DriftFile[]): DriftContext {
  return {
    files,
    totalLines: files.reduce((s, f) => s + f.lineCount, 0),
    dominantLanguage: "typescript",
  };
}

function file(path: string, content: string): DriftFile {
  return { path, language: "typescript", content, lineCount: content.split("\n").length };
}

describe("architectural-contradiction detector", () => {
  it("flags data-access drift when most files use repository pattern and one uses raw SQL", () => {
    const files: DriftFile[] = [];
    for (let i = 0; i < 5; i++) {
      files.push(file(
        `src/services/svc${i}.ts`,
        `import { UserRepository } from "../repos/user";\nconst repo = new UserRepository();\nexport function getUser(id) { return repo.findById(id); }\n`,
      ));
    }
    files.push(file(
      "src/services/odd.ts",
      `import db from "../db";\nexport function getOrder(id) { return db.query("SELECT * FROM orders WHERE id = " + id); }\n`,
    ));
    const findings = architecturalContradiction.detect(mkCtx(files));
    // At least one finding about architectural consistency.
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.driftCategory === "architectural_consistency")).toBe(true);
  });

  it("no finding when all files agree on one architectural pattern", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file(
        `src/services/svc${i}.ts`,
        `import { Repo } from "../repos/x";\nconst repo = new Repo();\nexport function get${i}(id) { return repo.findById(id); }\n`,
      ),
    );
    expect(architecturalContradiction.detect(mkCtx(files))).toHaveLength(0);
  });
});
