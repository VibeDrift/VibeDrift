/**
 * MCP tool-result envelope — the WIRE shape for the MCP transport.
 *
 * One shape for every tool: a `structuredContent` object (machine-parseable for
 * the agent) mirrored into a single `text` block (the SDK convention so clients
 * that only read text still get the data). Tools NEVER throw to signal "no data"
 * — they return a valid result with a `status`, so the agent can degrade
 * gracefully instead of seeing a tool error.
 *
 * The channel-neutral result primitives (Status, StructuredBase, NudgeHint,
 * noBaselineData) live in src/tools-core/result.ts; this file only adds the
 * MCP-specific serialization. They are re-exported here so existing importers of
 * "../envelope.js" keep working.
 */
import { noBaselineData, type StructuredBase } from "../tools-core/result.js";

export { NO_BASELINE_MESSAGE, noBaselineData } from "../tools-core/result.js";
export type { Status, StructuredBase, NudgeHint } from "../tools-core/result.js";

/**
 * Matches the SDK's CallToolResult: a `content` array + optional
 * `structuredContent`, with a top-level `[x: string]: unknown` index signature
 * (for `_meta` extensibility). The annotation is what makes a tool handler's
 * return assignable to the SDK's expected type — a plain `{content, ...}` object
 * literal is not, because it lacks that index signature.
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

/**
 * Returned by baseline-dependent tools when no baseline exists for the repo.
 * Not an error — an honest empty result that tells the agent how to fix it.
 * Tools pass their own empty fields via `extra` (e.g. { deviations: [] }).
 */
export function noBaselineResult(extra: Record<string, unknown> = {}): ToolResult {
  return toToolResult(noBaselineData(extra));
}
