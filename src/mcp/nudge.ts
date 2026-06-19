/**
 * MCP-side finalize: wrap a tool's finalized result into the wire envelope.
 *
 * The nudge DECISION and the `lastDeepScanAt` reset are channel-neutral and live
 * in src/tools-core (decideNudge / maybeNudge / finalizeResult). This file is the
 * thin MCP adapter: it runs the core finalize, then serializes via toToolResult.
 * decideNudge / maybeNudge / NudgeState are re-exported so existing importers of
 * "../nudge.js" keep working.
 */
import { toToolResult, type ToolResult } from "./envelope.js";
import { finalizeResult } from "../tools-core/finalize.js";
import type { StructuredBase } from "../tools-core/result.js";

export { decideNudge, maybeNudge, _resetSession } from "../tools-core/nudge.js";
export type { NudgeState } from "../tools-core/nudge.js";

/**
 * Finalize an MCP tool's structured result into the wire envelope. A successful
 * in-loop deep check resets the nudge clock; when `opts.nudge` is set, a
 * deep-scan nudge may be attached (gated + cooled). See src/tools-core/nudge.ts.
 */
export async function finalizeMcpResult<T extends StructuredBase & { deep?: { degraded: boolean } }>(
  out: T,
  opts: { nudge: boolean },
): Promise<ToolResult> {
  return toToolResult(await finalizeResult(out, opts));
}
