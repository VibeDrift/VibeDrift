import { describe, it, expect } from "vitest";
import { stateManagementConsistency } from "../../../src/drift/state-management-consistency.js";
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

describe("state-management-consistency detector", () => {
  it("emits no finding on non-frontend codebases (no state libs present)", () => {
    const files = Array.from({ length: 6 }, (_, i) =>
      file(`src/svc${i}.ts`, `export function handler${i}(req) { return req.json(); }`),
    );
    expect(stateManagementConsistency.detect(mkCtx(files))).toHaveLength(0);
  });

  it("accepts frontend state library detection without crashing", () => {
    const files = [
      file("src/store/user.ts", `import { create } from "zustand";\nexport const useUserStore = create(() => ({ user: null }));\n`),
      file("src/store/cart.ts", `import { create } from "zustand";\nexport const useCartStore = create(() => ({ items: [] }));\n`),
    ];
    // Unanimous → no drift finding. The test ensures the detector
    // at least runs cleanly on valid input.
    const findings = stateManagementConsistency.detect(mkCtx(files));
    expect(Array.isArray(findings)).toBe(true);
  });
});
