/**
 * Cognitive complexity analyzer.
 *
 * Uses Sonar's cognitive-complexity formulation instead of classic McCabe:
 *   +1 for every "flow break" (if, for, while, switch-case, catch, ternary,
 *       && / ||, etc.)
 *   +nestingLevel extra whenever the flow break is a NESTING construct
 *       (the bonus rewards depth, not just branch count)
 *   else / else-if / logical operators / switch-case are FLAT: +1 but no
 *       nesting bonus
 *
 * Why: consider two functions that gate on all three inputs — same behavior,
 * different shape:
 *
 *     // flat guard-clause style
 *     function handle(a, b, c) {
 *       if (!a) return err();
 *       if (!b) return err();
 *       if (!c) return err();
 *       return ok();
 *     }
 *
 *     // nested pyramid style
 *     function handle(a, b, c) {
 *       if (a) {
 *         if (b) {
 *           if (c) return ok();
 *         }
 *       }
 *       return err();
 *     }
 *
 * McCabe rates both CC=4 (one entry + three if-branches). Cognitive
 * complexity rates them 3 vs 6 — the nested form forces a reader to hold
 * all three conditions in mind simultaneously, and the metric rewards
 * that cost. Much better signal for AI-generated code, which loves
 * deep nesting.
 *
 * Numbers trend ~30–50% lower than McCabe, so thresholds were re-tuned:
 *     CC > 15  → error    (was 20)
 *     CC > 10  → warning  (was 15)
 *     CC >  6  → info     (was 10)
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding, SyntaxNode } from "../core/types.js";

// Decision-point node types per language.
// NESTING_NODES: +1 + nestingLevel, children walk at nestingLevel + 1.
// FLAT_NODES: +1, children walk at SAME nestingLevel.
const NESTING_NODES: Record<string, Set<string>> = {
  javascript: new Set([
    "if_statement", "for_statement", "for_in_statement",
    "while_statement", "do_statement", "catch_clause", "switch_statement",
  ]),
  typescript: new Set([
    "if_statement", "for_statement", "for_in_statement",
    "while_statement", "do_statement", "catch_clause", "switch_statement",
  ]),
  python: new Set([
    "if_statement", "for_statement", "while_statement", "except_clause",
    "list_comprehension", "dictionary_comprehension", "set_comprehension",
  ]),
  go: new Set([
    "if_statement", "for_statement",
    "expression_switch_statement", "type_switch_statement", "select_statement",
  ]),
  rust: new Set([
    "if_expression", "for_expression", "while_expression", "loop_expression",
    "match_expression", "if_let_expression", "while_let_expression",
  ]),
};

const FLAT_NODES: Record<string, Set<string>> = {
  javascript: new Set(["else_clause", "switch_case", "ternary_expression"]),
  typescript: new Set(["else_clause", "switch_case", "ternary_expression"]),
  python: new Set(["elif_clause", "conditional_expression"]),
  go: new Set(["expression_case", "type_case", "default_case", "communication_case"]),
  rust: new Set(["else_clause", "match_arm"]),
};

const LOGICAL_OPS = new Set(["&&", "||", "and", "or"]);

interface FunctionInfo {
  name: string;
  file: string;
  line: number;
  complexity: number;
  lineCount: number;
}

function computeCognitiveAST(node: SyntaxNode, language: string): number {
  const nesters = NESTING_NODES[language] ?? NESTING_NODES["javascript"];
  const flats = FLAT_NODES[language] ?? FLAT_NODES["javascript"];

  function walk(n: SyntaxNode, nestingLevel: number): number {
    // Nesting construct — +1 + nesting, children walk at +1.
    // Exception: within if_statement, the `else_clause` child walks at the
    // SAME nesting level as the if (else-if is structural continuation,
    // not a nested control).
    if (nesters.has(n.type)) {
      let score = 1 + nestingLevel;
      const deeper = nestingLevel + 1;
      for (let i = 0; i < n.childCount; i++) {
        const child = n.child(i)!;
        if (child.type === "else_clause" || child.type === "elif_clause") {
          score += walk(child, nestingLevel);
        } else {
          score += walk(child, deeper);
        }
      }
      return score;
    }

    // Flat construct — +1, children at same level.
    if (flats.has(n.type)) {
      let score = 1;
      for (let i = 0; i < n.childCount; i++) {
        score += walk(n.child(i)!, nestingLevel);
      }
      return score;
    }

    // Logical operator — +1 per && / || / and / or. No nesting bonus.
    if (n.type === "binary_expression" || n.type === "boolean_operator") {
      const op = n.childForFieldName("operator");
      if (op && LOGICAL_OPS.has(op.text)) {
        let score = 1;
        for (let i = 0; i < n.childCount; i++) {
          score += walk(n.child(i)!, nestingLevel);
        }
        return score;
      }
    }

    // Non-decision node — walk children at same level.
    let score = 0;
    for (let i = 0; i < n.childCount; i++) {
      score += walk(n.child(i)!, nestingLevel);
    }
    return score;
  }

  return walk(node, 0);
}

// Strip comments so the regex fallback doesn't count && / || inside them.
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")   // multi-line /* ... */
    .replace(/\/\/.*$/gm, "")            // single-line //
    .replace(/#.*$/gm, "");              // single-line # (Python)
}

