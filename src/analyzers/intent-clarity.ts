/**
 * Intent clarity analyzer.
 *
 * Sub-checks (v2):
 *   1. Commented-out code blocks.
 *   2. Generic / unclear function names — hardcoded list + corpus-derived
 *      TF-IDF (B5). Names appearing in ≥30% of files in a sufficiently large
 *      project (N ≥ 10) are domain-generic for this codebase.
 *   3. Long functions (>50 lines).
 *   4. Low documentation density on large files + undocumented exports.
 *   5. Verb/AST mismatch (A4) — function names starting with a verb that
 *      doesn't match the body's control structure. A free-tier teaser for
 *      the Layer 2 ML intent-mismatch check. Regex-based for v1.
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding, SourceFile } from "../core/types.js";
import { getLineNumber } from "../utils/text.js";

// Multi-line commented-out code (3+ consecutive comment lines with code patterns)
const MULTI_LINE_COMMENT_CODE = /(?:^[ \t]*\/\/.*(?:\{|;|=|return|const|let|var|function)\s*$\n?){3,}/gm;
const MULTI_LINE_COMMENT_CODE_PY = /(?:^[ \t]*#.*(?::|=|return|def|class|import)\s*$\n?){3,}/gm;

// Hardcoded generic-name floor. The corpus-derived list augments this.
const GENERIC_NAMES = new Set([
  "data", "temp", "tmp", "val", "value", "item", "obj", "thing",
  "foo", "bar", "baz", "test", "handle", "process", "do", "run",
  "manager", "helper", "utils", "misc",
]);

const SHORT_NAME_MIN = 3;

// ─── A4: Verb-AST mismatch ────────────────────────────────────────────

/**
 * Each entry maps a leading verb to a predicate that must hold on the
 * function body. Predicates are regex heuristics — intentionally lenient so
 * we don't false-flag valid idioms. The Layer 2 ML intent-mismatch check
 * does the precise version of this at the embedding level.
 */
