/**
 * JS/TS bipartite import graph.
 *
 * Builds two maps from a project's source files:
 *   exportsByFile  — Map<file, FileExport[]>   (what each file exports)
 *   importsByFile  — Map<file, {names, sources}>  (what each file imports + from where)
 *
 * Plus a derived `incomingCount` map: how many other files import from
 * each file.
 *
 * Used by:
 *   - src/analyzers/dead-code.ts   — orphan-file + unused-export detection
 *   - src/drift/phantom-scaffolding.ts — unrouted-handler detection
 *
 * Resolution:
 *   - Primary: AST-based extraction (tree-sitter) + real relative-path resolution
 *     with extension mapping (.js→.ts) and configurable path aliases (defaults to @/* → src/*).
 *   - Fallback: regex-based extraction + basename matching for files without a
 *     parsed tree or specifiers that cannot be resolved. The basename fallback
 *     may over-match in rare cases (two unrelated files named the same).
 *   - "index.ts" files are referenced by their parent directory name (in fallback).
 */

import type { SourceFile } from "./types.js";
import { parseImportsAst, parseExportsAst } from "./import-graph-ast.js";
import { resolveImportSource, buildFileIndex, type ResolverConfig } from "./import-resolver.js";

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

// A leading `(?:type\s+)?` makes TypeScript type-only imports parse like their
// value counterparts: `import type { Foo } from './x'` and
// `import type Foo from './x'` capture the same names + source as the non-type
// forms. Per-specifier `type` prefixes inside `{ type Foo, Bar }` are stripped
// in parseImports.
const IMPORT_PATTERNS = [
  /import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
  /import\s+(?:type\s+)?(\w+)\s+from\s*['"]([^'"]+)['"]/g,
  /import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g,
  /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Dynamic imports: const { X } = await import("./module.js")
  // and namespace form: const ns = await import("./module.js")
  /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g,
  /(?:const|let|var)\s+(\w+)\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// Re-export edges: a barrel file's `export { X } from './y'` / `export * from
// './y'` / `export * as ns from './y'` makes './y' reachable through the barrel.
// We treat the re-export SOURCE as an import source so the re-exported file gets
// an incoming edge (and is no longer counted as phantom). Only the source path
// is captured here — the re-exported names are surfaced by parseExports on the
// barrel's own exports, so we don't add names to avoid double-handling.
const REEXPORT_SOURCE_PATTERNS = [
  /export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g,
  /export\s*\*\s*(?:as\s+\w+\s+)?from\s*['"]([^'"]+)['"]/g,
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
        // Single-name export, e.g. `export { foo } from './x'` — trim and drop
        // any `as` alias, matching the comma-branch above. Without this the name
        // keeps its surrounding whitespace (" foo ") and never matches a trimmed
        // imported name, so a barrel re-export gets falsely flagged dead.
        const trimmed = captured.trim().split(/\s+as\s+/)[0].trim();
        if (trimmed) exports.push({ name: trimmed, file: file.relativePath, line, isDefault: false });
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
          // Drop a per-specifier `type ` modifier (`{ type Foo, Bar }`) and any
          // `as` alias, then strip stray braces.
          const trimmed = n
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]
            .trim()
            .replace(/[{}]/g, "");
          if (trimmed) names.add(trimmed);
        }
      } else {
        names.add(raw.trim());
      }
    }
  }

  // Register re-export sources as incoming edges to the re-exported file.
  for (const pattern of REEXPORT_SOURCE_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const source = match[1];
      if (source) sources.add(source);
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
  const file = filePath.split(/[/\\]/).pop() ?? filePath;
  const noExt = file.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  if (noExt === "index") {
    const parts = filePath.split(/[/\\]/);
    return parts.length >= 2 ? parts[parts.length - 2] : noExt;
  }
  return noExt;
}

/**
 * Build the full bipartite import graph for a project's JS/TS files.
 * Pass already-filtered files (typically ctx.files filtered to JS/TS).
 *
 * Uses AST-based parsing when file.tree is available (tree-sitter), falling
 * back to regex for files without a parsed tree. Resolution uses real relative
 * path resolution with extension mapping, falling back to basename matching
 * for unresolvable specifiers.
 */
export function buildImportGraph(files: SourceFile[], config?: ResolverConfig): ImportGraph {
  const exportsByFile = new Map<string, FileExport[]>();
  const importsByFile = new Map<string, FileImports>();

  for (const file of files) {
    if (file.tree) {
      exportsByFile.set(file.relativePath, parseExportsAst(file.tree, file.relativePath));
      importsByFile.set(file.relativePath, parseImportsAst(file.tree));
    } else {
      exportsByFile.set(file.relativePath, parseExports(file));
      importsByFile.set(file.relativePath, parseImports(file));
    }
  }

  // Build file index for real path resolution
  const fileIndex = buildFileIndex(files.map((f) => f.relativePath));

  // Resolver config: path aliases (caller-supplied or default @/* → src/*)
  const resolverConfig: ResolverConfig = config ?? {
    pathAliases: { "@/*": "src/*" },
  };

  // Fallback: index files by their basename lookup-key (used when resolution fails)
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
      // Try real resolution first
      const resolved = resolveImportSource(source, importer, fileIndex, resolverConfig);
      if (resolved) {
        if (resolved === importer) continue;
        if (seenTargets.has(resolved)) continue;
        seenTargets.add(resolved);
        incomingCount.set(resolved, (incomingCount.get(resolved) ?? 0) + 1);
        continue;
      }

      // Fallback to basename matching for unresolvable specifiers
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
