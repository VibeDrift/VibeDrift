/**
 * Project-level VibeDrift configuration.
 *
 * Lives at `<project>/.vibedrift/config.json` — the same project folder that
 * `--write-context` writes into, and meant to be committed so a team shares
 * one setup. Holds *behavior* (default report format, CI score floor); the
 * list of *paths* to skip lives separately in `.vibedriftignore` (which both
 * the scan and the MCP already honor through file discovery).
 *
 * This is distinct from the per-user global config at `$HOME/.vibedrift/
 * config.json` (auth token, telemetry) — see `src/auth/config.ts`. Precedence
 * for scans: explicit CLI flag > project config > built-in default.
 *
 * Created and edited by `vibedrift init`.
 */
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

export const PROJECT_CONFIG_VERSION = 1;
export const PROJECT_DIR = ".vibedrift";
export const PROJECT_CONFIG_FILENAME = "config.json";

export type ReportFormat = "html" | "terminal" | "json" | "csv" | "docx";
const VALID_FORMATS = new Set<ReportFormat>(["html", "terminal", "json", "csv", "docx"]);

export interface ProjectConfig {
  /** Schema version, for forward-compatible migrations. */
  version: number;
  /** Default report format when `--format` is not passed. */
  format?: ReportFormat;
  /** CI score floor: `vibedrift` exits non-zero below this when `--fail-on-score` is not passed. */
  failOnScore?: number;
  /** Security Consistency check settings. */
  security?: {
    /**
     * Gitignore-style globs matched against a route's file path. A matching
     * route is excluded from the auth/validation/rate-limit dominance vote
     * entirely, the same denominator-removing suppression the inline
     * `@vibedrift-public` annotation gives a single route, declared once
     * for a whole directory instead of per-route. Matched with the same
     * `ignore` package `.vibedriftignore` uses, so semantics stay consistent
     * across the tool.
     */
    allowlist?: string[];
  };
}

export function projectConfigPath(rootDir: string): string {
  return join(rootDir, PROJECT_DIR, PROJECT_CONFIG_FILENAME);
}

/**
 * Coerce arbitrary parsed JSON into a safe ProjectConfig, dropping unknown or
 * out-of-range fields. Pure (no I/O) so it can be unit-tested directly and
 * reused by both the loader and any migration. Returns null only when the
 * input isn't an object at all.
 */
export function normalizeProjectConfig(input: unknown): ProjectConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const config: ProjectConfig = {
    version: typeof o.version === "number" ? o.version : PROJECT_CONFIG_VERSION,
  };
  if (typeof o.format === "string" && VALID_FORMATS.has(o.format as ReportFormat)) {
    config.format = o.format as ReportFormat;
  }
  if (typeof o.failOnScore === "number" && o.failOnScore >= 0 && o.failOnScore <= 100) {
    config.failOnScore = o.failOnScore;
  }
  if (o.security && typeof o.security === "object" && !Array.isArray(o.security)) {
    const sec = o.security as Record<string, unknown>;
    if (Array.isArray(sec.allowlist)) {
      const allowlist = sec.allowlist.filter(
        (g): g is string => typeof g === "string" && g.trim().length > 0,
      );
      if (allowlist.length > 0) config.security = { allowlist };
    }
  }
  return config;
}

/** Read and validate the project config; returns null if absent or unparseable. */
export async function loadProjectConfig(rootDir: string): Promise<ProjectConfig | null> {
  try {
    const raw = await readFile(projectConfigPath(rootDir), "utf-8");
    return normalizeProjectConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Write the project config (creating `.vibedrift/` if needed). Returns the path written. */
export async function writeProjectConfig(rootDir: string, config: ProjectConfig): Promise<string> {
  await mkdir(join(rootDir, PROJECT_DIR), { recursive: true });
  const path = projectConfigPath(rootDir);
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return path;
}
