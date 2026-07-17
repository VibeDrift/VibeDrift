/**
 * Project file discovery and manifest loading.
 *
 * Recursively walks the project directory, respects .gitignore rules, and
 * loads ecosystem manifests (package.json, go.mod, Cargo.toml, etc.) to
 * build the AnalysisContext that every analyzer receives.
 */

import { readdir, readFile, stat } from "fs/promises";
import { join, relative } from "path";
import type {
  SourceFile,
  PackageJson,
  GoMod,
  NestedGoModule,
  CargoToml,
  AnalysisContext,
  SupportedLanguage,
} from "./types.js";
import { detectLanguage } from "./language.js";
import { loadGitignore } from "../utils/gitignore.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "target", "vendor", "__pycache__", ".venv", "venv",
  "coverage", ".turbo", ".cache", ".idea", ".vscode",
]);

// Vendored / minified / generated FILES slip past SKIP_DIRS because they live
// inside otherwise-scanned dirs (e.g. a checked-in jquery-3.2.1.min.js or the
// Ace editor bundle ace.js). Their "functions" are not the user's code and
// produce false drift / anomaly flags, so exclude them from every layer.
const VENDORED_FILE_RE = /\.min\.(js|mjs|cjs|css)$|\.bundle\.(js|mjs|cjs)$/i;
// A source line longer than this signals a minified/generated bundle regardless
// of filename (hand-written source effectively never exceeds it).
const MAX_SOURCE_LINE_LENGTH = 2000;

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_FILE_COUNT = 5000;

export interface DiscoveryWarnings {
  truncated: boolean;
  truncatedAt: number;
  skippedDirs: string[];
  unreadableFiles: string[];
}

export async function discoverFiles(rootDir: string): Promise<{ files: SourceFile[]; warnings: DiscoveryWarnings }> {
  const ig = await loadGitignore(rootDir);
  const files: SourceFile[] = [];
  const warnings: DiscoveryWarnings = {
    truncated: false,
    truncatedAt: 0,
    skippedDirs: [],
    unreadableFiles: [],
  };

  async function walk(dir: string) {
    if (files.length >= MAX_FILE_COUNT) {
      warnings.truncated = true;
      warnings.truncatedAt = MAX_FILE_COUNT;
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      // Permission denied, etc — skip this directory, don't crash
      warnings.skippedDirs.push(relative(rootDir, dir) || dir);
      return;
    }

    // Deterministic traversal: readdir order is filesystem-dependent
    // (APFS returns sorted, ext4 returns hash order). Sort by code-unit
    // comparison — NOT localeCompare, which is itself locale-dependent —
    // so traversal order (and thus MAX_FILE_COUNT truncation) is identical
    // on every machine.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (files.length >= MAX_FILE_COUNT) {
        warnings.truncated = true;
        warnings.truncatedAt = MAX_FILE_COUNT;
        break;
      }

      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (ig.ignores(relPath + "/")) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (ig.ignores(relPath)) continue;
        if (VENDORED_FILE_RE.test(entry.name)) continue; // jquery-3.2.1.min.js, *.bundle.js, …
        const language = detectLanguage(entry.name);
        if (!language) continue;

        try {
          const info = await stat(fullPath);
          if (info.size > MAX_FILE_SIZE) continue;

          const content = await readFile(fullPath, "utf-8");
          const lines = content.split("\n");
          // Skip minified/generated bundles regardless of filename (e.g. ace.js):
          // they pack code into very long lines; hand-written source does not.
          let maxLineLen = 0;
          for (const l of lines) if (l.length > maxLineLen) maxLineLen = l.length;
          if (maxLineLen > MAX_SOURCE_LINE_LENGTH) continue;
          files.push({ path: fullPath, relativePath: relPath, language, content, lineCount: lines.length });
        } catch {
          // Unreadable file — permission denied, broken symlink, etc.
          warnings.unreadableFiles.push(relPath);
        }
      }
    }
  }

  await walk(rootDir);
  // Final guarantee: sort the flattened file list by relativePath in
  // code-unit order. Every downstream Map keyed by file inherits this
  // order, and JS Array.sort is stable, so dominance-vote and report
  // tie-breaks resolve identically across machines/clones.
  files.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  return { files, warnings };
}

