import { describe, it, expect } from "vitest";

import { buildScanBeaconPayload } from "../../../src/telemetry/beacon.js";

describe("buildScanBeaconPayload", () => {
  const baseResult = {
    context: {
      dominantLanguage: "typescript",
      files: [{}, {}, {}],
      totalLines: 4200,
      hasGitMetadata: true,
      intentHints: [{ confidence: 0.7 }],
    },
    scanTimeMs: 1234,
    findings: [{}, {}],
    compositeScore: 81,
  };

  it("carries lines-of-code from context.totalLines as `loc`", () => {
    const p = buildScanBeaconPayload(baseResult as any, { cliVersion: "9.9.9", isDeep: false });
    expect(p.loc).toBe(4200);
  });

  it("preserves the existing beacon fields", () => {
    const p = buildScanBeaconPayload(baseResult as any, { cliVersion: "9.9.9", isDeep: true });
    expect(p.file_count).toBe(3);
    expect(p.language).toBe("typescript");
    expect(p.is_deep).toBe(true);
    expect(p.has_git).toBe(true);
    expect(p.has_intent_hints).toBe(true);
    expect(p.finding_count).toBe(2);
    expect(p.score).toBe(81);
    expect(p.cli_version).toBe("9.9.9");
  });

  it("reports loc 0 for an empty scan", () => {
    const p = buildScanBeaconPayload(
      { context: { dominantLanguage: null, files: [], totalLines: 0 }, scanTimeMs: 5, findings: [], compositeScore: 100 } as any,
      { cliVersion: "9.9.9", isDeep: false },
    );
    expect(p.loc).toBe(0);
  });
});
