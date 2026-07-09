import { describe, it, expect } from "vitest";
import {
  normalizeProjectConfig,
  PROJECT_CONFIG_VERSION,
} from "../../../src/core/project-config.js";

describe("normalizeProjectConfig", () => {
  it("returns null for non-objects", () => {
    expect(normalizeProjectConfig(null)).toBeNull();
    expect(normalizeProjectConfig("nope")).toBeNull();
    expect(normalizeProjectConfig(42)).toBeNull();
    expect(normalizeProjectConfig([1, 2])).toBeNull();
  });

  it("keeps valid format and failOnScore", () => {
    const cfg = normalizeProjectConfig({ version: 1, format: "terminal", failOnScore: 75 });
    expect(cfg).toEqual({ version: 1, format: "terminal", failOnScore: 75 });
  });

  it("drops an unknown format and an out-of-range threshold", () => {
    const cfg = normalizeProjectConfig({ format: "yaml", failOnScore: 150 });
    expect(cfg).toEqual({ version: PROJECT_CONFIG_VERSION });
  });

  it("accepts boundary thresholds 0 and 100", () => {
    expect(normalizeProjectConfig({ failOnScore: 0 })?.failOnScore).toBe(0);
    expect(normalizeProjectConfig({ failOnScore: 100 })?.failOnScore).toBe(100);
  });

  it("defaults version when missing", () => {
    expect(normalizeProjectConfig({})).toEqual({ version: PROJECT_CONFIG_VERSION });
  });

  it("keeps a security.allowlist of globs", () => {
    const cfg = normalizeProjectConfig({
      version: 1,
      security: { allowlist: ["src/public/**", "src/routes/webhooks/*.ts"] },
    });
    expect(cfg).toEqual({
      version: 1,
      security: { allowlist: ["src/public/**", "src/routes/webhooks/*.ts"] },
    });
  });

  it("drops non-string entries from security.allowlist but keeps the valid ones", () => {
    const cfg = normalizeProjectConfig({
      security: { allowlist: ["src/public/**", 123, null, {}, "  ", "src/health/*"] },
    });
    expect(cfg?.security?.allowlist).toEqual(["src/public/**", "src/health/*"]);
  });

  it("omits security when allowlist is absent, not an array, or empty after filtering", () => {
    expect(normalizeProjectConfig({})).toEqual({ version: PROJECT_CONFIG_VERSION });
    expect(normalizeProjectConfig({ security: {} })?.security).toBeUndefined();
    expect(normalizeProjectConfig({ security: { allowlist: "not-an-array" } })?.security).toBeUndefined();
    expect(normalizeProjectConfig({ security: { allowlist: [1, null, "  "] } })?.security).toBeUndefined();
  });
});