export async function loadPackageJson(rootDir: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(join(rootDir, "package.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadGoMod(rootDir: string): Promise<GoMod | null> {
  let raw: string;
  try {
    raw = await readFile(join(rootDir, "go.mod"), "utf-8");
  } catch {
    return null;
  }

  const result = parseGoModSource(raw);
  if (!result) return null;
  const { modules: nested, opaqueDirs } = await findNestedGoMods(rootDir);
  // The guard fires on ANY nested go.mod, parseable or not — over-detection
  // only ever over-disables cross-file auth resolution (safe). The parsed
  // list carries only real modules for the dependency analyzer; opaqueDirs
  // carries the ones it must exclude rather than mis-attribute to root.
  if (nested.length > 0 || opaqueDirs.length > 0) result.hasNestedModule = true;
  if (nested.length > 0) result.nestedModules = nested;
  if (opaqueDirs.length > 0) result.opaqueModuleDirs = opaqueDirs;
  return result;
}

function parseGoModSource(raw: string): GoMod | null {
  const lines = raw.split("\n");
  const result: GoMod = { module: "", require: [] };

  // State-machine parser: track whether we're inside a `require (` / `replace (`
  // block. `hasReplace` records ANY replace directive (block or single-line) —
  // a replace remaps an import path to a different dir, which makes root-prefix
  // package math unsafe, so it disables Go cross-file resolution downstream.
  let inRequire = false;
  let hasReplace = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("module ")) {
      result.module = trimmed.slice(7).trim();
    } else if (trimmed.startsWith("go ")) {
      result.goVersion = trimmed.slice(3).trim();
    } else if (trimmed === "require (") {
      inRequire = true;
    } else if (trimmed === "replace (") {
      hasReplace = true;
    } else if (trimmed === ")") {
      inRequire = false;
    } else if (inRequire && trimmed && !trimmed.startsWith("//")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const entry: { path: string; version: string; indirect?: boolean } = { path: parts[0], version: parts[1] };
        if (/\/\/\s*indirect/.test(trimmed)) entry.indirect = true;
        result.require.push(entry);
      }
    } else if (trimmed.startsWith("require ") && !trimmed.includes("(")) {
      const parts = trimmed.slice(8).trim().split(/\s+/);
      if (parts.length >= 2) {
        const entry: { path: string; version: string; indirect?: boolean } = { path: parts[0], version: parts[1] };
        if (/\/\/\s*indirect/.test(trimmed)) entry.indirect = true;
        result.require.push(entry);
      }
    } else if (trimmed.startsWith("replace ") && !trimmed.includes("(")) {
      hasReplace = true; // single-line: `replace a => b`
    }
  }

  if (!result.module) return null;
  if (hasReplace) result.hasReplace = true;
  return result;
}

/**
 * Collects every `go.mod` in a subdirectory under `rootDir` (the root's own
 * go.mod does not count). A nested module breaks the single-root-prefix
 * assumption Go cross-file package resolution relies on, so any hit still
 * disables that resolution wholesale (via `hasNestedModule`); the parsed list
 * additionally lets the dependency analyzer check each .go file against its
 * nearest enclosing module instead of the root. Unparseable nested go.mod
 * files are returned as `opaqueDirs` so the analyzer can EXCLUDE their files
 * rather than mis-attribute them to root. Sorted for determinism.
 *
 * This walk skips `SKIP_DIRS` and dotdirs but does NOT apply the main file
 * walk's `.gitignore`, file-count cap, or file-size limit — so it can surface
 * a nested module whose `.go` files were filtered out of `ctx.files`. The
 * analyzer guards against that by only phantom-checking modules that actually
 * contributed a scanned file.
 */
async function findNestedGoMods(
  rootDir: string,
): Promise<{ modules: NestedGoModule[]; opaqueDirs: string[] }> {
  const found: NestedGoModule[] = [];
  const opaque: string[] = [];
  async function walk(dir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(join(dir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
      } else if (relDir !== "" && entry.isFile() && entry.name === "go.mod") {
        let parsed = null;
        try {
          parsed = parseGoModSource(await readFile(join(dir, entry.name), "utf-8"));
        } catch {
          // unreadable nested go.mod
        }
        if (parsed) found.push({ dir: relDir, module: parsed.module, require: parsed.require });
        else opaque.push(relDir);
      }
    }
  }
  await walk(rootDir, "");
  found.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  opaque.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { modules: found, opaqueDirs: opaque };
}

export async function loadCargoToml(rootDir: string): Promise<CargoToml | null> {
  try {
    const raw = await readFile(join(rootDir, "Cargo.toml"), "utf-8");
    const result: CargoToml = { dependencies: {} };

    let inDeps = false;
    let inPackage = false;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "[package]") { inPackage = true; inDeps = false; }
      else if (trimmed === "[dependencies]") { inDeps = true; inPackage = false; }
      else if (trimmed.startsWith("[")) { inDeps = false; inPackage = false; }
      else if (inPackage && trimmed.startsWith("name")) {
        const match = trimmed.match(/name\s*=\s*"([^"]+)"/);
        if (match) result.name = match[1];
      } else if (inDeps && trimmed.includes("=") && !trimmed.startsWith("#")) {
        const eqIdx = trimmed.indexOf("=");
        const depName = trimmed.slice(0, eqIdx).trim();
        const depVal = trimmed.slice(eqIdx + 1).trim().replace(/"/g, "");
        result.dependencies[depName] = depVal;
      }
    }

    return Object.keys(result.dependencies).length > 0 || result.name ? result : null;
  } catch {
    return null;
  }
}

