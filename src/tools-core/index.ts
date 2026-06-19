/**
 * @vibedrift/cli/tools — the in-loop drift tools as a channel-neutral API.
 *
 * These are the same five tools the MCP server exposes, as plain async functions
 * you can import and call directly (code-mode hosts, Agent Skills, a git hook, a
 * native plugin). Each takes a plain args object and returns plain data; none of
 * them imports a transport. The MCP server in src/mcp is one adapter over exactly
 * these functions — this barrel is the port.
 *
 *   import { validateChange, findSimilarFunction } from "@vibedrift/cli/tools";
 *   const r = await validateChange({ rootDir, targetPath, body });
 *   if (!r.ok) { ...the change would drift or duplicate... }
 *
 * A baseline is built lazily on first call per repo (one-time), then cached. The
 * optional `deep: true` checks are metered server-side and degrade gracefully.
 */
export { run as getIntentHints } from "./tools/get-intent-hints.js";
export { run as getDominantPattern } from "./tools/get-dominant-pattern.js";
export { run as checkFileDrift } from "./tools/check-file-drift.js";
export { run as findSimilarFunction } from "./tools/find-similar-function.js";
export { run as validateChange } from "./tools/validate-change.js";

// Lower-level pure projections, for callers that already hold a baseline.
export { dominantPatternFor } from "./tools/get-dominant-pattern.js";
export { fileDriftFromBaseline } from "./tools/check-file-drift.js";
export { validateChange as validateChangeAgainstBaseline } from "./tools/validate-change.js";

// Result shapes + the channel-neutral finalize (attaches the deep-scan nudge as
// data so any channel can surface it).
export { finalizeResult } from "./finalize.js";
export { noBaselineData, NO_BASELINE_MESSAGE } from "./result.js";
export type { Status, NudgeHint, StructuredBase } from "./result.js";

export type { IntentHintOut } from "./tools/get-intent-hints.js";
export type {
  DominantDimension,
  DominantPatternOut,
  DominantPatternProjection,
} from "./tools/get-dominant-pattern.js";
export { DIMENSIONS } from "./tools/get-dominant-pattern.js";
export type { Deviation, CheckFileDriftOut } from "./tools/check-file-drift.js";
export type { FindSimilarOut } from "./tools/find-similar-function.js";
export type { Conflict, ValidateChangeResult, ValidateChangeOut } from "./tools/validate-change.js";
