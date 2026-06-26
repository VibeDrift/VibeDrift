/**
 * Naming-convention oscillation detector.
 *
 * Detects two kinds of drift:
 *
 *   1. SYMBOL naming conventions (project-wide).
 *      Function / class / type names across the entire project. A
 *      codebase-wide vote: if 40 functions use camelCase and 6 use
 *      snake_case, the 6 are drift. Project-scoped because symbol
 *      naming is programmer ergonomics — you don't want readers to
 *      context-switch their expectations per directory.
 *
 *   2. FILE naming conventions (directory-scoped via L1.5-S1).
 *      File basenames are organizational: tests, configs, and source
 *      legitimately follow different conventions. Within a single
 *      directory, however, consistency matters. Directory-scoped vote.
 *
 * Idiomatic exceptions (class → PascalCase, Go exported → PascalCase,
 * Python dunders __x__, SCREAMING_SNAKE constants) are filtered out
 * before voting so they don't get counted as drift.
 */

import type { DriftDetector, DriftContext, DriftFinding, DriftFile, DeviatingFile, Evidence } from "./types.js";
import { buildDirectoryScopedVote, buildFileAgeMap, pickIntentHint } from "./utils.js";

type NamingConvention = "camelCase" | "snake_case" | "PascalCase" | "SCREAMING_SNAKE" | "kebab-case";

function classifyName(name: string): NamingConvention | null {
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) return "SCREAMING_SNAKE";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "PascalCase";
  if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) return "camelCase";
  if (/^[a-z][a-z0-9_]*$/.test(name) && name.includes("_")) return "snake_case";
  if (/^[a-z][a-z0-9-]*$/.test(name) && name.includes("-")) return "kebab-case";
  if (/^[a-z][a-z0-9]*$/.test(name)) return "camelCase"; // single-word lowercase = camelCase
  return null;
}

function isIdiomaticGo(name: string, convention: NamingConvention): boolean {
  if (convention === "PascalCase" && /^[A-Z]/.test(name)) return true;
  if (/^(?:HTTP|URL|ID|JSON|XML|SQL|API|DNS|TCP|UDP|IP|TLS|SSH|EOF)/.test(name)) return true;
  return false;
}

function isIdiomaticJsTs(name: string, convention: NamingConvention, symbolType: string): boolean {
  if (symbolType === "class" && convention === "PascalCase") return true;
  if (symbolType === "function" && convention === "PascalCase" && /^[A-Z]\w*$/.test(name)) return true;
  return false;
}

function isIdiomaticPython(name: string, convention: NamingConvention, symbolType: string): boolean {
  if (symbolType === "class" && convention === "PascalCase") return true;
  if (name.startsWith("__") && name.endsWith("__")) return true;
  return false;
}

function isIdiomatic(name: string, convention: NamingConvention, symbolType: string, language: string): boolean {
  if (language === "go" && isIdiomaticGo(name, convention)) return true;
  if ((language === "javascript" || language === "typescript") && isIdiomaticJsTs(name, convention, symbolType)) return true;
  if (language === "python" && isIdiomaticPython(name, convention, symbolType)) return true;
  if (symbolType === "constant" && convention === "SCREAMING_SNAKE") return true;
  return false;
}

interface SymbolInfo {
  name: string;
  convention: NamingConvention;
  symbolType: string;
  file: string;
  line: number;
}