export async function loadRequirementsTxt(rootDir: string): Promise<string[] | null> {
  for (const file of ["requirements.txt", "requirements/base.txt"]) {
    try {
      const raw = await readFile(join(rootDir, file), "utf-8");
      const deps: string[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
        const name = trimmed.split(/[>=<!\[\s]/)[0];
        if (name) deps.push(name.toLowerCase());
      }
      return deps.length > 0 ? deps : null;
    } catch {
      continue;
    }
  }

  try {
    const raw = await readFile(join(rootDir, "pyproject.toml"), "utf-8");
    const deps: string[] = [];
    let inDeps = false;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "dependencies = [") inDeps = true;
      else if (inDeps && trimmed === "]") inDeps = false;
      else if (inDeps) {
        const match = trimmed.match(/^"([^>=<!\s"]+)/);
        if (match) deps.push(match[1].toLowerCase());
      }
    }
    return deps.length > 0 ? deps : null;
  } catch {
    return null;
  }
}

export async function loadEnvExample(rootDir: string): Promise<Map<string, string> | null> {
  try {
    const raw = await readFile(join(rootDir, ".env.example"), "utf-8");
    const vars = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        vars.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
      }
    }
    return vars.size > 0 ? vars : null;
  } catch {
    return null;
  }
}

function computeLanguageBreakdown(
  files: SourceFile[],
): { breakdown: Map<SupportedLanguage, { files: number; lines: number }>; dominant: SupportedLanguage | null } {
  const breakdown = new Map<SupportedLanguage, { files: number; lines: number }>();

  for (const file of files) {
    if (!file.language) continue;
    const existing = breakdown.get(file.language) ?? { files: 0, lines: 0 };
    existing.files++;
    existing.lines += file.lineCount;
    breakdown.set(file.language, existing);
  }

  let dominant: SupportedLanguage | null = null;
  let maxLines = 0;
  for (const [lang, stats] of breakdown) {
    if (stats.lines > maxLines) { maxLines = stats.lines; dominant = lang; }
  }

  return { breakdown, dominant };
}

/**
 * Recompute the size-derived fields of a context after its `files` array has
 * been filtered (--include/--exclude, --diff). Scoring reads BOTH totalLines
 * (evidence weighting) and languageBreakdown/dominantLanguage (peer group),
 * so every filter site must refresh all of them — refreshing only totalLines
 * leaves the language stats describing files that are no longer in scope.
 */
export function recomputeContextStats(ctx: AnalysisContext): void {
  ctx.totalLines = ctx.files.reduce((sum, f) => sum + f.lineCount, 0);
  const { breakdown, dominant } = computeLanguageBreakdown(ctx.files);
  ctx.languageBreakdown = breakdown;
  ctx.dominantLanguage = dominant;
}

export async function buildAnalysisContext(rootDir: string): Promise<{ ctx: AnalysisContext; warnings: DiscoveryWarnings }> {
  // Load file tree, manifests, git metadata, and intent hints in parallel
  // — git + intent parsing are both I/O-bound. Overlapping them with file
  // discovery keeps cold starts under 500ms on a 500-file repo. All three
  // optional signals are best-effort: each returns null/empty on absence,
  // no-op fallback downstream.
  const { collectGitMetadata } = await import("./git-metadata.js");
  const { parseIntentFiles } = await import("../intent/parser.js");
  const [discovery, packageJson, goMod, cargoToml, requirementsTxt, envExample, gitResult, intentResult] = await Promise.all([
    discoverFiles(rootDir),
    loadPackageJson(rootDir),
    loadGoMod(rootDir),
    loadCargoToml(rootDir),
    loadRequirementsTxt(rootDir),
    loadEnvExample(rootDir),
    collectGitMetadata(rootDir),
    parseIntentFiles(rootDir),
  ]);

  const { files, warnings } = discovery;
  const totalLines = files.reduce((sum, f) => sum + f.lineCount, 0);
  const { breakdown, dominant } = computeLanguageBreakdown(files);

  // Graft git metadata onto each SourceFile keyed by relativePath so
  // drift detectors + scoring can read file.git without an external
  // lookup. Files not present in git history (freshly added, untracked)
  // get git=null and fall back to neutral temporal weight.
  if (gitResult) {
    for (const f of files) {
      const meta = gitResult.byFile.get(f.relativePath);
      f.git = meta ?? null;
    }
  }

  const ctx: AnalysisContext = {
    rootDir,
    files,
    packageJson,
    goMod,
    cargoToml,
    requirementsTxt,
    envExample,
    totalLines,
    languageBreakdown: breakdown,
    dominantLanguage: dominant,
    hasGitMetadata: gitResult !== null,
    intentHints: intentResult.hints,
  };

  return { ctx, warnings };
}
