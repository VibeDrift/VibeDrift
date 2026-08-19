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
import { directoryOf } from "../../drift/utils.js";

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
  path: z
    .string()
    .optional()
    .describe(
      "Repo-relative path of the file you are about to write. Strongly recommended: conventions are measured per directory, so without it you get the repo's widest-sampled directory, which may not be the one you are editing.",
    ),
};

export interface DominantPatternProjection {
  dimension: DominantDimension;
  dominantPattern: string;
  consistency: string;
  examples: string[];
}

/** Pure projection of a baseline vote into the caller-facing shape.
 *
 *  `relPath` scopes the answer to the caller's own directory, which is the only
 *  scope in which "the dominant pattern" means anything: conventions are voted
 *  per directory by the detectors. Without it the answer is the repo's
 *  widest-sampled directory, which is what let a React component's return shape
 *  be reported as the convention for a directory of server actions.
 *
 *  When a path IS given and its directory has no vote, the honest answer is
 *  "no convention established here", not another directory's rule. */
export function dominantPatternFor(
  baseline: RepoDriftBaseline,
  dimension: DominantDimension,
  relPath?: string,
): DominantPatternProjection {
  const subKey = SECURITY_SUB_DIM[dimension];
  const scoped = relPath !== undefined && !subKey;
  const dir = relPath === undefined ? undefined : directoryOf(relPath);
  const vote = subKey
    ? baseline.securitySubVotes?.[subKey]
    : scoped
      ? baseline.perDirectoryVote?.[DIM[dimension]]?.[dir!]
      : baseline.perCategoryVote[DIM[dimension]];
  if (!vote) {
    return {
      dimension,
      dominantPattern: "consistent",
      consistency: scoped
        ? `no convention established in ${dir}/ — nothing to match`
        : baseline.ctxFiles.length
          ? "100% — no deviations detected"
          : "no files analyzed",
      examples: [],
    };
  }
  const pct = Math.round(vote.consistencyScore);
  const unit = SECURITY_SUB_DIM[dimension] ? "routes" : "files";
  // Name the directory a vote was measured over so its scope is never read as
  // repo-wide. A vote with no directory came from a detector that does not
  // group by directory, and is genuinely repo-wide.
  const where = vote.directory ? ` in ${vote.directory}/` : "";
  const base = `${vote.dominantCount} of ${vote.totalRelevantFiles} ${unit}${where} (${pct}%)`;
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
  path,
}: {
  rootDir: string;
  dimension: DominantDimension;
  path?: string;
}): Promise<DominantPatternOut & { dominantPattern: string | null }> {
  const { baseline, status } = await getBaseline(rootDir);
  if (!baseline) {
    return noBaselineData({ dimension, dominantPattern: null, consistency: "", examples: [] }) as unknown as DominantPatternOut & {
      dominantPattern: null;
    };
  }
  return { status, ...dominantPatternFor(baseline, dimension, path) };
}
