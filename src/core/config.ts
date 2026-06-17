/**
 * Optional project-level config loader for VibeDrift.
 *
 * Reads `.vibedrift.json` from the scan root (YAML support deferred — we
 * don't want to add a YAML-parser dependency for one optional feature).
 * Lets users override hand-tuned defaults when they don't fit:
 *
 *   {
 *     "deviation_heuristics": {
 *       "signal_weights": {
 *         "complex_sql":            0.20,
 *         "explanatory_comment":    0.25,
 *         "special_directory":      0.15,
 *         "simple_crud_penalty":   -0.30,
 *         "same_directory_penalty":-0.20,
 *         "git_recency":            0.15,
 *         "adjacent_test":          0.15,
 *         "adr_mention":            0.25
 *       },
 *       "special_directories": ["data-migrations", "cron"]
 *     }
 *   }
 *
 * Silent fallback to defaults if missing or malformed. Logged in --verbose.
 */

import { readFile } from "fs/promises";
import { join } from "path";

export interface VibeDriftConfig {
  deviation_heuristics?: {
    signal_weights?: Partial<{
      complex_sql: number;
      explanatory_comment: number;
      special_directory: number;
      simple_crud_penalty: number;
      same_directory_penalty: number;
      git_recency: number;
      adjacent_test: number;
      adr_mention: number;
    }>;
    special_directories?: string[];
  };
}

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

export async function loadVibeDriftConfig(rootDir: string): Promise<VibeDriftConfig> {
  for (const filename of [".vibedrift.json"]) {
    const path = join(rootDir, filename);
    try {
      const raw = await readFile(path, "utf-8");
      const parsed = JSON.parse(raw) as VibeDriftConfig;
      return parsed;
    } catch {
      // not present or unreadable — continue
    }
  }
  return {};
}

export function resolveDeviationWeights(config: VibeDriftConfig): typeof DEFAULT_DEVIATION_WEIGHTS {
  const overrides = config.deviation_heuristics?.signal_weights ?? {};
  return { ...DEFAULT_DEVIATION_WEIGHTS, ...overrides };
}
