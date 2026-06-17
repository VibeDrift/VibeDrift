/**
 * JS/TS bipartite import graph.
 *
 * Builds two maps from a project's source files:
 *   exportsByFile  — Map<file, FileExport[]>   (what each file exports)
 *   importsByFile  — Map<file, {names, sources}>  (what each file imports + from where)
 *
 * Plus a derived `incomingCount` map: how many other files import from
 * each file (basename-resolved, since we don't run real module resolution).
 *
 * Used by:
 *   - src/analyzers/dead-code.ts   — orphan-file + unused-export detection
 *   - src/drift/phantom-scaffolding.ts — unrouted-handler detection
 *
 * Limitations:
 *   - Path resolution is basename-only (no tsconfig paths, no actual fs).
 *     "./utils" matches any file whose basename-without-ext is "utils".
 *     "@/lib/foo" matches any file whose basename-without-ext is "foo".
 *     This over-matches in rare cases (two unrelated files named the same)
 *     but is correct for typical real-world projects.
 *   - "index.ts" files are referenced by their parent directory name.
 */

import type { SourceFile } from "./types.js";

export interface FileExport {
  name: string;
  file: string;          // relative path
  line: number;
  isDefault: boolean;
}

export interface FileImports {
  names: Set<string>;     // imported symbol names
  sources: Set<string>;   // raw import source paths (e.g. "./utils", "@/lib/foo")
}

export interface ImportGraph {
  exportsByFile: Map<string, FileExport[]>;
  importsByFile: Map<string, FileImports>;
  /** How many distinct files import (any symbol) from this file. */
  incomingCount: Map<string, number>;
}

const EXPORT_NAMED_PATTERNS = [
  /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g,
  /export\s*\{([^}]+)\}/g,
];
const EXPORT_DEFAULT_PATTERN = /export\s+default\s+(?:(?:async\s+)?(?:function|class)\s+(\w+)|(\w+))/g;

const IMPORT_PATTERNS = [
  /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
  /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g,
  /import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g,
  /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function parseExports(file: SourceFile): FileExport[] {
  const exports: FileExport[] = [];

  for (const pattern of EXPORT_NAMED_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const captured = match[1];
      const line = file.content.slice(0, match.index).split("\n").length;
      if (captured.includes(",")) {
        for (const name of captured.split(",")) {
          const trimmed = name.trim().split(/\s+as\s+/)[0].trim();
          if (trimmed) exports.push({ name: trimmed, file: file.relativePath, line, isDefault: false });
        }
      } else {
        exports.push({ name: captured, file: file.relativePath, line, isDefault: false });
      }
    }
  }

  const defaultRegex = new RegExp(EXPORT_DEFAULT_PATTERN.source, EXPORT_DEFAULT_PATTERN.flags);
  let match;
  while ((match = defaultRegex.exec(file.content)) !== null) {
    const name = match[1] || match[2];
    if (name) {
      const line = file.content.slice(0, match.index).split("\n").length;
      exports.push({ name, file: file.relativePath, line, isDefault: true });
    }
  }

  return exports;
}

export function parseImports(file: SourceFile): FileImports {
  const names = new Set<string>();
  const sources = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const raw = match[1];
      const source = match[2];
      sources.add(source);
      if (raw.includes(",") || raw.includes("{")) {
        for (const n of raw.split(",")) {
          const trimmed = n.trim().split(/\s+as\s+/)[0].trim().replace(/[{}]/g, "");
          if (trimmed) names.add(trimmed);
        }
      } else {
        names.add(raw.trim());
      }
    }
  }

  return { names, sources };
}

/** "./utils" → "utils", "./utils/index" → "utils", "@/lib/foo" → "foo". */
export function sourceLookupKey(source: string): string {
  const noExt = source.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  const parts = noExt.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? noExt;
  if (last === "index" && parts.length >= 2) return parts[parts.length - 2];
  return last;
}

/** Lookup key derived from a file's path, used to match against import sources. */
export function fileBasename(filePath: string): string {
  const file = filePath.split("/").pop() ?? filePath;
  const noExt = file.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  if (noExt === "index") {
    const parts = filePath.split("/");
    return parts.length >= 2 ? parts[parts.length - 2] : noExt;
  }
  return noExt;
}

/**
 * Build the full bipartite import graph for a project's JS/TS files.
 * Pass already-filtered files (typically ctx.files filtered to JS/TS).
 */
export function buildImportGraph(files: SourceFile[]): ImportGraph {
  const exportsByFile = new Map<string, FileExport[]>();
  const importsByFile = new Map<string, FileImports>();

  for (const file of files) {
    exportsByFile.set(file.relativePath, parseExports(file));
    importsByFile.set(file.relativePath, parseImports(file));
  }

  // Index files by their basename lookup-key for source resolution
  const fileByBase = new Map<string, string[]>();
  for (const file of files) {
    const base = fileBasename(file.relativePath);
    const list = fileByBase.get(base);
    if (list) list.push(file.relativePath);
    else fileByBase.set(base, [file.relativePath]);
  }

  // Compute incoming-edge count per file
  const incomingCount = new Map<string, number>();
  for (const file of files) incomingCount.set(file.relativePath, 0);

  for (const [importer, { sources }] of importsByFile) {
    const seenTargets = new Set<string>();
    for (const source of sources) {
      const key = sourceLookupKey(source);
      const candidates = fileByBase.get(key);
      if (!candidates) continue;
      for (const c of candidates) {
        if (c === importer) continue;
        if (seenTargets.has(c)) continue;
        seenTargets.add(c);
        incomingCount.set(c, (incomingCount.get(c) ?? 0) + 1);
      }
    }
  }

  return { exportsByFile, importsByFile, incomingCount };
}
