import { describe, it, expect } from "vitest";
import { dependencyDriftAnalyzer } from "../../../src/analyzers/dependency-drift.js";
import type { AnalysisContext } from "../../../src/core/types.js";

const BASE: Omit<AnalysisContext, "files" | "packageJson" | "requirementsTxt" | "totalLines"> = {
  rootDir: "/test",
  goMod: null,
  cargoToml: null,
  envExample: null,
  languageBreakdown: new Map(),
  dominantLanguage: null,
};

function ctxFor(partial: Partial<AnalysisContext>): AnalysisContext {
  return {
    ...BASE,
    files: [],
    packageJson: null,
    requirementsTxt: null,
    totalLines: 0,
    ...partial,
  };
}

describe("dependency-drift analyzer", () => {
  it("has the unregistered analyzerId 'dependency-drift'", () => {
    expect(dependencyDriftAnalyzer.id).toBe("dependency-drift");
  });

  it("flags duplicate-purpose JS deps (lodash + ramda)", async () => {
    const ctx = ctxFor({
      packageJson: { dependencies: { lodash: "^4.17.21", ramda: "^0.29.0" } },
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    const dup = findings.find((f) => f.tags.includes("duplicate-purpose"));
    expect(dup).toBeDefined();
    expect(dup!.analyzerId).toBe("dependency-drift");
    expect(dup!.severity).toBe("warning");
    expect(dup!.message).toContain("lodash");
    expect(dup!.message).toContain("ramda");
    expect(dup!.locations[0]?.file).toBe("package.json");
  });

  it("does NOT flag a single utility dep (only lodash)", async () => {
    const ctx = ctxFor({
      packageJson: { dependencies: { lodash: "^4.17.21" } },
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("duplicate-purpose"))).toBeUndefined();
  });

  it("finds duplicate-purpose across dependencies + devDependencies", async () => {
    // axios in deps, got in devDeps — same HTTP-request purpose group.
    const ctx = ctxFor({
      packageJson: {
        dependencies: { axios: "^1.6.0" },
        devDependencies: { got: "^13.0.0" },
      },
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    const dup = findings.find((f) => f.tags.includes("duplicate-purpose"));
    expect(dup).toBeDefined();
    expect(dup!.message).toContain("axios");
    expect(dup!.message).toContain("got");
  });

  it("flags duplicate-purpose Python deps (requests + httpx)", async () => {
    const ctx = ctxFor({
      requirementsTxt: ["requests", "httpx", "click"],
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    const dup = findings.find((f) => f.tags.includes("duplicate-purpose"));
    expect(dup).toBeDefined();
    expect(dup!.message).toContain("requests");
    expect(dup!.message).toContain("httpx");
    expect(dup!.locations[0]?.file).toBe("requirements.txt");
  });

  it("does NOT flag a single Python HTTP client", async () => {
    const ctx = ctxFor({
      requirementsTxt: ["requests", "click"],
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("duplicate-purpose"))).toBeUndefined();
  });

  it("flags version-pinning inconsistency (>=8 deps, both styles >=25%)", async () => {
    // 5 exact pins, 5 caret/tilde ranges = 50/50 across 10 classified deps.
    const ctx = ctxFor({
      packageJson: {
        dependencies: {
          a: "1.0.0",
          b: "2.3.4",
          c: "0.1.2",
          d: "5.0.0",
          e: "3.2.1",
          f: "^1.0.0",
          g: "^2.0.0",
          h: "~3.0.0",
          i: "^4.1.0",
          j: "~0.5.0",
        },
      },
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    const pin = findings.find((f) => f.tags.includes("version-pinning"));
    expect(pin).toBeDefined();
    expect(pin!.severity).toBe("info");
    expect(pin!.message).toContain("pinning");
  });

  it("does NOT flag a clean single-style (all caret) package.json", async () => {
    const ctx = ctxFor({
      packageJson: {
        dependencies: {
          a: "^1.0.0",
          b: "^2.3.4",
          c: "^0.1.2",
          d: "^5.0.0",
          e: "^3.2.1",
          f: "^1.0.0",
          g: "^2.0.0",
          h: "^3.0.0",
          i: "^4.1.0",
          j: "^0.5.0",
        },
      },
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("version-pinning"))).toBeUndefined();
  });

  it("does NOT flag pinning inconsistency below the 8-dep floor", async () => {
    // 3 exact + 3 caret = 6 classified: both styles present but too few deps.
    const ctx = ctxFor({
      packageJson: {
        dependencies: {
          a: "1.0.0",
          b: "2.0.0",
          c: "3.0.0",
          d: "^1.0.0",
          e: "^2.0.0",
          f: "^3.0.0",
        },
      },
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("version-pinning"))).toBeUndefined();
  });

  it("ignores non-semver specifiers (workspace/*/url) when classifying pins", async () => {
    // 8 caret ranges + a pile of 'other' specifiers → single dominant style, no flag.
    const ctx = ctxFor({
      packageJson: {
        dependencies: {
          a: "^1.0.0",
          b: "^2.0.0",
          c: "^3.0.0",
          d: "^4.0.0",
          e: "^5.0.0",
          f: "^6.0.0",
          g: "^7.0.0",
          h: "^8.0.0",
          w: "workspace:*",
          star: "*",
          latest: "latest",
          url: "https://example.com/pkg.tgz",
          gh: "user/repo",
        },
      },
    });
    const findings = await dependencyDriftAnalyzer.analyze(ctx);
    expect(findings.find((f) => f.tags.includes("version-pinning"))).toBeUndefined();
  });

  it("emits no findings for an empty manifest set", async () => {
    const findings = await dependencyDriftAnalyzer.analyze(ctxFor({}));
    expect(findings).toEqual([]);
  });
});