function extractSymbols(file: DriftFile): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  if (!file.language) return symbols;

  const lines = file.content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const funcPatterns: { regex: RegExp; type: string }[] = [];
    if (file.language === "go") {
      funcPatterns.push({ regex: /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g, type: "function" });
    } else if (file.language === "python") {
      funcPatterns.push({ regex: /def\s+(\w+)\s*\(/g, type: "function" });
      funcPatterns.push({ regex: /class\s+(\w+)/g, type: "class" });
    } else if (file.language === "javascript" || file.language === "typescript") {
      funcPatterns.push({ regex: /(?:async\s+)?function\s+(\w+)/g, type: "function" });
      funcPatterns.push({ regex: /(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/g, type: "function" });
      funcPatterns.push({ regex: /class\s+(\w+)/g, type: "class" });
      funcPatterns.push({ regex: /interface\s+(\w+)/g, type: "type" });
      funcPatterns.push({ regex: /type\s+(\w+)/g, type: "type" });
    }

    for (const { regex, type } of funcPatterns) {
      const r = new RegExp(regex.source, regex.flags);
      let m;
      while ((m = r.exec(line)) !== null) {
        const name = m[1];
        if (name.length <= 1) continue;
        const conv = classifyName(name);
        if (!conv) continue;
        if (isIdiomatic(name, conv, type, file.language)) continue;
        symbols.push({ name, convention: conv, symbolType: type, file: file.path, line: i + 1 });
      }
    }
  }

  return symbols;
}

function classifyBaseName(filePath: string): { basename: string; convention: NamingConvention } | null {
  const basename = filePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  if (basename.length <= 1) return null;
  if (/(?:test|spec|config|setup|__)/i.test(basename)) return null;
  // A single-token, separator-free, all-lowercase basename (index, render,
  // state, aggregation) is simultaneously valid camelCase, kebab-case AND
  // snake_case — it expresses no file-naming convention, so it must not vote
  // or be flagged. Returning null drops it from `profiles` entirely (see
  // analyzeFileNaming's `if (!classified) continue;`). This neutrality is
  // scoped to the FILE-naming axis only; classifyName() keeps the
  // single-word→camelCase default for the SYMBOL path, where a lone lowercase
  // identifier legitimately reads as camelCase.
  if (/^[a-z][a-z0-9]*$/.test(basename)) return null;
  const convention = classifyName(basename);
  if (!convention) return null;
  return { basename, convention };
}

// ─── Symbol-level (project-wide) ─────────────────────────────────────

function collectDeviantFiles(
  convCounts: Map<NamingConvention, SymbolInfo[]>,
  dominant: NamingConvention,
): DeviatingFile[] {
  const fileDeviants = new Map<string, SymbolInfo[]>();
  for (const [conv, syms] of convCounts) {
    if (conv === dominant) continue;
    for (const s of syms) {
      if (!fileDeviants.has(s.file)) fileDeviants.set(s.file, []);
      fileDeviants.get(s.file)!.push(s);
    }
  }

  const deviatingFiles: DeviatingFile[] = [];
  for (const [filePath, syms] of fileDeviants) {
    const uniqueConventions = [...new Set(syms.map((s) => s.convention))];
    deviatingFiles.push({
      path: filePath,
      detectedPattern: uniqueConventions.join(", "),
      evidence: syms.slice(0, 3).map((s) => ({ line: s.line, code: s.name })),
    });
  }
  return deviatingFiles;
}

function analyzeSymbolTypeConventions(
  type: string,
  typeSymbols: SymbolInfo[],
): DriftFinding | null {
  if (typeSymbols.length < 3) return null;

  const convCounts = new Map<NamingConvention, SymbolInfo[]>();
  for (const s of typeSymbols) {
    if (!convCounts.has(s.convention)) convCounts.set(s.convention, []);
    convCounts.get(s.convention)!.push(s);
  }
  if (convCounts.size < 2) return null;

  let dominant: NamingConvention | null = null;
  let maxCount = 0;
  for (const [conv, syms] of convCounts) {
    if (syms.length > maxCount) { maxCount = syms.length; dominant = conv; }
  }
  if (!dominant) return null;

  const totalSymbols = typeSymbols.length;
  const deviantCount = totalSymbols - maxCount;
  if (deviantCount < 3 || deviantCount / totalSymbols < 0.1) return null;

  const deviatingFiles = collectDeviantFiles(convCounts, dominant);
  if (deviatingFiles.length < 2) return null;

  const consistencyScore = Math.round((maxCount / totalSymbols) * 100);
  return {
    detector: "naming_conventions",
    subCategory: `${type}_names`,
    driftCategory: "naming_conventions",
    severity: deviatingFiles.length > 5 ? "error" : "warning",
    confidence: 0.8,
    finding: `${type} naming convention oscillates: ${maxCount} use ${dominant}, ${deviantCount} use other conventions — likely from different AI sessions`,
    dominantPattern: dominant,
    dominantCount: maxCount,
    totalRelevantFiles: totalSymbols,
    consistencyScore,
    deviatingFiles: deviatingFiles.slice(0, 10),
    recommendation: `${maxCount} of ${totalSymbols} ${type} names use ${dominant}. Standardize deviating names.`,
  };
}

