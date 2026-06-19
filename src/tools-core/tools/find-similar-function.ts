/**
 * find_similar_function — before writing a new function, check whether the repo
 * already has one that does the same thing (so the caller extends it instead of
 * writing a third copy). Verifies the query body against the cached MinHash index
 * with exact token-LCS. Local; no network for the base check. Channel-neutral.
 */
import { z } from "zod";
import { getBaseline } from "../../mcp/baseline-provider.js";
import { findSimilarToBody, type SimMatch } from "../../codedna/find-similar-to-body.js";
import { noBaselineData, type Status } from "../result.js";
import { deepAnalyze, bodyToPayloads, inferLanguage, degradeMessage, type DeepResult } from "../../mcp/deep-client.js";
import { buildCandidatePayloads } from "../../mcp/candidate-feeder.js";
import { deepDuplicatesViaIndex } from "../../mcp/deep-index.js";

const SIMILARITY_THRESHOLD = 0.6;
const MAX_MATCHES = 20;
const DEEP_QUERY_FILE = "query"; // no file yet (function not written) — synthetic name

export const inputSchema = {
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
    return noBaselineData({ found: false, matches: [], more: 0 }) as unknown as FindSimilarOut;
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
  // Fast path: embed just this function and cosine it against the cached per-repo
  // embedding index. Cold-start fallback: feed the query + a sample of the repo's
  // functions to /v1/analyze (the index is built lazily, so this is rare).
  const queryPayload = bodyToPayloads(body, DEEP_QUERY_FILE)[0];
  let deepRes = await deepDuplicatesViaIndex(rootDir, queryPayload, baseline.key);
  if (deepRes === null) {
    const payloads = await buildCandidatePayloads(rootDir, queryPayload);
    deepRes = await deepAnalyze(payloads, inferLanguage(DEEP_QUERY_FILE), queryPayload.id);
  }
  out.deep = deepRes;
  if (deepRes.degraded) {
    out.status = "degraded";
    out.message = degradeMessage(deepRes.reason);
    return out;
  }
  if (deepRes.duplicates.length > 0) {
    out.found = true; // cloud found a semantic twin the local index missed
    out.status = "partial";
  }
  return out;
}
