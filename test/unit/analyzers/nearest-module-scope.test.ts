import { describe, it, expect } from "vitest";
import { nearestModuleScope, type ModuleScope } from "../../../src/analyzers/dependencies.js";

// A minimal ModuleScope for a given dir — the lookup only reads `.dir`, but we
// build the real shape so the test exercises the exported type.
function scope(dir: string): ModuleScope {
  return { dir, module: dir || "root", goModPath: dir ? `${dir}/go.mod` : "go.mod", directPaths: [], allPaths: [], imports: new Set(), fileCount: 0 };
}

function index(...dirs: string[]): Map<string, ModuleScope> {
  return new Map(dirs.map((d) => [d, scope(d)]));
}

describe("nearestModuleScope", () => {
  it("resolves a root-level file to the root module", () => {
    const s = index("");
    expect(nearestModuleScope("main.go", s, new Set())?.dir).toBe("");
  });

  it("resolves a file under a nested module to that module", () => {
    const s = index("", "tools");
    expect(nearestModuleScope("tools/gen.go", s, new Set())?.dir).toBe("tools");
  });

  it("picks the DEEPEST enclosing module when modules nest", () => {
    const s = index("", "a", "a/b");
    expect(nearestModuleScope("a/b/deep.go", s, new Set())?.dir).toBe("a/b");
    expect(nearestModuleScope("a/mid.go", s, new Set())?.dir).toBe("a");
    expect(nearestModuleScope("top.go", s, new Set())?.dir).toBe("");
  });

  it("falls back to the nearest ANCESTOR module, not a deeper sibling", () => {
    const s = index("", "a", "a/b");
    // c has no module of its own, so a/c/x.go belongs to module "a".
    expect(nearestModuleScope("a/c/x.go", s, new Set())?.dir).toBe("a");
  });

  it("does not match a sibling dir that is only a string prefix", () => {
    const s = index("", "a");
    // "ab" is not under "a" — must resolve to root, not "a".
    expect(nearestModuleScope("ab/x.go", s, new Set())?.dir).toBe("");
  });

  it("returns null for a file directly under an opaque (unparseable) module", () => {
    const s = index("");
    expect(nearestModuleScope("legacy/old.go", s, new Set(["legacy"]))).toBeNull();
  });

  it("prefers a deeper PARSED module over a shallower opaque one", () => {
    const s = index("", "a/b");
    // a is opaque, a/b parses. a/b/ok.go belongs to a/b; a/loose.go is skipped.
    expect(nearestModuleScope("a/b/ok.go", s, new Set(["a"]))?.dir).toBe("a/b");
    expect(nearestModuleScope("a/loose.go", s, new Set(["a"]))).toBeNull();
  });

  it("prefers a deeper OPAQUE module over a shallower parsed one", () => {
    const s = index("", "a");
    // a parses, a/b is opaque. a/b/x.go is skipped; a/y.go belongs to a.
    expect(nearestModuleScope("a/b/x.go", s, new Set(["a/b"]))).toBeNull();
    expect(nearestModuleScope("a/y.go", s, new Set(["a/b"]))?.dir).toBe("a");
  });
});