const VERB_EXPECTATIONS: {
  verbs: string[];
  check: (body: string) => boolean;
  label: string;
}[] = [
  {
    verbs: ["get", "find", "fetch", "read", "load", "retrieve"],
    check: (b) => /\breturn\s+(?!(?:void|null|undefined|None)\s*[;)])/.test(b),
    label: "must return a non-void value",
  },
  {
    verbs: ["validate", "check", "verify", "assert", "ensure"],
    check: (b) => /\bthrow\b|\braise\b|\breturn\s+(?:true|false)\b/.test(b),
    label: "must throw on invalid input or return boolean",
  },
  {
    verbs: ["is", "has", "should", "can", "must", "will"],
    check: (b) => /\breturn\s+(?:true|false|!\w|\w+\s*(?:===|!==|==|!=|<|>|<=|>=))/.test(b),
    label: "must return a boolean",
  },
  {
    verbs: ["delete", "remove", "clear", "destroy", "drop"],
    check: (b) => /\b(?:delete\s|splice|pop|shift|removeChild|remove\(|destroy\(|drop\()/.test(b)
      || /=\s*(?:null|undefined|None|\[\s*\]|\{\s*\})/.test(b),
    label: "must mutate or call a deletion operation",
  },
];

function extractLeadingVerb(name: string): string | null {
  // camelCase: first lowercase run; snake_case: up to first underscore.
  const m = name.match(/^([a-z]+)/);
  return m ? m[1] : null;
}

function findVerbMismatches(
  files: SourceFile[],
): { file: string; line: number; name: string; verb: string; expectation: string }[] {
  const out: { file: string; line: number; name: string; verb: string; expectation: string }[] = [];

  const funcStarts = [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/gm,
    /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/gm,
    /^def\s+(\w+)\s*\(/gm,
    /^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/gm,
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[(<]/gm,
  ];

  for (const file of files) {
    if (!file.language) continue;

    const starts: { name: string; offset: number; line: number }[] = [];
    for (const pattern of funcStarts) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let m;
      while ((m = regex.exec(file.content)) !== null) {
        starts.push({
          name: m[1],
          offset: m.index,
          line: getLineNumber(file.content, m.index),
        });
      }
    }
    starts.sort((a, b) => a.offset - b.offset);

    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      const end = i + 1 < starts.length ? starts[i + 1].offset : file.content.length;
      const body = file.content.slice(s.offset, end);
      // Bodies <40 chars are too short to trust a verb-match heuristic on.
      if (body.length < 40) continue;

      const verb = extractLeadingVerb(s.name);
      if (!verb) continue;
      const expectation = VERB_EXPECTATIONS.find((e) => e.verbs.includes(verb));
      if (!expectation) continue;
      if (!expectation.check(body)) {
        out.push({
          file: file.relativePath,
          line: s.line,
          name: s.name,
          verb,
          expectation: expectation.label,
        });
      }
    }
  }

  return out;
}

// ─── B5: TF-IDF generic-name derivation ───────────────────────────────

/**
 * Derive a set of identifiers that are "generic for this codebase" — they
 * appear in ≥30% of files. Names like `user`, `order`, `request` in a typical
 * web app end up domain-vocabulary (high frequency, still meaningful), but
 * things like `result`, `data`, `item` also land here and should nudge toward
 * better names in function positions.
 *
 * Only activates with ≥10 files — smaller corpora don't give reliable df.
 */
function deriveCorpusGenericNames(files: SourceFile[]): Set<string> {
  if (files.length < 10) return new Set();
  const df = new Map<string, Set<string>>();

  for (const file of files) {
    if (!file.language) continue;
    const identifiers = file.content.match(/\b[a-z][a-zA-Z0-9_]{2,}\b/g) ?? [];
    const seen = new Set(identifiers);
    for (const id of seen) {
      const set = df.get(id);
      if (set) set.add(file.relativePath);
      else df.set(id, new Set([file.relativePath]));
    }
  }

  const threshold = Math.max(Math.floor(files.length * 0.3), 3);
  const generic = new Set<string>();
  for (const [id, fileSet] of df) {
    if (fileSet.size >= threshold && id.length <= 8) {
      // Short, common identifiers are the genuine generics.
      // "userRepository" appearing 30% is domain; "data" appearing 30% is noise.
      generic.add(id);
    }
  }
  return generic;
}

// ─── Analyzer ─────────────────────────────────────────────────────────

export const intentClarityAnalyzer: Analyzer = {
  id: "intent-clarity",
  name: "Intent Clarity",
  category: "intentClarity",
  requiresAST: false,
  applicableLanguages: "all",
  version: 2,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const corpusGeneric = deriveCorpusGenericNames(ctx.files);

    findings.push(...detectCommentedOutCode(ctx));
    findings.push(...detectUnclearNaming(ctx, corpusGeneric));
    findings.push(...detectLongFunctions(ctx));
    findings.push(...detectLowDocumentation(ctx));
    findings.push(...detectVerbMismatch(ctx));

    return findings;
  },
};

function detectCommentedOutCode(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  let totalBlocks = 0;
  const blockLocations: { file: string; line: number; snippet: string }[] = [];

  for (const file of ctx.files) {
    const pattern = file.language === "python"
      ? MULTI_LINE_COMMENT_CODE_PY
      : MULTI_LINE_COMMENT_CODE;

    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      totalBlocks++;
      const line = getLineNumber(file.content, match.index);
      const lines = match[0].trim().split("\n");
      blockLocations.push({
        file: file.relativePath,
        line,
        snippet: lines[0].trim().slice(0, 80) + (lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""),
      });
    }
  }

  if (totalBlocks > 0) {
    findings.push({
      analyzerId: "intent-clarity",
      severity: totalBlocks > 10 ? "error" : totalBlocks > 3 ? "warning" : "info",
      confidence: 0.7,
      message: `${totalBlocks} blocks of commented-out code found`,
      locations: blockLocations.slice(0, 15),
      tags: ["intent", "commented-code"],
    });
  }

  return findings;
}

