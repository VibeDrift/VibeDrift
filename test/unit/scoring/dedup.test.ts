import { describe, it, expect } from "vitest";
import { deduplicateFindingsAcrossLayers } from "../../../src/scoring/dedup.js";
import type { Finding } from "../../../src/core/types.js";

function dup(
  analyzerId: string,
  sites: Array<[string, number]>,
  opts: { dupGroupSize?: number; message?: string } = {},
): Finding {
  return {
    analyzerId,
    severity: "warning",
    confidence: 0.9,
    message: opts.message ?? `duplicate ${sites.map(([f, l]) => `${f}:${l}`).join(" / ")}`,
    locations: sites.map(([file, line]) => ({ file, line })),
    tags: ["duplicate"],
    ...(opts.dupGroupSize ? { dupGroupSize: opts.dupGroupSize } : {}),
  };
}

describe("deduplicateFindingsAcrossLayers", () => {
  it("keeps N distinct duplicate groups that span the SAME file pair", () => {
    // Two large modules can share several unrelated clones. Keying the dedup on
    // the file SET alone collapsed all of them into one survivor, and the
    // dropped findings took their `dupGroupSize` with them — the scoring
    // engine's duplicated-function fraction lost most of its numerator, so a
    // heavily duplicated pair of files scored as if it held a single clone.
    const groups: Finding[] = [
      dup("codedna-fingerprint", [["src/a.ts", 10], ["src/b.ts", 200]], { dupGroupSize: 2 }),
      dup("codedna-fingerprint", [["src/a.ts", 40], ["src/b.ts", 230]], { dupGroupSize: 2 }),
      dup("codedna-fingerprint", [["src/a.ts", 70], ["src/b.ts", 260]], { dupGroupSize: 3 }),
      dup("codedna-fingerprint", [["src/a.ts", 100], ["src/b.ts", 290]], { dupGroupSize: 2 }),
      dup("codedna-fingerprint", [["src/a.ts", 130], ["src/b.ts", 320]], { dupGroupSize: 5 }),
    ];

    const out = deduplicateFindingsAcrossLayers(groups);
    expect(out).toHaveLength(5);
    // And the duplication MASS survives, which is what the composite reads.
    const mass = out.reduce((n, f) => n + ((f.dupGroupSize ?? 1) - 1), 0);
    expect(mass).toBe(1 + 1 + 2 + 1 + 4);
  });

  it("still merges the SAME functions reported by different layers, keeping the highest-priority one", () => {
    const sites: Array<[string, number]> = [["src/a.ts", 10], ["src/b.ts", 200]];
    const out = deduplicateFindingsAcrossLayers([
      dup("duplicates", sites),
      dup("codedna-opseq", sites),
      dup("codedna-fingerprint", sites),
      dup("ml-duplicate", sites),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].analyzerId).toBe("ml-duplicate");
    expect(out[0].message).toContain("confirmed by");
  });

  it("does not mutate the caller's findings when it annotates the winner", () => {
    // Callers keep the original objects (findings library, session ledger, diff)
    // and this function is run more than once over the same array.
    const sites: Array<[string, number]> = [["src/a.ts", 10], ["src/b.ts", 200]];
    const winner = dup("ml-duplicate", sites, { message: "identical bodies" });
    const other = dup("duplicates", sites);
    const input = [winner, other];

    const first = deduplicateFindingsAcrossLayers(input);
    expect(winner.message).toBe("identical bodies");
    expect(first[0].message).not.toBe(winner.message);

    // Re-running must produce the same annotation, not a doubled one.
    const second = deduplicateFindingsAcrossLayers(input);
    expect(second[0].message).toBe(first[0].message);
  });

  it("passes non-duplicate findings through and never returns the input array itself", () => {
    const other: Finding = {
      analyzerId: "naming",
      severity: "warning",
      confidence: 1,
      message: "naming",
      locations: [{ file: "src/c.ts", line: 1 }],
      tags: [],
    };
    const input = [other];
    const out = deduplicateFindingsAcrossLayers(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });
});
