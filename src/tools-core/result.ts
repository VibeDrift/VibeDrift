/**
 * Channel-neutral result primitives for the in-loop tools.
 *
 * These shapes describe WHAT a tool returns, independent of HOW it is delivered.
 * The MCP transport (src/mcp/envelope.ts) wraps this plain data into the SDK's
 * CallToolResult; a code-mode import returns it verbatim; an Agent Skill renders
 * it. Nothing here imports the MCP SDK — that is enforced by the guard test.
 */

// "degraded": an opt-in deep check couldn't reach the cloud (not signed in, over
// budget, rate-limited, network) — the local result is still returned.
export type Status = "ok" | "partial" | "stale" | "no_baseline" | "degraded";

/**
 * An optional, channel-neutral "push" the caller relays to the user. Today the
 * only kind is the deep-scan nudge: when a lot has changed since the last deep
 * scan, a write-time tool result carries this so the channel can offer to run
 * one. Each adapter surfaces it its own way (MCP tucks it in the response, a
 * Skill renders it as a suggested next step, an import returns it as a field).
 * See src/tools-core/nudge.ts.
 */
export interface NudgeHint {
  type: "deep_scan";
  reason: "never_deep_scanned" | "stale_deep_scan";
  /** The FYI to relay to the user, phrased as a yes/no offer. */
  message: string;
  /** What to do if the user says yes. */
  action: string;
}

export interface StructuredBase {
  status: Status;
  message?: string;
  /** Present only when a tool decided to surface a nudge (rare; gated + cooled). */
  nudge?: NudgeHint;
}

export const NO_BASELINE_MESSAGE =
  "No drift baseline for this repo yet. Run `vibedrift scan` once to build it (one-time, then cached). Proceeding without conformance data.";

/**
 * Plain-data result a baseline-dependent tool returns when no baseline exists.
 * Not an error — an honest empty result that tells the caller how to fix it.
 * Tools pass their own empty fields via `extra` (e.g. { deviations: [] }). The
 * MCP layer wraps this with `toToolResult`; other channels return it directly.
 */
export function noBaselineData<T extends Record<string, unknown>>(
  extra: T = {} as T,
): { status: "no_baseline"; message: string } & T {
  return { status: "no_baseline" as const, message: NO_BASELINE_MESSAGE, ...extra };
}
