import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding, SourceFile } from "../core/types.js";
import { parseImportsAst } from "../core/import-graph-ast.js";

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "console", "constants",
  "crypto", "dgram", "dns", "domain", "events", "fs", "http", "http2",
  "https", "module", "net", "os", "path", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "stream", "string_decoder",
  "sys", "timers", "tls", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

const JS_IMPORT_PATTERNS = [
  /(?:import|from)\s+['"]([^./][^'"]*)['"]/g,
  /require\(\s*['"]([^./][^'"]*)['"]\s*\)/g,
  // Dynamic imports: await import("pkg") or import("pkg")
  /import\(\s*['"]([^./][^'"]*)['"]\s*\)/g,
];

// Test fixture directories — their imports are intentionally broken/nonexistent
const FIXTURE_PATH_PATTERN = /(?:fixtures?|testdata|__fixtures__|__mocks__)[/\\]/i;

// Build/config files reference dependencies in ways the import patterns miss:
// require.resolve('buffer/'), loader: 'ts-loader', plugin string names, etc.
// Match common bundler/tooling config filenames anywhere in the tree.
const BUILD_CONFIG_PATTERN =
  /(?:^|[/\\])(?:webpack|vite|rollup|esbuild|tsup|babel|jest|vitest|tailwind|postcss|rspack|metro|next|nuxt|svelte|astro|gulpfile|gruntfile|karma|playwright|cypress)\.config\.[cm]?[jt]sx?$/i;

// require.resolve("pkg") / require.resolve('pkg/sub') — used in bundler fallbacks
const REQUIRE_RESOLVE_PATTERN = /require\.resolve\(\s*['"]([^'"]+)['"]\s*\)/g;

// We extract Go imports by finding import blocks, not raw string matching
function extractGoImports(content: string): string[] {
  const imports: string[] = [];

  // Single import: import "path"
  const singlePattern = /^import\s+"([^"]+)"/gm;
  let m;
  while ((m = singlePattern.exec(content)) !== null) {
    imports.push(m[1]);
  }

  // Block import: import ( ... )
  const blockPattern = /^import\s*\(([\s\S]*?)\)/gm;
  while ((m = blockPattern.exec(content)) !== null) {
    const block = m[1];
    const linePattern = /^\s*(?:\w+\s+)?"([^"]+)"/gm;
    let lineMatch;
    while ((lineMatch = linePattern.exec(block)) !== null) {
      imports.push(lineMatch[1]);
    }
  }

  return imports;
}
const PYTHON_IMPORT_PATTERN = /^(?:import|from)\s+(\w+)/gm;
const RUST_USE_PATTERN = /^use\s+(\w+)/gm;

function extractJsPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

const DEV_TOOL_PATTERNS = [
  "@types/", "eslint", "prettier", "tsup", "vitest", "typescript",
  "jest", "mocha", "webpack", "rollup", "vite", "babel", "postcss",
  "tailwindcss", "autoprefixer", "lint-staged", "husky",
];

export const dependenciesAnalyzer: Analyzer = {
  id: "dependencies",
  name: "Dependency Health",
  category: "dependencyHealth",
  requiresAST: false,
  applicableLanguages: "all",
  // v2: credit deps referenced only in build/config files (require.resolve,
  // loader/plugin strings) so they aren't flagged as phantom.
  version: 2,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    // JS/TS dependency analysis
    if (ctx.packageJson) {
      findings.push(...analyzeJsDeps(ctx));
    }

    // Go dependency analysis
    if (ctx.goMod) {
      findings.push(...analyzeGoDeps(ctx));
    }

    // Python dependency analysis
    if (ctx.requirementsTxt) {
      findings.push(...analyzePythonDeps(ctx));
    }

    // Rust dependency analysis
    if (ctx.cargoToml) {
      findings.push(...analyzeRustDeps(ctx));
    }

    return findings;
  },
};

function collectImportedPackages(
  files: SourceFile[],
): { imported: Set<string>; importLocations: Map<string, { file: string; line: number }[]> } {
  const imported = new Set<string>();
  const importLocations = new Map<string, { file: string; line: number }[]>();

  for (const file of files) {
    // Use AST when available — immune to matching inside comments/strings
    if (file.tree) {
      const { sources } = parseImportsAst(file.tree);
      for (const source of sources) {
        // Only care about bare package imports (not relative ./.. paths)
        if (source.startsWith(".") || source.startsWith("/")) continue;
        const pkg = extractJsPackageName(source);
        if (NODE_BUILTINS.has(pkg) || pkg.startsWith("node:") || pkg.startsWith("@/") || pkg.startsWith("~")) continue;
        imported.add(pkg);
        // AST doesn't give us line numbers for sources cheaply, so omit location
        if (!importLocations.has(pkg)) importLocations.set(pkg, []);
      }
    } else {
      // Fallback to regex for files without a parsed tree
      for (const pattern of JS_IMPORT_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(file.content)) !== null) {
          const pkg = extractJsPackageName(match[1]);
          if (NODE_BUILTINS.has(pkg) || pkg.startsWith("node:") || pkg.startsWith("@/") || pkg.startsWith("~")) continue;
          imported.add(pkg);
          if (!importLocations.has(pkg)) importLocations.set(pkg, []);
          importLocations.get(pkg)!.push({
            file: file.relativePath,
            line: file.content.slice(0, match.index).split("\n").length,
          });
        }
      }
    }
  }

  return { imported, importLocations };
}

