/**
 * Public render API — importable by other packages.
 *
 * Usage:
 *   import { renderHtmlReport } from "@vibedrift/cli/render";
 */
export { renderHtmlReport } from "./output/html.js";
export { computeScores, estimateScoreAfterFixes } from "./scoring/engine.js";
