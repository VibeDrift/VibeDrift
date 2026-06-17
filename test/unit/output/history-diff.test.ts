import { describe, it, expect } from "vitest";
import { diffScans, relativeTime } from "../../../src/output/history-diff.js";
import { computeFindingDigest, computeDriftFindingDigest, type SavedScan } from "../../../src/core/history.js";
import type { Finding, DriftFindingReport, CategoryScores } from "../../../src/core/types.js";

function f(partial: Partial<Finding>): Finding {
  return {
    analyzerId: "naming",
    severity: "warning",
    confidence: 0.9,
    message: "x",
    locations: [{ file: "src/a.ts", line: 10 }],
    tags: [],
    ...partial,
  };
}

function drift(partial: Partial<DriftFindingReport>): DriftFindingReport {
  return {
    detector: "convention-oscillation",
    driftCategory: "naming_conventions",
    severity: "warning",
    confidence: 0.8,
    finding: "default",
    dominantPattern: "camelCase",
    dominantCount: 8,
    totalRelevantFiles: 10,
    consistencyScore: 80,
    deviatingFiles: [],
    recommendation: "",
    ...partial,
  };
}

const EMPTY_SCORES: CategoryScores = {
  architecturalConsistency: { score: 20, maxScore: 20, locked: false, findingCount: 0, applicable: true },
  redundancy: { score: 20, maxScore: 20, locked: false, findingCount: 0, applicable: true },
  dependencyHealth: { score: 0, maxScore: 20, locked: false, findingCount: 0, applicable: false },
  securityPosture: { score: 20, maxScore: 20, locked: false, findingCount: 0, applicable: true },
  intentClarity: { score: 20, maxScore: 20, locked: false, findingCount: 0, applicable: true },
};

function saved(partial: Partial<SavedScan>): SavedScan {
  return {
    timestamp: "2026-04-19T10:00:00Z",
    rootDir: "/x",
    schemaVersion: 3,
    scores: EMPTY_SCORES,
    compositeScore: 80,
    hygieneScore: 100,
    findingDigests: [],
    driftFindingDigests: [],
    ...partial,
  };
}

describe("diffScans", () => {
  it("marks every current finding as new when previous is null", () => {
    const f1 = computeFindingDigest(f({ message: "issue a" }));
    const d = diffScans(null, {
      timestamp: "2026-04-19T10:00:00Z",
      compositeScore: 80,
      hygieneScore: 100,
      findingDigests: [f1],
      driftFindingDigests: [],
    });
    expect(d.findingsDiff.new).toHaveLength(1);
    expect(d.findingsDiff.resolved).toHaveLength(0);
    expect(d.findingsDiff.persistent).toHaveLength(0);
    expect(d.scoreDelta).toBe(0);
    expect(d.incomparable).toBe(false);
  });

  it("classifies resolved / new / persistent correctly", () => {
    const A = computeFindingDigest(f({ message: "A", locations: [{ file: "a.ts", line: 10 }] }));
    const B = computeFindingDigest(f({ message: "B", locations: [{ file: "b.ts", line: 20 }] }));
    const C = computeFindingDigest(f({ message: "C", locations: [{ file: "c.ts", line: 30 }] }));

    const prev = saved({ findingDigests: [A, B], compositeScore: 60 });
    const d = diffScans(prev, {
      timestamp: "2026-04-19T12:00:00Z",
      compositeScore: 70,
      hygieneScore: 100,
      findingDigests: [B, C], // B persists, A resolved, C new
      driftFindingDigests: [],
    });

    expect(d.findingsDiff.resolved.map((x) => x.message)).toEqual(["A"]);
    expect(d.findingsDiff.new.map((x) => x.message)).toEqual(["C"]);
    expect(d.findingsDiff.persistent.map((x) => x.message)).toEqual(["B"]);
    expect(d.scoreDelta).toBe(10);
  });

  it("marks diff as incomparable when previous schema < 3", () => {
    const prev = saved({ schemaVersion: 2, findingDigests: undefined });
    const f1 = computeFindingDigest(f({ message: "new" }));
    const d = diffScans(prev, {
      timestamp: "2026-04-19T12:00:00Z",
      compositeScore: 80,
      hygieneScore: 100,
      findingDigests: [f1],
      driftFindingDigests: [],
    });
    expect(d.incomparable).toBe(true);
    // Everything becomes new because we can't trust the old state.
    expect(d.findingsDiff.new).toHaveLength(1);
    expect(d.findingsDiff.resolved).toHaveLength(0);
    // scoreDelta is zero when incomparable (no honest comparison)
    expect(d.scoreDelta).toBe(0);
  });

  it("classifies drift findings independently from generic findings", () => {
    const prevDrift = computeDriftFindingDigest(drift({ finding: "old drift" }));
    const newDrift = computeDriftFindingDigest(drift({ finding: "new drift" }));

    const prev = saved({ driftFindingDigests: [prevDrift] });
    const d = diffScans(prev, {
      timestamp: "2026-04-19T12:00:00Z",
      compositeScore: 80,
      hygieneScore: 100,
      findingDigests: [],
      driftFindingDigests: [newDrift],
    });

    expect(d.driftFindingsDiff.resolved).toHaveLength(1);
    expect(d.driftFindingsDiff.new).toHaveLength(1);
    expect(d.findingsDiff.resolved).toHaveLength(0);
    expect(d.findingsDiff.new).toHaveLength(0);
  });

  it("line slop: a finding that moved within 3 lines is persistent, not new+resolved", () => {
    // Two findings identical except line: 10 vs 11. Both fall into bucket 3
    // (floor(10/3) = 3, floor(11/3) = 3) → same digest → persistent.
    const a = computeFindingDigest(f({ message: "same", locations: [{ file: "a.ts", line: 10 }] }));
    const b = computeFindingDigest(f({ message: "same", locations: [{ file: "a.ts", line: 11 }] }));
    const prev = saved({ findingDigests: [a] });
    const d = diffScans(prev, {
      timestamp: "2026-04-19T12:00:00Z",
      compositeScore: 80,
      hygieneScore: 100,
      findingDigests: [b],
      driftFindingDigests: [],
    });
    expect(d.findingsDiff.persistent).toHaveLength(1);
    expect(d.findingsDiff.resolved).toHaveLength(0);
    expect(d.findingsDiff.new).toHaveLength(0);
  });

  it("message normalization: concrete numbers don't make a finding look new", () => {
    // "14 TODOs" and "15 TODOs" should share a key (N substitution).
    const a = computeFindingDigest(f({ analyzerId: "todo-density", message: "14 TODOs", locations: [{ file: "src/", line: 1 }] }));
    const b = computeFindingDigest(f({ analyzerId: "todo-density", message: "15 TODOs", locations: [{ file: "src/", line: 1 }] }));
    expect(a.key).toBe(b.key);
  });
});

describe("relativeTime", () => {
  it("renders unknown for null", () => {
    expect(relativeTime(null)).toBe("unknown");
  });

  it("renders seconds / minutes / hours in the right buckets", () => {
    const now = new Date();
    const s30 = new Date(now.getTime() - 30_000).toISOString();
    const m5 = new Date(now.getTime() - 5 * 60_000).toISOString();
    const h3 = new Date(now.getTime() - 3 * 3600_000).toISOString();
    expect(relativeTime(s30)).toMatch(/s ago$/);
    expect(relativeTime(m5)).toMatch(/m ago$/);
    expect(relativeTime(h3)).toMatch(/h ago$/);
  });
});
