/**
 * init — one-time project setup for VibeDrift.
 *
 * Channel-neutral core (no transport import): writes `.vibedrift/config.json`
 * (behavior: default format, CI score floor) and, when asked, `.vibedriftignore`
 * (paths to skip). Shared by the interactive `vibedrift init` CLI command and
 * the non-interactive MCP `init` tool.
 *
 * Detection vs application: candidate fixture/generated paths are detected
 * automatically, but exclusions are only WRITTEN when the caller opts in —
 * either by passing explicit `exclude` globs or `applyDetectedExcludes: true`.
 * The CLI gathers that opt-in from the user via prompts; an agent passes it on
 * the user's behalf. We never silently exclude files.
 */
import { z } from "zod";
import { join, resolve } from "path";
import { discoverFiles } from "../../core/discovery.js";
import { suggestExclusions, type ExclusionSuggestion } from "../../core/file-filter.js";
import { appendIgnorePatterns, IGNORE_FILENAME } from "../../utils/vibedriftignore.js";
import { deletePersistedBaseline } from "../../core/baseline.js";
import {
  loadProjectConfig,
  writeProjectConfig,
  projectConfigPath,
  PROJECT_CONFIG_VERSION,
  type ProjectConfig,
} from "../../core/project-config.js";
import { assertPlausibleProjectRoot } from "../root-dir-guard.js";

export const inputSchema = {
  rootDir: z.string().describe("Absolute path to the repository root"),
  exclude: z
    .array(z.string())
    .optional()
    .describe("Glob patterns to write to .vibedriftignore (paths skipped in scans and by the MCP)"),
  applyDetectedExcludes: z
    .boolean()
    .optional()
    .describe(
      "If true, also add the auto-detected fixture/generated globs to .vibedriftignore. Default false — detection is automatic, but exclusions are only written when the user (or the agent on their behalf) opts in.",
    ),
  failOnScore: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("CI score floor: `vibedrift` exits non-zero below this"),
  format: z
    .enum(["html", "terminal", "json", "csv", "docx"])
    .optional()
    .describe("Default report format when --format is not passed"),
  detectOnly: z
    .boolean()
    .optional()
    .describe(
      "Preview mode: detect fixture/generated candidates and return them WITHOUT writing any file. Use this to inspect `detected` before committing to a write.",
    ),
};

export interface InitResult {
  status: "ok";
  /** The resolved absolute repo root that was operated on. */
  rootDir: string;
  /** Whether anything was written (false in detectOnly preview mode). */
  wrote: boolean;
  /** Path of `.vibedrift/config.json` (written unless detectOnly). */
  configPath: string;
  /** The config as written, or the would-be config in detectOnly mode. */
  config: ProjectConfig;
  /** Absolute path of `.vibedriftignore` if any pattern was written, else null. */
  ignorePath: string | null;
  /** Patterns newly added to `.vibedriftignore`. */
  excludesAdded: string[];
  /** Patterns skipped because already present. */
  excludesSkipped: string[];
  /** Auto-detected fixture/generated candidates (so the caller can confirm). */
  detected: ExclusionSuggestion;
}

/** Walk the repo and return the fixture/generated paths worth excluding. */
export async function detectExcludeCandidates(rootDir: string): Promise<ExclusionSuggestion> {
  const { files } = await discoverFiles(rootDir);
  return suggestExclusions(files.map((f) => f.relativePath));
}

export async function run(args: {
  rootDir: string;
  exclude?: string[];
  applyDetectedExcludes?: boolean;
  failOnScore?: number;
  format?: ProjectConfig["format"];
  detectOnly?: boolean;
}): Promise<InitResult> {
  // Normalize so a relative path behaves the same whether called from the CLI
  // (which already resolves) or directly from the MCP adapter.
  const rootDir = resolve(args.rootDir);

  // Defense-in-depth: rootDir is fully caller-controlled and, unlike enable,
  // init has no Allow/Deny consent prompt of its own — this is its only
  // check before writing .vibedrift/config.json / .vibedriftignore into it.
  assertPlausibleProjectRoot(rootDir);

  const detected = await detectExcludeCandidates(rootDir);

  // Merge into any existing config so we never clobber fields the caller
  // didn't set this time.
  const existing = await loadProjectConfig(rootDir);
  const config: ProjectConfig = { version: PROJECT_CONFIG_VERSION, ...(existing ?? {}) };
  if (args.format !== undefined) config.format = args.format;
  if (args.failOnScore !== undefined) config.failOnScore = args.failOnScore;

  // Preview mode: report candidates, touch nothing on disk.
  if (args.detectOnly) {
    return {
      status: "ok",
      rootDir,
      wrote: false,
      configPath: projectConfigPath(rootDir),
      config,
      ignorePath: null,
      excludesAdded: [],
      excludesSkipped: [],
      detected,
    };
  }

  const toExclude = [
    ...(args.exclude ?? []),
    ...(args.applyDetectedExcludes ? detected.globs : []),
  ];

  const configPath = await writeProjectConfig(rootDir, config);

  let ignorePath: string | null = null;
  let excludesAdded: string[] = [];
  let excludesSkipped: string[] = [];
  if (toExclude.length > 0) {
    const res = await appendIgnorePatterns(rootDir, toExclude);
    excludesAdded = res.added;
    excludesSkipped = res.skipped;
    // Report the path whenever the file is now relevant (written this call or
    // already containing the patterns), so callers can point the user at it.
    ignorePath = res.wrote || res.skipped.length > 0 ? join(rootDir, IGNORE_FILENAME) : null;
  }

  // New exclusions change which files discovery sees, so drop any persisted
  // drift baseline — its freshness check only re-hashes files it already
  // knows and would keep serving the now-ignored ones until a full rescan.
  if (excludesAdded.length > 0) {
    await deletePersistedBaseline(rootDir);
  }

  return {
    status: "ok",
    rootDir,
    wrote: true,
    configPath,
    config,
    ignorePath,
    excludesAdded,
    excludesSkipped,
    detected,
  };
}