/**
 * Regex fallback. Track brace depth as a proxy for control-flow nesting.
 * Less precise than the AST walker but correct for the common cases.
 *
 * Order per line matters:
 *   1. decrement depth for leading `}` (so `} else if (b) {` gets counted
 *      at the outer depth, not inside the closed block)
 *   2. count flow constructs at current depth
 *   3. increment depth for `{` (body of the new construct is deeper)
 */
function computeCognitiveRegex(content: string): number {
  const stripped = stripComments(content);
  const lines = stripped.split("\n");
  let score = 0;
  let depth = 0;

  // Nesting constructs: +1 + depth each
  const NESTING_PATTERNS = [
    /\bif\s*\(/g, /\bfor\s*\(/g, /\bfor\s+\w/g,
    /\bwhile\s*\(/g, /\bwhile\s+[^=]/g,
    /\bdo\s*\{/g, /\bswitch\s*\(/g,
    /\bcatch\s*\(/g, /\bexcept\b/g,
  ];
  // Flat constructs: +1 each
  const FLAT_PATTERNS = [
    /\belse\s+if\b/g, /\belif\b/g,
    /\belse\b(?!\s+if)/g,   // plain else, not "else if"
    /\bcase\s+/g,
    /\?[^?:]+:/g,            // ternary
  ];
  // Logical operators: +1 each
  const LOGICAL_PATTERNS = [
    /\s&&\s/g, /\s\|\|\s/g, /\band\b/g, /\bor\b/g,
  ];

  for (const line of lines) {
    // Step 1: decrement depth for each leading '}' in this line
    const openCount = (line.match(/\{/g) ?? []).length;
    const closeCount = (line.match(/\}/g) ?? []).length;
    // Approximation: close braces affect the depth at which this line's
    // constructs are evaluated. Apply them first.
    depth = Math.max(0, depth - closeCount);

    // Step 2: count flow constructs at current depth
    for (const p of NESTING_PATTERNS) {
      const matches = line.match(p);
      if (matches) score += matches.length * (1 + depth);
    }
    for (const p of FLAT_PATTERNS) {
      const matches = line.match(p);
      if (matches) score += matches.length;
    }
    for (const p of LOGICAL_PATTERNS) {
      const matches = line.match(p);
      if (matches) score += matches.length;
    }

    // Step 3: increment depth for each '{' in this line
    depth += openCount;
  }

  return score;
}

function extractFunctions(node: SyntaxNode, file: string, language: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  const functionTypes = new Set([
    "function_declaration", "method_definition", "arrow_function",
    "function_definition", "method_declaration",  // Python, Go
    "function_item", "impl_item",                 // Rust
  ]);

  function walk(n: SyntaxNode) {
    if (functionTypes.has(n.type)) {
      const nameNode = n.childForFieldName("name");
      const name = nameNode?.text ?? "(anonymous)";
      const startLine = n.startPosition.row + 1;
      const lineCount = n.endPosition.row - n.startPosition.row + 1;
      const complexity = computeCognitiveAST(n, language);

      functions.push({ name, file, line: startLine, complexity, lineCount });
    }
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  }

  walk(node);
  return functions;
}

function extractFunctionsRegex(content: string, file: string): FunctionInfo[] {
  const functionPattern = /(?:(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>|def\s+(\w+)|func\s+(\w+)|fn\s+(\w+))/g;

  const starts: { name: string; index: number; line: number }[] = [];
  let match;
  while ((match = functionPattern.exec(content)) !== null) {
    const name = match[1] || match[2] || match[3] || match[4] || match[5];
    const line = content.slice(0, match.index).split("\n").length;
    starts.push({ name, index: match.index, line });
  }

  const functions: FunctionInfo[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].index : content.length;
    const body = content.slice(start.index, bodyEnd);
    const complexity = computeCognitiveRegex(body);
    const lineCount = body.split("\n").length;
    functions.push({ name: start.name, file, line: start.line, complexity, lineCount });
  }

  return functions;
}

/**
 * Emit per-function findings for a severity tier, capped at `cap`.
 * When more than `cap` functions qualify, emit the top-N individually and
 * a single rollup finding summarizing the rest. The rollup lives at the
 * same severity — the tail is still part of that tier's signal, just
 * aggregated instead of per-function.
 */
function emitTier(
  sink: Finding[],
  fns: FunctionInfo[],
  severity: "error" | "warning" | "info",
  confidence: number,
  threshold: number,
  cap: number,
  baseTags: string[],
): void {
  const shown = fns.slice(0, cap);
  for (const fn of shown) {
    sink.push({
      analyzerId: "complexity",
      severity,
      confidence,
      message: `Function "${fn.name}" has cognitive complexity ${fn.complexity} (threshold: ${threshold})`,
      locations: [{
        file: fn.file, line: fn.line,
        snippet: `${fn.name}() — ${fn.lineCount} lines, cognitive ${fn.complexity}`,
      }],
      tags: baseTags,
    });
  }

  if (fns.length > cap) {
    const rest = fns.slice(cap);
    const lowest = rest[rest.length - 1].complexity;
    const highest = rest[0].complexity;
    sink.push({
      analyzerId: "complexity",
      severity,
      // Rollup shares the tier but with lower confidence — we only name the
      // top-N; the tail is unidentified-by-name in the report.
      confidence: Math.max(0.3, confidence - 0.2),
      message: `${rest.length} additional function(s) with cognitive complexity ${lowest}–${highest} (rolled up to reduce report volume)`,
      locations: rest.slice(0, 10).map((fn) => ({
        file: fn.file,
        line: fn.line,
        snippet: `${fn.name}() — cognitive ${fn.complexity}`,
      })),
      tags: [...baseTags, "rolled-up"],
    });
  }
}

/** Compute descriptive stats for the project-level summary. */
function summaryStats(values: number[]): { median: number; p90: number; max: number } {
  if (values.length === 0) return { median: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.max(0, Math.floor(sorted.length * 0.9) - 1)];
  const max = sorted[sorted.length - 1];
  return { median, p90, max };
}

// Per-tier caps on individual function findings. Large codebases with many
// tree-walking / pattern-matching functions genuinely have dozens of
// complexity-tier functions — emitting all of them drowns the report.
// Cap per tier, then emit a single rollup finding summarizing the tail so
// the information isn't lost.
const ERROR_CAP = 30;
const WARNING_CAP = 30;
const INFO_CAP = 20;

export const complexityAnalyzer: Analyzer = {
  id: "complexity",
  name: "Code Complexity",
  category: "intentClarity",
  requiresAST: false,
  applicableLanguages: "all",
  // Bump when logic changes — invalidates the S1 findings cache.
  version: 3,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const allFunctions: FunctionInfo[] = [];

    for (const file of ctx.files) {
      if (!file.language) continue;
      const fns = file.tree
        ? extractFunctions(file.tree.rootNode, file.relativePath, file.language)
        : extractFunctionsRegex(file.content, file.relativePath);
      allFunctions.push(...fns);
    }

    // Bucket by tier — graduated severity. Cognitive numbers trend 30–50%
    // lower than McCabe; deeply-nested code rises faster, which is the point.
    //   CC > 15 → error   (was McCabe >20)
    //   CC > 10 → warning (was McCabe >15)
    //   CC >  6 → info    (was McCabe >10)
    const errorFns: FunctionInfo[] = [];
    const warningFns: FunctionInfo[] = [];
    const infoFns: FunctionInfo[] = [];
    for (const fn of allFunctions) {
      if (fn.complexity > 15) errorFns.push(fn);
      else if (fn.complexity > 10) warningFns.push(fn);
      else if (fn.complexity > 6) infoFns.push(fn);
    }

    // Sort each tier by complexity descending — the worst go first.
    const byComplexity = (a: FunctionInfo, b: FunctionInfo) => b.complexity - a.complexity;
    errorFns.sort(byComplexity);
    warningFns.sort(byComplexity);
    infoFns.sort(byComplexity);

    emitTier(findings, errorFns, "error", 0.9, 15, ERROR_CAP, ["complexity", "critical", "cognitive"]);
    emitTier(findings, warningFns, "warning", 0.75, 10, WARNING_CAP, ["complexity", "high", "cognitive"]);
    emitTier(findings, infoFns, "info", 0.5, 6, INFO_CAP, ["complexity", "moderate", "cognitive"]);

    // Project-level summary — report median + p90, not arithmetic mean.
    // One CC=50 monster shouldn't drag the average over the warning line
    // for an otherwise-healthy codebase.
    if (allFunctions.length > 0) {
      const { median, p90, max } = summaryStats(allFunctions.map((f) => f.complexity));
      // Warn when the typical (p90) function is already over the per-function
      // warning threshold — that's real systemic complexity.
      if (p90 > 10) {
        findings.push({
          analyzerId: "complexity",
          severity: "warning",
          confidence: 0.8,
          message: `Systemic complexity: 90th percentile cognitive is ${p90} across ${allFunctions.length} functions (median=${median}, max=${max})`,
          locations: [],
          tags: ["complexity", "systemic", "cognitive"],
        });
      } else if (median > 6) {
        findings.push({
          analyzerId: "complexity",
          severity: "info",
          confidence: 0.7,
          message: `Elevated typical complexity: median cognitive is ${median} across ${allFunctions.length} functions (p90=${p90}, max=${max})`,
          locations: [],
          tags: ["complexity", "systemic", "cognitive"],
        });
      }
    }

    return findings;
  },
};
