/**
 * Real module resolution for the import graph.
 *
 * Resolves import specifiers to actual file paths using:
 *   - Relative path resolution (./foo, ../bar)
 *   - Extension mapping (.js → .ts/.tsx, extensionless → .ts/.tsx/.js)
 *   - Index file resolution (./dir → ./dir/index.ts)
 *   - tsconfig paths aliases (@/* → src/*)
 *
 * Bare package imports (react, zod, node:fs) resolve to null (no file edge).
 */

/** Extensions to try when resolving an import specifier. */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

/** Extension mappings: .js in source may refer to .ts on disk (TypeScript convention). */
const EXTENSION_MAP: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

/** Index filenames to try for directory imports. */
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"];

export interface ResolverConfig {
  /** tsconfig paths aliases, e.g. { "@/*": "src/*" } */
  pathAliases?: Record<string, string>;
}

/**
 * Build a file index for O(1) path lookups.
 * Keys are the normalized relativePaths of all files in the project.
 */
export function buildFileIndex(relativePaths: string[]): Set<string> {
  return new Set(relativePaths);
}

/**
 * Resolve an import specifier to an actual file path.
 *
 * @param source - The import specifier (e.g., "./utils", "../core/types.js", "@/lib/foo")
 * @param importerPath - The relativePath of the file doing the importing
 * @param fileIndex - Set of all known file relativePaths
 * @param config - Optional resolver config (path aliases)
 * @returns The resolved relativePath, or null if unresolvable (bare package, not found)
 */
export function resolveImportSource(
  source: string,
  importerPath: string,
  fileIndex: Set<string>,
  config?: ResolverConfig,
): string | null {
  // Normalize Windows backslashes in the importer path
  const normalizedImporter = importerPath.replace(/\\/g, "/");

  // Bare package imports — no file edge
  if (isBarePackage(source)) return null;

  // Path alias resolution (@/* → src/*)
  if (config?.pathAliases) {
    const aliased = resolveAlias(source, config.pathAliases);
    if (aliased) {
      return resolveRelativeSource(aliased, "", fileIndex);
    }
  }

  // Relative imports
  if (source.startsWith(".")) {
    return resolveRelativeSource(source, normalizedImporter, fileIndex);
  }

  // Unresolvable (unknown alias, protocol imports, etc.)
  return null;
}

/**
 * Check if a source is a bare package import (no file edge).
 * Bare packages: "react", "zod", "@supabase/supabase-js", "node:fs"
 * NOT bare: "./utils", "../core", "@/lib/foo" (path alias)
 */
function isBarePackage(source: string): boolean {
  // Protocol imports (node:, bun:, etc.)
  if (source.includes(":")) return true;
  // Relative imports
  if (source.startsWith(".")) return false;
  // Path aliases configured in tsconfig (handled separately)
  if (source.startsWith("@/") || source.startsWith("~/")) return false;
  // Scoped packages (@org/pkg)
  if (source.startsWith("@") && source.includes("/")) return true;
  // Regular bare packages
  if (!source.startsWith(".") && !source.startsWith("/")) return true;
  return false;
}

/**
 * Resolve a path alias like @/lib/foo → src/lib/foo
 */
function resolveAlias(source: string, aliases: Record<string, string>): string | null {
  for (const [pattern, replacement] of Object.entries(aliases)) {
    const prefix = pattern.replace("*", "");
    if (source.startsWith(prefix)) {
      const rest = source.slice(prefix.length);
      const resolved = replacement.replace("*", "") + rest;
      return "./" + resolved;
    }
  }
  return null;
}

/**
 * Resolve a relative import source to a file path.
 * Tries exact match, extension mapping, and index file resolution.
 */
function resolveRelativeSource(
  source: string,
  importerPath: string,
  fileIndex: Set<string>,
): string | null {
  // Compute the target path relative to the project root
  const importerDir = directoryOf(importerPath);
  const targetBase = normalizePath(joinPath(importerDir, source));

  // 1. If source has an extension, try extension mapping
  const ext = getExtension(source);
  if (ext && EXTENSION_MAP[ext]) {
    const withoutExt = targetBase.slice(0, -ext.length);
    for (const tryExt of EXTENSION_MAP[ext]) {
      const candidate = withoutExt + tryExt;
      if (fileIndex.has(candidate)) return candidate;
    }
    // Also try exact match
    if (fileIndex.has(targetBase)) return targetBase;
  }

  // 2. Exact match (already has extension or unusual extension)
  if (fileIndex.has(targetBase)) return targetBase;

  // 3. Try adding extensions (extensionless import)
  if (!ext) {
    for (const tryExt of RESOLVE_EXTENSIONS) {
      const candidate = targetBase + tryExt;
      if (fileIndex.has(candidate)) return candidate;
    }
  }

  // 4. Directory import → try index files
  for (const indexFile of INDEX_FILES) {
    const candidate = targetBase + "/" + indexFile;
    if (fileIndex.has(candidate)) return candidate;
  }

  // 5. If source had extension, also try directory import with that base
  if (ext) {
    const withoutExt = targetBase.slice(0, -ext.length);
    for (const indexFile of INDEX_FILES) {
      const candidate = withoutExt + "/" + indexFile;
      if (fileIndex.has(candidate)) return candidate;
    }
  }

  return null;
}

/** Get file extension including the dot, or empty string. */
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  const lastSlash = filePath.lastIndexOf("/");
  if (lastDot <= lastSlash) return "";
  return filePath.slice(lastDot);
}

/** Get directory portion of a path. "src/cli/scan.ts" → "src/cli" */
function directoryOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}

/** Simple path join that handles ".." and "." */
function joinPath(base: string, relative: string): string {
  if (!base) return relative;
  const parts = base.split("/").concat(relative.split("/"));
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

/** Remove leading ./ if present */
function normalizePath(path: string): string {
  if (path.startsWith("./")) return path.slice(2);
  return path;
}