function detectUnclearNaming(ctx: AnalysisContext, corpusGeneric: Set<string>): Finding[] {
  const findings: Finding[] = [];
  const funcNamePatterns = [
    /(?:function|const|let|var)\s+(\w+)\s*(?:=\s*(?:async\s+)?(?:\(|function)|\()/g,
    /def\s+(\w+)\s*\(/g,
    /func\s+(\w+)\s*\(/g,
    /fn\s+(\w+)\s*[(<]/g,
  ];

  const genericFunctions: { name: string; file: string; line: number; reason: "hardcoded" | "corpus" }[] = [];
  const shortFunctions: { name: string; file: string; line: number }[] = [];

  for (const file of ctx.files) {
    for (const pattern of funcNamePatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(file.content)) !== null) {
        const name = match[1];
        const line = getLineNumber(file.content, match.index);

        if (name.length < SHORT_NAME_MIN && !["go", "fn", "ok", "id"].includes(name)) {
          shortFunctions.push({ name, file: file.relativePath, line });
        }

        const lowerName = name.toLowerCase();
        if (GENERIC_NAMES.has(lowerName)) {
          genericFunctions.push({ name, file: file.relativePath, line, reason: "hardcoded" });
        } else if (corpusGeneric.has(lowerName)) {
          genericFunctions.push({ name, file: file.relativePath, line, reason: "corpus" });
        }
      }
    }
  }

  if (genericFunctions.length > 3) {
    const uniqueNames = [...new Set(genericFunctions.map((f) => f.name))];
    const corpusCount = genericFunctions.filter((f) => f.reason === "corpus").length;
    const suffix = corpusCount > 0 ? ` (${corpusCount} corpus-derived)` : "";
    findings.push({
      analyzerId: "intent-clarity",
      severity: "warning",
      confidence: 0.65,
      message: `${genericFunctions.length} functions with generic/unclear names${suffix} — e.g. ${uniqueNames.slice(0, 5).join(", ")}`,
      locations: genericFunctions.slice(0, 10).map((f) => ({
        file: f.file,
        line: f.line,
        snippet: `function ${f.name}(...)`,
      })),
      tags: ["intent", "naming"],
    });
  }

  if (shortFunctions.length > 5) {
    findings.push({
      analyzerId: "intent-clarity",
      severity: "info",
      confidence: 0.5,
      message: `${shortFunctions.length} functions with very short names (<${SHORT_NAME_MIN} chars)`,
      locations: shortFunctions.slice(0, 10).map((f) => ({
        file: f.file,
        line: f.line,
      })),
      tags: ["intent", "naming", "short"],
    });
  }

  return findings;
}

function detectLongFunctions(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const functionStarts = [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
    /^def\s+(\w+)/gm,
    /^func\s+(?:\([^)]*\)\s+)?(\w+)/gm,
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm,
  ];

  const longFunctions: { name: string; file: string; line: number; lines: number }[] = [];
  const LONG_THRESHOLD = 50;

  for (const file of ctx.files) {
    const starts: { name: string; offset: number; line: number }[] = [];
    for (const pattern of functionStarts) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(file.content)) !== null) {
        starts.push({
          name: match[1],
          offset: match.index,
          line: getLineNumber(file.content, match.index),
        });
      }
    }
    starts.sort((a, b) => a.offset - b.offset);

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const endOffset = i + 1 < starts.length ? starts[i + 1].offset : file.content.length;
      const body = file.content.slice(start.offset, endOffset);
      const lineCount = body.split("\n").length;
      if (lineCount > LONG_THRESHOLD) {
        longFunctions.push({
          name: start.name,
          file: file.relativePath,
          line: start.line,
          lines: lineCount,
        });
      }
    }
  }

  if (longFunctions.length > 0) {
    findings.push({
      analyzerId: "intent-clarity",
      severity: longFunctions.some((f) => f.lines > 100) ? "error" : "warning",
      confidence: 0.85,
      message: `${longFunctions.length} functions exceed ${LONG_THRESHOLD} lines`,
      locations: longFunctions.slice(0, 10).map((f) => ({
        file: f.file,
        line: f.line,
        snippet: `${f.name}() — ${f.lines} lines`,
      })),
      tags: ["intent", "long-function"],
    });
  }

  return findings;
}

