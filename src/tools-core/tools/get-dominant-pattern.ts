/**
 * get_dominant_pattern — what convention THIS repo actually follows for a given
 * dimension, read off the cached baseline's per-category vote.
 *
 * The caller-facing `dimension` names map to the real (13-value) DriftCategory
 * union — no invented categories. A category with no fired vote means no file
 * deviated, so it's reported as fully consistent. Channel-neutral.
 */
import { z } from "zod";
import type { DriftCategory } from "../../drift/types.js";
import { SECURITY_SUBCATEGORIES } from "../../drift/types.js";
import type { RepoDriftBaseline } from "../../core/baseline.js";
import { getBaseline } from "../../mcp/baseline-provider.js";
import { noBaselineData, type Status } from "../result.js";

const DIM = {
  error_handling: "return_shape_consistency",
  imports: "import_style",
  exports: "export_style",
  async: "async_patterns",
  naming: "naming_conventions",
  data_access: "architectural_consistency",
  logging: "logging_consistency",
  auth: "security_posture",
} as const satisfies Record<string, DriftCategory>;

export type DominantDimension = keyof typeof DIM;
export const DIMENSIONS = Object.keys(DIM) as DominantDimension[];

// Dimensions whose vote lives in securitySubVotes (keyed by sub-category label)
// rather than the collapsed perCategoryVote slot.
const SECURITY_SUB_DIM: Partial<Record<DominantDimension, string>> = {
  auth: SECURITY_SUBCATEGORIES.auth,
};

export const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
  dimension: z.enum(DIMENSIONS as [DominantDimension, ...DominantDimension[]]),
};

export interface DominantPatternProjection {
  dimension: DominantDimension;
  dominantPattern: string;
  consistency: string;
  examples: string[];
}

/** Pure projection of a baseline vote into the caller-facing shape. */
export function dominantPatternFor(
  baseline: RepoDriftBaseline,
  dimension: DominantDimension,
): DominantPatternProjection {
  const subKey = SECURITY_SUB_DIM[dimension];
  const vote = subKey ? baseline.securitySubVotes?.[subKey] : baseline.perCategoryVote[DIM[dimension]];
  if (!vote) {
    return {
      dimension,
      dominantPattern: "consistent",
      consistency: baseline.ctxFiles.length ? "100% — no deviations detected" : "no files analyzed",
      examples: [],
    };
  }
  const pct = Math.round(vote.consistencyScore);
  const unit = SECURITY_SUB_DIM[dimension] ? "routes" : "files";
  const base = `${vote.dominantCount} of ${vote.totalRelevantFiles} ${unit} (${pct}%)`;
  const consistency = vote.belowPeerFloor
    ? `${base} - thin sample (below the reliable-sample floor), treat as advisory`
    : base;
  return {
    dimension,
    dominantPattern: vote.dominantPattern,
    consistency,
    examples: vote.dominantFiles.slice(0, 3),
  };
}

export interface DominantPatternOut extends DominantPatternProjection {
  status: Status;
  message?: string;
}

export async function run({
  rootDir,
  dimension,
}: {
  rootDir: string;
  dimension: DominantDimension;
}): Promise<DominantPatternOut & { dominantPattern: string | null }> {
  const { baseline, status } = await getBaseline(rootDir);
  if (!baseline) {
    return noBaselineData({ dimension, dominantPattern: null, consistency: "", examples: [] }) as unknown as DominantPatternOut & {
      dominantPattern: null;
    };
  }
  return { status, ...dominantPatternFor(baseline, dimension) };
}
