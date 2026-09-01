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
  return { relativePath: path, language: "typescript", content, lineCount: content.split("\n").length };
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

describe("state-management-consistency: intent-hint vocabulary guard", () => {
  function withHint(files: DriftFile[], pattern: string): DriftContext {
    return {
      ...mkCtx(files),
      intentHints: [{
        category: "state_management_consistency",
        pattern,
        label: "Redux",
        source: "CLAUDE.md",
        line: 9,
        text: "- Use Redux",
        confidence: 0.9,
      }],
    };
  }

  // `src/ui/` splits 2-2, below the 70% per-directory dominance gate, so an
  // unseeded vote reports nothing there. Only a seed can make it emit.
  const files: DriftFile[] = [
    file("src/ui/a.tsx", `import { useSelector } from "react-redux";\nexport const A = () => useSelector((s) => s.a);\n`),
    file("src/ui/b.tsx", `import { useDispatch } from "react-redux";\nexport const B = () => useDispatch();\n`),
    file("src/ui/c.tsx", `import { useState } from "react";\nexport const C = () => useState(0);\n`),
    file("src/ui/d.tsx", `import { useState } from "react";\nexport const D = () => useState(1);\n`),
  ];

  it("emits nothing without a hint (the 2-2 directory is below the dominance gate)", () => {
    expect(stateManagementConsistency.detect(mkCtx(files))).toHaveLength(0);
  });

  it("an out-of-vocabulary hint does not bypass the dominance gate", () => {
    // A seeded vote SKIPS the 70% threshold. `context` and `local_state` are
    // strings the intent parser used to emit; the detector's strategy keys are
    // `react_context` and `react_hooks_local`. Neither `jotai` nor `recoil` is a
    // strategy at all. Any of them injected a phantom pattern that forced a
    // finding out of a directory no raw vote would report.
    for (const bogus of ["context", "local_state", "jotai", "recoil"]) {
      expect(stateManagementConsistency.detect(withHint(files, bogus))).toHaveLength(0);
    }
  });

  it("a declaration written in the detector's vocabulary still binds", () => {
    const findings = stateManagementConsistency.detect(withHint(files, "redux"));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].dominantPattern).toBe("Redux");
  });
});
