/**
 * Hand-tuned default signal weights for the Code DNA deviation heuristics
 * (src/codedna/deviation-heuristics.ts). This module previously also shipped
 * a documented `.vibedrift.json` override loader (`loadVibeDriftConfig` /
 * `resolveDeviationWeights`) for these weights, but nothing ever called it —
 * every consumer imported `DEFAULT_DEVIATION_WEIGHTS` directly, so the
 * documented override had no effect no matter what a user put in
 * `.vibedrift.json`. Removed rather than wired up: a documented, silently
 * inert feature is worse than no feature.
 */

export const DEFAULT_DEVIATION_WEIGHTS = {
  complex_sql: 0.15,
  explanatory_comment: 0.20,
  special_directory: 0.20,
  simple_crud_penalty: -0.30,
  same_directory_penalty: -0.20,
  git_recency: 0.15,
  adjacent_test: 0.15,
  adr_mention: 0.25,
};
