import type { PerTurnUsage, Rates } from "./types.js";

export function computeRunCostUsd(u: PerTurnUsage, r: Rates): number {
  return u.input_tokens * r.input + u.output_tokens * r.output +
    u.cache_creation_input_tokens * r.cacheWrite + u.cache_read_input_tokens * r.cacheRead;
}
