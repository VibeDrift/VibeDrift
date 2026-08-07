/**
 * Small regex helpers shared across the analyzers, Code DNA, and core layers.
 */

/** Escape regex metacharacters so a literal string can be interpolated into a RegExp. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
