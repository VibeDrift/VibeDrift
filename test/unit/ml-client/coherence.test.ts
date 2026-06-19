import { describe, it, expect } from "vitest";
import { buildCoherencePayload } from "../../../src/ml-client/coherence.js";
import type { ScanResult } from "../../../src/core/types.js";

function result(): ScanResult {
  return {
    context: {
      rootDir: "/home/me/acme-app",
      dominantLanguage: "typescript",
      files: [{}, {}, {}],
      totalLines: 4200,
    },
    compositeScore: 62,
    maxCompositeScore: 100,
    driftFindings: [
      {
        driftCategory: "async_patterns",
        severity: "warning",
        finding: "uses .then() chains while peers use async/await",
        dominantPattern: "async/await",
        dominantCount: 40,
        totalRelevantFiles: 45,
        consistencyScore: 89,
        deviatingFiles: [{ path: "src/legacy/fetch.ts", detectedPattern: ".then()", evidence: [] }],
      },
      {
        // second finding in the SAME category — must not produce a 2nd dominant row
        driftCategory: "async_patterns",
        severity: "info",
        finding: "another .then() chain",
        dominantPattern: "async/await",
        dominantCount: 40,
        totalRelevantFiles: 45,
        consistencyScore: 89,
        deviatingFiles: [{ path: "src/legacy/util.ts", detectedPattern: ".then()", evidence: [] }],
      },
    ],
    findings: [
      { analyzerId: "ml-duplicate", confidence: 0.93, message: "ML-detected semantic duplicate: a.ts::foo and b.ts::bar (93% similar)", tags: ["ml"], locations: [{ file: "a.ts" }] },
      { analyzerId: "ml-intent", confidence: 0.9, message: "Function name mismatch: validatePayment() — name doesn't match behavior (24% name-body alignment)", tags: ["ml"], locations: [{ file: "pay.ts" }] },
      { analyzerId: "naming", confidence: 1, message: "not an ml finding", locations: [] },
    ],
  } as any;
}

describe("buildCoherencePayload", () => {
  it("maps project meta, score, and grade", () => {
    const p = buildCoherencePayload(result());
    expect(p.project).toBe("acme-app");
    expect(p.language).toBe("typescript");
    expect(p.file_count).toBe(3);
    expect(p.total_lines).toBe(4200);
    expect(p.score).toBe(62);
    expect(p.grade).toBe("C"); // 62% → C
  });

  it("emits one dominant-pattern row per category (deduped)", () => {
    const p = buildCoherencePayload(result());
    expect(p.dominant_patterns).toHaveLength(1);
    expect(p.dominant_patterns[0]).toMatchObject({
      category: "async_patterns",
      dominant_pattern: "async/await",
      dominant_count: 40,
      total_files: 45,
      consistency: 89,
    });
  });

  it("includes every drift finding with its deviating file", () => {
    const p = buildCoherencePayload(result());
    expect(p.drift_findings).toHaveLength(2);
    expect(p.drift_findings[0].file).toBe("src/legacy/fetch.ts");
  });

  it("extracts ml duplicates and intent lies, ignoring non-ml findings", () => {
    const p = buildCoherencePayload(result());
    expect(p.duplicates).toHaveLength(1);
    expect(p.duplicates[0].confidence).toBe(0.93);
    expect(p.intent_lies).toHaveLength(1);
    expect(p.intent_lies[0].name).toBe("validatePayment"); // parsed from the message
  });
});
