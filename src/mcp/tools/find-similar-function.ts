/**
 * find_similar_function — before writing a new function, check whether the repo
 * already has one that does the same thing (so the agent extends it instead of
 * writing a third copy). Verifies the query body against the cached MinHash
 * index with exact token-LCS. Local; no network.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBaseline } from "../baseline-provider.js";
import { findSimilarToBody, type SimMatch } from "../../codedna/find-similar-to-body.js";
import { noBaselineResult, type Status } from "../envelope.js";
import { finalizeMcpResult } from "../nudge.js";
import { deepAnalyze, bodyToPayloads, inferLanguage, degradeMessage, type DeepResult } from "../deep-client.js";

const SIMILARITY_THRESHOLD = 0.6;
const MAX_MATCHES = 20;
const DEEP_QUERY_FILE = "query"; // no file yet (function not written) — synthetic name

const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
  body: z.string().describe("The function body (source) you are about to write"),
  deep: z
    .boolean()
    .optional()
    .describe(
      "Opt-in cloud deep check (Pro/Team): surfaces SEMANTIC duplicates the local MinHash index misses (CodeRankEmbed + Claude-validated) via the API. Costs 1/50 of a deep scan, hourly-capped. Use before writing a non-trivial function you suspect may already exist.",
    ),
};

export interface FindSimilarOut {
  status: Status;
  message?: string;
  found: boolean;
  matches: SimMatch[];
  more: number;
  // Present only when `deep: true` — cloud semantic duplicates / degraded marker.
  deep?: DeepResult;
}

export async function run({
  rootDir,
  body,
  deep,
}: {
  rootDir: string;
  body: string;
  deep?: boolean;
}): Promise<FindSimilarOut> {
  const { baseline, status } = await getBaseline(rootDir);
  if (!baseline) {
    return noBaselineResult({ found: false, matches: [], more: 0 })
      .structuredContent as unknown as FindSimilarOut;
  }
  const all = findSimilarToBody(body, baseline.minhashIndex, {
    threshold: SIMILARITY_THRESHOLD,
    cap: MAX_MATCHES,
  });
  const out: FindSimilarOut = {
    status,
    found: all.length > 0,
    matches: all,
    more: 0, // findSimilarToBody already capped at MAX_MATCHES
  };

  if (!deep) return out;

  // Opt-in deep pass — semantic duplicates the local token-LCS index can't see.
  const deepRes = await deepAnalyze(bodyToPayloads(body, DEEP_QUERY_FILE), inferLanguage(DEEP_QUERY_FILE));
  out.deep = deepRes;
  if (deepRes.degraded) {
    out.status = "degraded";
    out.message = degradeMessage(deepRes.reason);
    return out;
  }
  if (deepRes.duplicates.length > 0) {
    out.found = true;          // cloud found a semantic twin the local index missed
    out.status = "partial";
  }
  return out;
}

export const registerFindSimilarFunction = {
  run,
  register(server: McpServer): void {
    server.registerTool(
      "find_similar_function",
      {
        title: "Find a similar existing function",
        description:
          "Before writing a new function, check whether this repo already has one that does the same thing — so you extend or reuse it instead of writing a duplicate. Returns matching functions with their file, name, line, and similarity. Local; needs a prior `vibedrift scan`.",
        inputSchema,
      },
      // A successful deep pass resets the nudge clock; the nudge itself rides on
      // the write-time tools (validate_change / check_file_drift).
      async (args) => finalizeMcpResult(await run(args), { nudge: false }),
    );
  },
};
