/**
 * Import style consistency (ESM vs CJS).
 *
 * Historical version flagged any mix of ESM and CommonJS. That produced
 * false positives on legitimate Node projects that use `require('fs')` for
 * built-ins alongside ESM app imports. This version is context-aware:
 *   - `require('fs')`, `require('path')`, etc. (Node built-ins) — NOT drift
 *   - `require('./utils')` (first-party / relative) — IS drift in an ESM file
 *   - `require('lodash')` (non-builtin npm package) — IS drift in an ESM file
 *   - `require('node:stream')` (explicit node: scheme) — NOT drift
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding } from "../core/types.js";

const ESM_PATTERN = /\b(?:import\s+|export\s+(?:default\s+)?(?:function|class|const|let|var|{))/;

// CJS write markers — require an assignment context so we don't match
// `exports.push(...)` on a file-local variable named `exports`, nor comment
// text mentioning `module.exports` as explanation.
const CJS_WRITE_PATTERN = /\bmodule\.exports(?:\.\w+)?\s*=(?!=)|\bexports\.\w+\s*=(?!=)/;
// CJS require — must be in an assignment context (`const x = require(...)` or
// a bare statement at line start). Prevents matching `require(` in comments
// and inline docs.
const CJS_REQUIRE_PATTERN = /(?:\b(?:const|let|var)\s+[\w$]+\s*=\s*|^\s*)\brequire\s*\(\s*['"]([^'"]+)['"]/gm;

// Node built-ins whose `require()` is idiomatic even in ESM projects.
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
  "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
]);

const CONFIG_FILE_PATTERN = /(?:\.config\.|\.setup\.|\.rc\.|jest\.|babel\.|webpack\.|rollup\.|vite\.|next\.config|tailwind\.config|postcss\.config|tsconfig|eslint\.config|prettier\.config|svelte\.config|nuxt\.config|astro\.config|vitest\.config|tsup\.config|esbuild\.config|turbo\.json|\.cjs$|\.mjs$)/;

function isBuiltinRequire(modulePath: string): boolean {
  if (modulePath.startsWith("node:")) return true;
  // Strip subpath: "fs/promises" → "fs"
  const root = modulePath.split("/")[0];
  return NODE_BUILTINS.has(root);
}

/**
 * Does this file have "real" CJS — module.exports or a require() of something
 * that isn't a Node built-in? Returns true iff flagging this file as CJS drift
 * makes sense in an otherwise-ESM codebase.
 */
function hasDriftyCjs(content: string): boolean {
  if (CJS_WRITE_PATTERN.test(content)) return true;
  const regex = new RegExp(CJS_REQUIRE_PATTERN.source, CJS_REQUIRE_PATTERN.flags);
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (!isBuiltinRequire(match[1])) return true;
  }
  return false;
}

export const importsAnalyzer: Analyzer = {
  id: "imports",
  name: "Import Patterns",
  category: "architecturalConsistency",
  requiresAST: false,
  applicableLanguages: ["javascript", "typescript"],
  // Bumped when detection changes — invalidates the S1 findings cache.
  version: 2,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const jsFiles = ctx.files.filter(
      (f) => f.language === "javascript" || f.language === "typescript",
    );

    const esmFiles: string[] = [];
    const cjsFiles: string[] = [];

    const SKIP_PATH = /(?:fixtures?|testdata|__fixtures__|__mocks__)[/\\]/i;

    for (const file of jsFiles) {
      if (CONFIG_FILE_PATTERN.test(file.relativePath)) continue;
      if (SKIP_PATH.test(file.relativePath)) continue;

      // Strip comments, template literals, and regex literals so analyzer
      // files (which mention CJS patterns in JSDoc or as regex source)
      // don't get flagged. Keep regular string literals intact — we need
      // the require() argument to classify the module path.
      const stripped = file.content
        .replace(/\/\*[\s\S]*?\*\//g, "")          // block comments
        .replace(/\/\/[^\n]*/g, "")                 // line comments
        .replace(/`[^`]*`/g, '""')                  // template literals
        .replace(/\/[^/\n]+\/[gimsuvy]*/g, '""');   // regex literals

      const hasESM = ESM_PATTERN.test(file.content);
      const hasCJS = hasDriftyCjs(stripped);

      if (hasESM && hasCJS) {
        findings.push({
          analyzerId: "imports",
          severity: "warning",
          confidence: 0.9,
          message: `Mixed ESM and non-builtin CommonJS in ${file.relativePath}`,
          locations: [{ file: file.relativePath }],
          tags: ["imports", "mixed"],
        });
      }

      if (hasESM) esmFiles.push(file.relativePath);
      if (hasCJS) cjsFiles.push(file.relativePath);
    }

    if (esmFiles.length > 0 && cjsFiles.length > 0) {
      const minorityFiles = esmFiles.length >= cjsFiles.length ? cjsFiles : esmFiles;
      findings.push({
        analyzerId: "imports",
        severity: "warning",
        confidence: 0.85,
        message: `Mixed ESM/CommonJS across project: ${esmFiles.length} ESM files, ${cjsFiles.length} CJS files`,
        locations: minorityFiles.slice(0, 10).map((f) => ({ file: f })),
        tags: ["imports", "project-inconsistency"],
      });
    }

    return findings;
  },
};