// Collect packages referenced in build/config files in ways the import
// patterns don't catch: require.resolve("pkg/...") and bare quoted package
// names (loader: "ts-loader", plugin strings). We only credit a declared dep
// if its exact name appears as a quoted string, to stay precise.
function collectConfigReferencedPackages(
  configFiles: { content: string }[],
  declared: Set<string>,
): Set<string> {
  const referenced = new Set<string>();

  for (const file of configFiles) {
    // require.resolve('buffer/') -> "buffer"
    const reResolve = new RegExp(REQUIRE_RESOLVE_PATTERN.source, REQUIRE_RESOLVE_PATTERN.flags);
    let m;
    while ((m = reResolve.exec(file.content)) !== null) {
      referenced.add(extractJsPackageName(m[1]));
    }

    // Any declared dep that appears as a bare quoted string (loader/plugin names)
    const quoted = /['"]([^'"]+)['"]/g;
    let q;
    while ((q = quoted.exec(file.content)) !== null) {
      const pkg = extractJsPackageName(q[1]);
      if (declared.has(pkg)) referenced.add(pkg);
    }
  }

  return referenced;
}

function detectPhantomDeps(declared: Set<string>, imported: Set<string>, devToolPatterns: string[]): Finding[] {
  const phantom = [...declared].filter((d) => !imported.has(d));
  const realPhantom = phantom.filter(
    (p) => !devToolPatterns.some((pat) => p.includes(pat)),
  );

  if (realPhantom.length > 0) {
    return [{
      analyzerId: "dependencies",
      severity: realPhantom.length > 5 ? "error" : "warning",
      confidence: 0.75,
      message: `${realPhantom.length} phantom dependencies (declared but unused): ${realPhantom.slice(0, 5).join(", ")}${realPhantom.length > 5 ? "..." : ""}`,
      locations: realPhantom.map((p) => ({ file: "package.json" })),
      tags: ["deps", "phantom", "js"],
    }];
  }

  return [];
}

// Filter out common bundler aliases, virtual modules, and workspace-internal packages
const ALIAS_PATTERNS = [
  /^#/, /^virtual:/, /^vite\//, /^next\//,
  /^\$/, /^server-only$/, /^client-only$/,
];

function detectMissingDeps(
  declared: Set<string>,
  imported: Set<string>,
  isMonorepo: boolean,
  importLocations: Map<string, { file: string; line: number }[]>,
): Finding[] {
  const missing = [...imported].filter((i) => {
    if (declared.has(i)) return false;
    if (ALIAS_PATTERNS.some((p) => p.test(i))) return false;
    return true;
  });

  // In monorepos/workspaces, missing deps are likely workspace packages — lower severity
  const missingConfidence = isMonorepo ? 0.4 : 0.75;
  const missingSeverity = isMonorepo ? "warning" as const : "error" as const;

  if (missing.length > 0) {
    return [{
      analyzerId: "dependencies",
      severity: missingSeverity,
      confidence: missingConfidence,
      message: `${missing.length} packages imported but not in package.json: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}${isMonorepo ? " (may be workspace packages)" : ""}`,
      locations: missing.slice(0, 5).flatMap((p) => importLocations.get(p) ?? []),
      tags: ["deps", "missing", "js"],
    }];
  }

  return [];
}

function analyzeJsDeps(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const pkg = ctx.packageJson!;

  // Include optionalDependencies and detect workspace packages
  const declared = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys((pkg as any).optionalDependencies ?? {}),
  ]);

  // Self-references (importing your own package name) are not missing deps
  if (pkg.name) declared.add(pkg.name);

  // Detect monorepo workspace packages (workspace:* protocol, or packages
  // whose versions are "workspace:*", "workspace:^", "workspace:~", "*")
  const isMonorepo = [...Object.values(pkg.dependencies ?? {}),
    ...Object.values(pkg.devDependencies ?? {})].some(
    (v) => typeof v === "string" && (v.startsWith("workspace:") || v === "*"),
  );
  // Also check for workspaces field
  const hasWorkspaces = !!(pkg as any).workspaces;

  const jsFiles = ctx.files.filter(
    (f) =>
      (f.language === "javascript" || f.language === "typescript") &&
      !FIXTURE_PATH_PATTERN.test(f.relativePath),
  );

  const { imported, importLocations } = collectImportedPackages(jsFiles);

  // Credit deps referenced only in build/config files (require.resolve, loader
  // strings, plugin names) so they aren't flagged as phantom. This only relaxes
  // phantom detection — it does not affect "missing dep" detection.
  const configFiles = ctx.files.filter((f) => BUILD_CONFIG_PATTERN.test(f.relativePath));
  const configReferenced = collectConfigReferencedPackages(configFiles, declared);
  const usedForPhantom = new Set<string>([...imported, ...configReferenced]);

  findings.push(...detectPhantomDeps(declared, usedForPhantom, DEV_TOOL_PATTERNS));
  findings.push(...detectMissingDeps(declared, imported, isMonorepo || hasWorkspaces, importLocations));

  return findings;
}

