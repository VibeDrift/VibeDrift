/**
 * Shared MCP tool-result envelope.
 *
 * One shape for every tool: a `structuredContent` object (machine-parseable
 * for the agent) mirrored into a single `text` block (the SDK convention so
 * clients that only read text still get the data). Tools NEVER throw to signal
 * "no data" — they return a valid result with a `status`, so the agent can
 * degrade gracefully instead of seeing a tool error.
 */
// "degraded": an opt-in deep check couldn't reach the cloud (not signed in,
// over budget, rate-limited, network) — the local result is still returned.
export type Status = "ok" | "partial" | "stale" | "no_baseline" | "degraded";

/**
 * An optional, in-band "push" the agent relays to the user. Today the only kind
 * is the deep-scan nudge: when a lot has changed since the last deep scan, a
 * write-time tool result carries this so the agent can offer to run one — no
 * separate channel, no new human behavior. See src/mcp/nudge.ts.
 */
export interface NudgeHint {
  type: "deep_scan";
  reason: "never_deep_scanned" | "stale_deep_scan";
  /** The FYI for the agent to relay to the user, phrased as a yes/no offer. */
  message: string;
  /** What the agent should do if the user says yes. */
  action: string;
}

export interface StructuredBase {
  status: Status;
  message?: string;
  /** Present only when a tool decided to surface a nudge (rare; gated + cooled). */
  nudge?: NudgeHint;
}

/**
 * Matches the SDK's CallToolResult: a `content` array + optional
 * `structuredContent`, with a top-level `[x: string]: unknown` index signature
 * (for `_meta` extensibility). The annotation is what makes a tool handler's
 * return assignable to the SDK's expected type — a plain `{content, ...}`
 * object literal is not, because it lacks that index signature.
 */
export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}

export function toToolResult<T extends StructuredBase>(structuredContent: T): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent: structuredContent as unknown as Record<string, unknown>,
  };
}

export const NO_BASELINE_MESSAGE =
  "No drift baseline for this repo yet. Run `vibedrift scan` once to build it (one-time, then cached). Proceeding without conformance data.";

/**
 * Returned by baseline-dependent tools when no baseline exists for the repo.
 * Not an error — an honest empty result that tells the agent how to fix it.
 * Tools pass their own empty fields via `extra` (e.g. { deviations: [] }).
 */
export function noBaselineResult(extra: Record<string, unknown> = {}) {
  return toToolResult({ status: "no_baseline" as const, message: NO_BASELINE_MESSAGE, ...extra });
}