function countFileCommentDensity(file: { content: string; lineCount: number }): {
  lines: number;
  commentLines: number;
  density: number;
} {
  const lines = file.content.split("\n");
  let commentLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") || trimmed.startsWith("#") ||
      trimmed.startsWith("/*") || trimmed.startsWith("*") ||
      trimmed.startsWith("///") || trimmed.startsWith('"""')
    ) {
      commentLines++;
    }
  }
  return {
    lines: file.lineCount,
    commentLines,
    density: commentLines / file.lineCount,
  };
}

function findUndocumentedExports(
  files: { content: string; language: string | null; relativePath: string }[],
): { file: string; name: string; line: number }[] {
  const undocumentedExports: { file: string; name: string; line: number }[] = [];
  for (const file of files) {
    if (!file.language) continue;
    const lines = file.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let exportedName: string | null = null;
      if (file.language === "go") {
        const m = line.match(/^func\s+(?:\([^)]*\)\s+)?([A-Z]\w+)\s*\(/);
        if (m) exportedName = m[1];
      } else if (file.language === "python") {
        const m = line.match(/^def\s+(\w+)\s*\(/);
        if (m && !m[1].startsWith("_")) exportedName = m[1];
      } else if (file.language === "rust") {
        const m = line.match(/^pub\s+(?:async\s+)?fn\s+(\w+)/);
        if (m) exportedName = m[1];
      }
      if (!exportedName) continue;
      const prevLine = i > 0 ? lines[i - 1].trim() : "";
      const hasDoc = prevLine.startsWith("//") || prevLine.startsWith("///") ||
        prevLine.startsWith("/*") || prevLine.startsWith('"""') ||
        prevLine.startsWith("#");
      if (!hasDoc) {
        undocumentedExports.push({ file: file.relativePath, name: exportedName, line: i + 1 });
      }
    }
  }
  return undocumentedExports;
}

function detectLowDocumentation(ctx: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  const underdocumented: { file: string; lines: number; commentRatio: number }[] = [];

  for (const file of ctx.files) {
    if (file.lineCount < 100) continue;
    const { density } = countFileCommentDensity(file);
    if (density < 0.05) {
      underdocumented.push({
        file: file.relativePath,
        lines: file.lineCount,
        commentRatio: Math.round(density * 100),
      });
    }
  }

  if (underdocumented.length > 2) {
    findings.push({
      analyzerId: "intent-clarity",
      severity: underdocumented.length > 5 ? "warning" : "info",
      confidence: 0.6,
      message: `${underdocumented.length} files over 100 lines have <5% comment density — intent may be unclear to maintainers`,
      locations: underdocumented.slice(0, 10).map((f) => ({
        file: f.file,
        snippet: `${f.lines} lines, ${f.commentRatio}% comments`,
      })),
      tags: ["intent", "documentation"],
    });
  }

  const undocumentedExports = findUndocumentedExports(ctx.files);
  if (undocumentedExports.length > 10) {
    const ratio = ctx.files.length > 0
      ? Math.round((undocumentedExports.length / ctx.files.length) * 10) / 10
      : 0;
    findings.push({
      analyzerId: "intent-clarity",
      severity: undocumentedExports.length > 30 ? "warning" : "info",
      confidence: 0.55,
      message: `${undocumentedExports.length} exported functions lack documentation (~${ratio} per file)`,
      locations: undocumentedExports.slice(0, 10).map((e) => ({
        file: e.file,
        line: e.line,
        snippet: `${e.name}() — no doc comment`,
      })),
      tags: ["intent", "undocumented"],
    });
  }

  return findings;
}

function detectVerbMismatch(ctx: AnalysisContext): Finding[] {
  const mismatches = findVerbMismatches(ctx.files);
  if (mismatches.length === 0) return [];

  return [{
    analyzerId: "intent-clarity",
    severity: mismatches.length > 10 ? "warning" : "info",
    confidence: 0.6,
    message: `${mismatches.length} function(s) where the leading verb doesn't match the body's control structure`,
    locations: mismatches.slice(0, 10).map((m) => ({
      file: m.file,
      line: m.line,
      snippet: `${m.name}() — verb "${m.verb}" ${m.expectation}`,
    })),
    tags: ["intent", "verb-mismatch"],
  }];
}