// ─── File-level (directory-scoped) ───────────────────────────────────

const CONVENTION_NAMES: Record<NamingConvention, string> = {
  camelCase: "camelCase",
  snake_case: "snake_case",
  PascalCase: "PascalCase",
  SCREAMING_SNAKE: "SCREAMING_SNAKE",
  "kebab-case": "kebab-case",
};

function analyzeFileNaming(ctx: DriftContext): DriftFinding[] {
  // Build one profile per file: its basename convention.
  const profiles: {
    file: string;
    patterns: { pattern: NamingConvention; evidence: Evidence[] }[];
  }[] = [];
  for (const file of ctx.files) {
    const classified = classifyBaseName(file.path);
    if (!classified) continue;
    // Empty evidence: filename drift is a file-level property, not a
    // line-level one. A synthetic "line 1" here renders as a misleading
    // code snippet in the report.
    profiles.push({
      file: file.path,
      patterns: [{ pattern: classified.convention, evidence: [] }],
    });
  }

  const votes = buildDirectoryScopedVote(profiles, CONVENTION_NAMES, {
    minGroupSize: 3,
    dominanceThreshold: 0.7,
    fileAges: buildFileAgeMap(ctx),
    seededPattern: pickIntentHint(ctx, "naming_conventions")?.pattern,
  });

  return votes.map((v) => ({
    detector: "naming_conventions",
    subCategory: "file_names",
    driftCategory: "naming_conventions",
    severity: v.deviators.length >= 3 ? "warning" : "info",
    confidence: 0.75,
    finding: `File names in ${v.directory}/: ${v.dominantCount} use ${v.dominant}, ${v.deviators.length} deviate`,
    dominantPattern: v.dominant,
    dominantCount: v.dominantCount,
    totalRelevantFiles: v.totalFiles,
    consistencyScore: v.consistencyScore,
    deviatingFiles: v.deviators.slice(0, 10),
    dominantFiles: v.dominantFiles,
    recommendation: `Standardize file names in ${v.directory}/ to ${v.dominant}.`,
  }));
}

export const conventionOscillation: DriftDetector = {
  id: "convention-oscillation",
  name: "Naming Convention Oscillation",
  category: "naming_conventions",

  detect(ctx: DriftContext): DriftFinding[] {
    const findings: DriftFinding[] = [];

    // Symbol naming: project-wide (convention should be consistent across the codebase)
    const allSymbols: SymbolInfo[] = [];
    for (const file of ctx.files) {
      allSymbols.push(...extractSymbols(file));
    }
    if (allSymbols.length >= 5) {
      const symbolTypes = [...new Set(allSymbols.map((s) => s.symbolType))];
      for (const type of symbolTypes) {
        const typeSymbols = allSymbols.filter((s) => s.symbolType === type);
        const finding = analyzeSymbolTypeConventions(type, typeSymbols);
        if (finding) findings.push(finding);
      }
    }

    // File naming: directory-scoped (subsystems can legitimately differ)
    findings.push(...analyzeFileNaming(ctx));

    return findings;
  },
};