function analyzeGoDeps(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const goMod = ctx.goMod!;
  const declaredPaths = new Set(goMod.require.map((r) => r.path));

  const importedPaths = new Set<string>();
  const goFiles = ctx.files.filter((f) => f.language === "go");

  for (const file of goFiles) {
    const goImports = extractGoImports(file.content);
    for (const importPath of goImports) {
      // Skip stdlib (no dots in first segment)
      if (!importPath.includes(".")) continue;
      // Skip URLs
      if (importPath.startsWith("http://") || importPath.startsWith("https://")) continue;
      // Skip internal module imports
      if (importPath.startsWith(goMod.module)) continue;
      // Extract module path (first 3 segments for github.com/x/y style)
      const segments = importPath.split("/");
      const modPath = segments.length >= 3 ? segments.slice(0, 3).join("/") : importPath;
      importedPaths.add(modPath);
    }
  }

  const phantom = [...declaredPaths].filter((d) => !importedPaths.has(d));
  if (phantom.length > 0) {
    findings.push({
      analyzerId: "dependencies",
      severity: "warning",
      confidence: 0.7,
      message: `${phantom.length} potentially unused Go modules: ${phantom.slice(0, 3).join(", ")}${phantom.length > 3 ? "..." : ""}`,
      locations: [{ file: "go.mod" }],
      tags: ["deps", "phantom", "go"],
    });
  }

  const missing = [...importedPaths].filter((i) => !declaredPaths.has(i));
  if (missing.length > 0) {
    findings.push({
      analyzerId: "dependencies",
      severity: "error",
      confidence: 0.8,
      message: `${missing.length} Go imports not in go.mod: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "..." : ""}`,
      locations: [{ file: "go.mod" }],
      tags: ["deps", "missing", "go"],
    });
  }

  return findings;
}

function analyzePythonDeps(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const declared = new Set(ctx.requirementsTxt!);

  const imported = new Set<string>();
  const pyFiles = ctx.files.filter((f) => f.language === "python");

  const PYTHON_STDLIB = new Set([
    "os", "sys", "re", "json", "math", "datetime", "collections", "itertools",
    "functools", "pathlib", "typing", "abc", "io", "time", "logging", "copy",
    "hashlib", "base64", "subprocess", "threading", "multiprocessing", "socket",
    "http", "urllib", "email", "html", "xml", "csv", "sqlite3", "unittest",
    "argparse", "configparser", "dataclasses", "enum", "contextlib", "inspect",
    "asyncio", "concurrent", "signal", "shutil", "glob", "tempfile", "pickle",
    "struct", "textwrap", "string", "operator", "warnings",
  ]);

  for (const file of pyFiles) {
    const regex = new RegExp(PYTHON_IMPORT_PATTERN.source, PYTHON_IMPORT_PATTERN.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const mod = match[1].toLowerCase();
      if (PYTHON_STDLIB.has(mod)) continue;
      imported.add(mod);
    }
  }

  const phantom = [...declared].filter((d) => !imported.has(d));
  if (phantom.length > 2) {
    findings.push({
      analyzerId: "dependencies",
      severity: "warning",
      confidence: 0.65,
      message: `${phantom.length} potentially unused Python packages: ${phantom.slice(0, 5).join(", ")}`,
      locations: [{ file: "requirements.txt" }],
      tags: ["deps", "phantom", "python"],
    });
  }

  return findings;
}

function analyzeRustDeps(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const declared = new Set(Object.keys(ctx.cargoToml!.dependencies));

  const imported = new Set<string>();
  const rsFiles = ctx.files.filter((f) => f.language === "rust");

  for (const file of rsFiles) {
    const regex = new RegExp(RUST_USE_PATTERN.source, RUST_USE_PATTERN.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const crateName = match[1];
      if (["std", "core", "alloc", "self", "super", "crate"].includes(crateName)) continue;
      imported.add(crateName);
    }
  }

  const phantom = [...declared].filter(
    (d) => !imported.has(d) && !imported.has(d.replace(/-/g, "_")),
  );
  if (phantom.length > 0) {
    findings.push({
      analyzerId: "dependencies",
      severity: "warning",
      confidence: 0.7,
      message: `${phantom.length} potentially unused Rust crates: ${phantom.slice(0, 5).join(", ")}`,
      locations: [{ file: "Cargo.toml" }],
      tags: ["deps", "phantom", "rust"],
    });
  }

  return findings;
}
