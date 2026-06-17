import { describe, it, expect } from "vitest";
import { sanitizeResultForUpload } from "../../../src/ml-client/sanitize-result.js";
import type { ScanResult } from "../../../src/core/types.js";

/**
 * The cloud cannot backfill stored scores by version unless the CLI actually
 * uploads the scoring version. Before this fix the version was computed but
 * stripped before reaching Supabase (root cause of the dashboard's fragile
 * `score.max === 80 ?` sniff). sanitizeResultForUpload must carry it through.
 */
function mkResult(overrides: Partial<ScanResult>): ScanResult {
  return {
    context: {
      rootDir: "/tmp/proj",
      dominantLanguage: "typescript",
      languageBreakdown: new Map(),
      totalLines: 100,
      files: [],
    },
    compositeScore: 70,
    maxCompositeScore: 100,
    scores: {},
    hygieneScore: 90,
    maxHygieneScore: 100,
    hygieneScores: {},
    findings: [],
    driftFindings: [],
    driftScores: {},
    perFileScores: new Map(),
    teaseMessages: [],
    scanTimeMs: 5,
    ...overrides,
  } as unknown as ScanResult;
}

describe("sanitizeResultForUpload — scoringVersion passthrough", () => {
  it("includes scoringVersion in the uploaded payload", () => {
    const out = sanitizeResultForUpload(mkResult({ scoringVersion: "v3" }));
    expect(out.scoringVersion).toBe("v3");
  });

  it("sends null (not undefined) when no scoringVersion is set", () => {
    const out = sanitizeResultForUpload(mkResult({ scoringVersion: undefined }));
    expect(out.scoringVersion).toBeNull();
  });
});
