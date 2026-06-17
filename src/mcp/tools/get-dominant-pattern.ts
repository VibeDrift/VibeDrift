/**
 * get_dominant_pattern — what convention THIS repo actually follows for a
 * given dimension, read off the cached baseline's per-category vote.
 *
 * The agent-facing `dimension` names map to the real (13-value) DriftCategory
 * union — no invented categories. A category with no fired vote means no file
 * deviated, so it's reported as fully consistent.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DriftCategory } from "../../drift/types.js";
import type { RepoDriftBaseline } from "../../core/baseline.js";
import { getBaseline } from "../baseline-provider.js";
import { toToolResult, noBaselineResult, type Status } from "../envelope.js";

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

const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
  dimension: z.enum(DIMENSIONS as [DominantDimension, ...DominantDimension[]]),
};

export interface DominantPatternProjection {
  dimension: DominantDimension;
  dominantPattern: string;
  consistency: string;
  examples: string[];
}

/** Pure projection of a baseline vote into the agent-facing shape. */
export function dominantPatternFor(
  baseline: RepoDriftBaseline,
  dimension: DominantDimension,
): DominantPatternProjection {
  const vote = baseline.perCategoryVote[DIM[dimension]];
  if (!vote) {
    return {
      dimension,
      dominantPattern: "consistent",
      consistency: baseline.ctxFiles.length ? "100% — no deviations detected" : "no files analyzed",
      examples: [],
    };
  }
  const pct = Math.round(vote.consistencyScore);
  return {
    dimension,
    dominantPattern: vote.dominantPattern,
    consistency: `${vote.dominantCount} of ${vote.totalRelevantFiles} files (${pct}%)`,
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
    return noBaselineResult({ dimension, dominantPattern: null, consistency: "", examples: [] })
      .structuredContent as DominantPatternOut & { dominantPattern: null };
  }
  return { status, ...dominantPatternFor(baseline, dimension) };
}

export const registerGetDominantPattern = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "get_dominant_pattern",
      {
        title: "Get the repo's dominant pattern",
        description:
          "Ask what THIS repo's convention is for a dimension (error_handling, imports, exports, async, naming, data_access, logging, auth) before writing new code. Returns the majority pattern, how consistent the repo is, and up to 3 example files to copy. Local; needs a prior `vibedrift scan` to build the baseline.",
        inputSchema,
      },
      async (args) => toToolResult(await run(args)),
    );
  },
};
