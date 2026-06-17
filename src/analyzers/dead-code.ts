/**
 * Dead-code detector — v2 with a real import graph.
 *
 * Old behavior: "does this export name appear ≥ 2 times in the joined
 * content of every file?" That missed real patterns (files never imported
 * anywhere) and produced false positives (a substring match inside a
 * longer identifier counted as usage).
 *
 * v2 builds a bipartite import graph:
 *   - exports[file] = Set<symbol>   (parsed per file)
 *   - imports[file] = Set<symbol>   (parsed per file, from any source)
 *   - importSources[file] = Set<targetFileBasename>
 *
 * From that we derive:
 *   - Symbol-level dead code: an export name that no file imports.
 *   - File-level dead code (Sami's addition): a file with zero incoming
 *     imports, excluding entry points, tests, type-decls, and configs.
 *
 * Go and Python stay on the simpler substring method — their module
 * systems don't have JS-style relative imports with paths to resolve.
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding, SourceFile } from "../core/types.js";
import { buildImportGraph, type FileExport } from "../core/import-graph.js";

const ENTRY_POINT_BASES = new Set([
  "index", "main", "app", "server", "mod", "lib", "init", "__init__",
  "setup", "config", "routes", "handler", "handlers", "cli",
]);

const ENTRY_POINT_PATTERNS = [
  /\.config\.(?:ts|js|mjs|cjs)$/i,
  /\.d\.ts$/i,
  /(?:^|\/)(?:test|tests|spec|__tests__|__test__|__mocks__|fixtures?|e2e)\//i,
  /\.(?:test|spec|stories)\.(?:ts|tsx|js|jsx)$/i,
];

function isEntryFile(filePath: string): boolean {
  const base = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  if (ENTRY_POINT_BASES.has(base)) return true;
  return ENTRY_POINT_PATTERNS.some((p) => p.test(filePath));
}

// ─── JS/TS dead-code analysis (delegates to shared import-graph) ─────

interface JsAnalysis {
  deadExports: FileExport[];
  deadFiles: { file: string; reason: string }[];
}

function analyzeJsGraph(files: SourceFile[]): JsAnalysis {
  const graph = buildImportGraph(files);

  // Symbol-level reachability: union of all imported names across the project.
  const allImportedNames = new Set<string>();
  for (const { names } of graph.importsByFile.values()) {
    for (const n of names) allImportedNames.add(n);
  }

  const deadExports: FileExport[] = [];
  for (const exports of graph.exportsByFile.values()) {
    for (const ex of exports) {
      if (!allImportedNames.has(ex.name)) deadExports.push(ex);
    }
  }

  // File-level: zero incoming imports (excluding entry files).
  const deadFiles: { file: string; reason: string }[] = [];
  for (const file of files) {
    if (isEntryFile(file.relativePath)) continue;
    const count = graph.incomingCount.get(file.relativePath) ?? 0;
    if (count === 0) {
      deadFiles.push({ file: file.relativePath, reason: "zero incoming imports" });
    }
  }

  return { deadExports, deadFiles };
}

// ─── Top-level analyzer ───────────────────────────────────────────────

export const deadCodeAnalyzer: Analyzer = {
  id: "dead-code",
  name: "Dead Code Detection",
  category: "redundancy",
  requiresAST: false,
  applicableLanguages: "all",
  version: 3,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    const jsFiles = ctx.files.filter(
      (f) => f.language === "javascript" || f.language === "typescript",
    );
    const goFiles = ctx.files.filter((f) => f.language === "go");
    const pyFiles = ctx.files.filter((f) => f.language === "python");

    if (jsFiles.length > 0) {
      const { deadExports, deadFiles } = analyzeJsGraph(jsFiles);

      if (deadExports.length > 3) {
        findings.push({
          analyzerId: "dead-code",
          severity: deadExports.length > 10 ? "error" : "warning",
          confidence: 0.8,
          message: `${deadExports.length} exported symbols appear unused: ${deadExports.slice(0, 5).map((e) => e.name).join(", ")}${deadExports.length > 5 ? "..." : ""}`,
          locations: deadExports.slice(0, 15).map((e) => ({
            file: e.file,
            line: e.line,
            snippet: `export ${e.name}`,
          })),
          tags: ["dead-code", "unused-export"],
        });
      }

      if (deadFiles.length > 0) {
        findings.push({
          analyzerId: "dead-code",
          severity: deadFiles.length > 5 ? "warning" : "info",
          confidence: 0.85,
          message: `${deadFiles.length} file(s) with zero incoming imports (potential dead code)`,
          locations: deadFiles.slice(0, 10).map((d) => ({ file: d.file, snippet: d.reason })),
          tags: ["dead-code", "orphan-file"],
        });
      }
    }

    if (goFiles.length > 0) {
      findings.push(...analyzeGoDeadExports(goFiles));
    }
    if (pyFiles.length > 0) {
      findings.push(...analyzePythonDeadCode(pyFiles));
    }

    findings.push(...detectUnreachableCode(ctx));

    return findings;
  },
};

// ─── Go + Python (unchanged logic) ────────────────────────────────────

const GO_EXPORT_PATTERN = /^(?:func|type|var|const)\s+([A-Z]\w+)/gm;
const PYTHON_DEF_PATTERN = /^def\s+(\w+)/gm;

function analyzeGoDeadExports(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  const exports: { name: string; file: string; line: number }[] = [];
  for (const file of files) {
    if (isEntryFile(file.relativePath)) continue;
    const regex = new RegExp(GO_EXPORT_PATTERN.source, GO_EXPORT_PATTERN.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      exports.push({
        name: match[1],
        file: file.relativePath,
        line: file.content.slice(0, match.index).split("\n").length,
      });
    }
  }
  const allContent = files.map((f) => f.content).join("\n");
  const deadExports = exports.filter((e) => countOccurrences(allContent, e.name) <= 1);
  if (deadExports.length > 3) {
    findings.push({
      analyzerId: "dead-code",
      severity: "warning",
      confidence: 0.55,
      message: `${deadExports.length} Go exported symbols appear unused: ${deadExports.slice(0, 5).map((e) => e.name).join(", ")}${deadExports.length > 5 ? "..." : ""}`,
      locations: deadExports.slice(0, 10).map((e) => ({ file: e.file, line: e.line })),
      tags: ["dead-code", "unused-export", "go"],
    });
  }
  return findings;
}

function analyzePythonDeadCode(files: SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  const defs: { name: string; file: string; line: number }[] = [];
  for (const file of files) {
    if (isEntryFile(file.relativePath)) continue;
    const regex = new RegExp(PYTHON_DEF_PATTERN.source, PYTHON_DEF_PATTERN.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const name = match[1];
      if (name.startsWith("_")) continue;
      defs.push({
        name,
        file: file.relativePath,
        line: file.content.slice(0, match.index).split("\n").length,
      });
    }
  }
  const allContent = files.map((f) => f.content).join("\n");
  const dead = defs.filter((d) => countOccurrences(allContent, d.name) <= 1);
  if (dead.length > 3) {
    findings.push({
      analyzerId: "dead-code",
      severity: "warning",
      confidence: 0.5,
      message: `${dead.length} Python functions appear unused: ${dead.slice(0, 5).map((d) => d.name).join(", ")}${dead.length > 5 ? "..." : ""}`,
      locations: dead.slice(0, 10).map((d) => ({ file: d.file, line: d.line })),
      tags: ["dead-code", "unused-def", "python"],
    });
  }
  return findings;
}

// ─── Unreachable code (kept verbatim from v1) ─────────────────────────

function detectUnreachableCode(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const unreachableLocations: { file: string; line: number; snippet: string }[] = [];
  const UNREACHABLE_PATTERN = /^(\s*)(?:return\b|throw\b|break\b|continue\b).*;?\s*$\n(?!\s*\}|\s*$|\s*\/\/|\s*case\b|\s*default\b|\s*else\b|\s*catch\b|\s*finally\b)(\s*)(\S.+)$/gm;

  for (const file of ctx.files) {
    const regex = new RegExp(UNREACHABLE_PATTERN.source, UNREACHABLE_PATTERN.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const returnIndent = match[1].length;
      const nextIndent = match[2].length;
      if (nextIndent >= returnIndent) {
        const line = file.content.slice(0, match.index).split("\n").length + 1;
        unreachableLocations.push({
          file: file.relativePath,
          line: line + 1,
          snippet: match[3].trim().slice(0, 60),
        });
      }
    }
  }

  if (unreachableLocations.length > 0) {
    findings.push({
      analyzerId: "dead-code",
      severity: "warning",
      confidence: 0.65,
      message: `${unreachableLocations.length} potentially unreachable code blocks after return/throw`,
      locations: unreachableLocations.slice(0, 10),
      tags: ["dead-code", "unreachable"],
    });
  }

  return findings;
}

function countOccurrences(text: string, word: string): number {
  const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, "g");
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
