import { callMlApi } from "../ml-client/client.js";
import type { MlAnalyzeRequest, MlFunctionPayload } from "../ml-client/types.js";
import { resolveToken, resolveApiUrl } from "../auth/resolver.js";

/**
 * In-loop deep analysis for the MCP server.
 *
 * Reuses the CLI's `callMlApi` to POST the one-to-few functions an agent is
 * editing to the live `/v1/analyze` deep endpoint — the same CodeRankEmbed +
 * Claude-validated path a full `vibedrift . --deep` uses — tagged `source: 'mcp'`
 * so the API bills it at 1/50 of a deep scan and validates with the cheap model.
 *
 * This function NEVER throws: any failure (not signed in, over quota, rate
 * limited, network/timeout) resolves to `{ degraded: true, reason }` so the
 * calling tool can fall back to its local result instead of erroring the agent.
 */

export interface DeepFinding {
  kind: "intent" | "duplicate";
  detail: string;
  confidence: number;
  verdict?: string;
}

export type DegradeReason = "no_token" | "quota" | "rate_limited" | "network" | "timeout";

export interface DeepResult {
  degraded: boolean;
  reason?: DegradeReason;
  intentMismatches: DeepFinding[];
  duplicates: DeepFinding[];
}

export async function deepAnalyze(
  functions: MlFunctionPayload[],
  language: string,
): Promise<DeepResult> {
  const empty = { intentMismatches: [], duplicates: [] };

  const tok = await resolveToken();
  if (!tok?.token) return { degraded: true, reason: "no_token", ...empty };

  const apiUrl = await resolveApiUrl();
  const request: MlAnalyzeRequest = {
    language,
    file_count: new Set(functions.map((f) => f.file)).size,
    functions,
    deviations: [],
    llm_validations: [],
    defer_persist: false, // MCP deep checks persist + count for billing
    source: "mcp", // 1/50-unit billing + Haiku validation server-side
  };

  try {
    const resp = await callMlApi(request, tok.token, apiUrl);
    return {
      degraded: false,
      intentMismatches: (resp.intent_mismatches ?? []).map((m) => ({
        kind: "intent" as const,
        detail: m.name,
        confidence: m.confidence,
        verdict: m.llm_verdict,
      })),
      duplicates: (resp.duplicates ?? []).map((d) => ({
        kind: "duplicate" as const,
        detail: `${d.function_a} ≈ ${d.function_b}`,
        confidence: d.confidence,
        verdict: d.llm_verdict ?? d.verdict,
      })),
    };
  } catch (e) {
    return { degraded: true, reason: classify(e), ...empty };
  }
}

function classify(e: unknown): DegradeReason {
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  if (msg.includes("402")) return "quota";
  if (msg.includes("429")) return "rate_limited";
  if (msg.includes("abort") || msg.includes("timeout")) return "timeout";
  return "network";
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", rb: "ruby", php: "php",
};

/** Best-effort language from a file path; "unknown" when unrecognized. */
export function inferLanguage(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? "unknown";
}

/** Lightweight function-name guess from a raw body. The NAME drives intent
 *  detection (name-vs-body cosine), so it's worth extracting even heuristically.
 *  Strips comments first so a doc comment like `// this function does X` can't
 *  poison the match. */
export function guessName(body: string): string {
  const code = body.replace(/\/\/.*$/gm, "").replace(/#.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const m =
    code.match(/(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)/) ??
    code.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/) ??
    code.match(/([A-Za-z_$][\w$]*)\s*\(/);
  return m?.[1] ?? "change";
}

/** Agent-facing one-liner explaining why a deep check fell back to local. */
export function degradeMessage(reason: DegradeReason | undefined): string {
  switch (reason) {
    case "no_token": return "Deep check skipped — sign in with `vibedrift login` (Pro/Team). Showing local result.";
    case "quota": return "Deep budget exhausted — add credits at https://vibedrift.ai/pricing. Showing local result.";
    case "rate_limited": return "In-loop deep limit reached; retry shortly. Showing local result.";
    default: return "Deep check unavailable right now. Showing local result.";
  }
}

/** Turn a single proposed/changed function body into the API payload shape. */
export function bodyToPayloads(body: string, file: string): MlFunctionPayload[] {
  const name = guessName(body);
  return [{
    id: `${file}::${name}`, name, file, body,
    line_start: 0, line_end: 0, language: inferLanguage(file),
  }];
}
