/**
 * check_file_drift — does a file match the repo's established patterns?
 *
 * Reads the cached baseline's per-category votes and surfaces every category in
 * which the target file is a recorded deviator, with the file's own pattern, the
 * repo's dominant, and a fix hint citing an exemplar. v1 reads the frozen
 * baseline (no per-call re-derivation); a file changed since the scan is
 * reflected by the provider's stale tag. Channel-neutral.
 */
import { z } from "zod";
import { relative, resolve } from "node:path";
import type { DriftCategory } from "../../drift/types.js";
import type { CategoryVote, RepoDriftBaseline } from "../../core/baseline.js";
import { getBaseline } from "../../mcp/baseline-provider.js";
import { noBaselineData, type Status } from "../result.js";

const MAX_DEVIATIONS = 3;

export const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
  filePath: z.string().describe("Path to the file to check (absolute, or relative to rootDir)"),
};

export interface Deviation {
  dimension: DriftCategory;
  deviates: true;
  yourPattern: string;
  dominantPattern: string;
  consistency: string;
  fixHint: string;
}

/** Pure: project a single file's drift out of the cached baseline votes. */
export function fileDriftFromBaseline(
  baseline: RepoDriftBaseline,
  relativePath: string,
): { fits: boolean; deviations: Deviation[] } {
  const deviations: Deviation[] = [];
  const subVotes = baseline.securitySubVotes;
  for (const cat of Object.keys(baseline.perCategoryVote) as DriftCategory[]) {
    // Security is read from the granular sub-votes below, not the collapsed
    // widest-denominator security_posture slot (which hides auth deviators
    // behind whichever sub-convention had the most routes). Fall through to the
    // collapsed slot only for older baselines that predate securitySubVotes.
    if (cat === "security_posture" && subVotes) continue;
    const vote = baseline.perCategoryVote[cat]!;
    const dev = vote.deviators.find((d) => d.path === relativePath);
    if (!dev) continue;
    deviations.push(deviationFrom(cat, vote, dev, "files"));
  }
  if (subVotes) {
    for (const vote of Object.values(subVotes)) {
      if (!vote) continue;
      const dev = vote.deviators.find((d) => d.path === relativePath);
      if (!dev) continue;
      deviations.push(deviationFrom("security_posture", vote, dev, "routes"));
    }
  }
  return { fits: deviations.length === 0, deviations };
}

/** Build one Deviation from a matched vote. `unit` is "routes" for the security
 *  dimension (sub-convention votes count routes) and "files" everywhere else. A
 *  below-peer-floor vote (thin sample) is hedged as advisory but still counts as
 *  a non-fit, so callers never bless a file the granular vote flagged. */
function deviationFrom(
  dimension: DriftCategory,
  vote: CategoryVote,
  dev: { path: string; detectedPattern: string },
  unit: "files" | "routes",
): Deviation {
  const exemplar = vote.dominantFiles[0];
  const pct = Math.round(vote.consistencyScore);
  const advisory = vote.belowPeerFloor ? " (thin sample - advisory)" : "";
  return {
    dimension,
    deviates: true,
    yourPattern: dev.detectedPattern,
    dominantPattern: vote.dominantPattern,
    consistency: `${vote.dominantCount} of ${vote.totalRelevantFiles} ${unit} (${pct}%)${advisory}`,
    fixHint: `Match the repo: use ${vote.dominantPattern}${exemplar ? `; see ${exemplar}` : ""}.${advisory}`,
  };
}

export interface CheckFileDriftOut {
  status: Status;
  message?: string;
  file: string;
  fits: boolean | null;
  deviations: Deviation[];
  more: number;
}

export async function run({
  rootDir,
  filePath,
}: {
  rootDir: string;
  filePath: string;
}): Promise<CheckFileDriftOut> {
  const { baseline, status } = await getBaseline(rootDir);
  // Relativize against the baseline's root so it matches the stored ctx paths,
  // whether the caller passed an absolute path or one relative to rootDir.
  const rel = relative(rootDir, resolve(rootDir, filePath)).replace(/\\/g, "/");
  if (!baseline) {
    return noBaselineData({ file: rel, fits: null, deviations: [], more: 0 }) as unknown as CheckFileDriftOut;
  }
  const { fits, deviations } = fileDriftFromBaseline(baseline, rel);
  return {
    status,
    file: rel,
    fits,
    deviations: deviations.slice(0, MAX_DEVIATIONS),
    more: Math.max(0, deviations.length - MAX_DEVIATIONS),
  };
}
