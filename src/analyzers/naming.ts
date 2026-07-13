/**
 * Naming convention consistency with Shannon entropy gate.
 *
 * The old version counted camelCase vs snake_case identifiers project-wide
 * and flagged any non-dominant convention. That over-flagged on codebases
 * with no established convention (50/50 split → every other file was
 * "deviating"). This version measures entropy first:
 *
 *    H = −Σ p_i · log₂ p_i   over the convention distribution
 *
 *    H ≈ 0  → one convention dominates; flag deviators with high confidence.
 *    H ≈ 1  → no convention (50/50 split) — don't flag deviators, recommend
 *             establishing one.
 *    in between → normal flagging, confidence scales as (1 − H).
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding, SyntaxNode } from "../core/types.js";
import { shannonEntropy } from "../utils/math.js";

type Convention = "camelCase" | "snake_case" | "PascalCase" | "SCREAMING_SNAKE";

function detectConvention(name: string): Convention | null {
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) return "SCREAMING_SNAKE";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return "PascalCase";
  if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return "camelCase";
  if (/^[a-z][a-z0-9_]*$/.test(name)) return "snake_case";
  return null;
}

function extractIdentifiers(node: SyntaxNode): string[] {
  const ids: string[] = [];
  const targetTypes = new Set([
    "variable_declarator", "function_declaration", "method_definition",
    "lexical_declaration", "short_var_declaration", "function_item",
    "let_declaration",
  ]);

  function walk(n: SyntaxNode) {
    if (targetTypes.has(n.type)) {
      const nameNode = n.childForFieldName("name");
      if (nameNode) ids.push(nameNode.text);
    }
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  }

  walk(node);
  return ids;
}

function extractIdentifiersRegex(content: string): string[] {
  const ids: string[] = [];
  const patterns = [
    /(?:const|let|var|function)\s+(\w+)/g,
    /def\s+(\w+)/g,
    /func\s+(\w+)/g,
    /fn\s+(\w+)/g,
  ];
  for (const p of patterns) {
    const regex = new RegExp(p.source, p.flags);
    let m;
    while ((m = regex.exec(content)) !== null) {
      ids.push(m[1]);
    }
  }
  return ids;
}

export const namingAnalyzer: Analyzer = {
  id: "naming",
  name: "Naming Conventions",
  category: "architecturalConsistency",
  requiresAST: false,
  applicableLanguages: "all",
  version: 2,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const conventionCounts = new Map<Convention, string[]>();

    for (const file of ctx.files) {
      const ids = file.tree
        ? extractIdentifiers(file.tree.rootNode)
        : extractIdentifiersRegex(file.content);

      for (const id of ids) {
        if (id.length <= 1 || id.startsWith("_")) continue;
        const conv = detectConvention(id);
        if (!conv || conv === "SCREAMING_SNAKE" || conv === "PascalCase") continue;
        if (!conventionCounts.has(conv)) conventionCounts.set(conv, []);
        conventionCounts.get(conv)!.push(file.relativePath);
      }
    }

    const conventions = [...conventionCounts.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    );
    if (conventions.length < 2) return findings;

    // Entropy of the convention distribution across identifier counts.
    const counts = conventions.map(([, files]) => files.length);
    const H = shannonEntropy(counts);
    // Max entropy for 2 conventions is log₂(2) = 1. Use it to normalize.
    const maxH = Math.log2(counts.length);
    const normalizedH = maxH > 0 ? H / maxH : 0;

    // No dominant convention — don't flag individual files, recommend
    // establishing one. Only surface this when the split is near-even.
    if (normalizedH > 0.8) {
      const breakdown = conventions
        .map(([conv, files]) => `${conv} (${new Set(files).size} files)`)
        .join(", ");
      findings.push({
        analyzerId: "naming",
        severity: "info",
        confidence: 0.75,
        message: `No dominant naming convention — ${breakdown}. Pick one and standardize.`,
        locations: [],
        tags: ["naming", "no-convention"],
      });
      return findings;
    }

    // Dominant convention exists. Flag deviators. Confidence scales with
    // (1 − normalizedH): the tighter the convention, the more confident
    // a deviation is drift. Clamped [0.3, 0.9] so we never emit noise or
    // over-claim.
    const confidence = Math.max(0.3, Math.min(0.9, 1 - normalizedH));

    const dominant = conventions[0];
    for (const [conv, files] of conventions.slice(1)) {
      const uniqueFiles = [...new Set(files)];
      if (uniqueFiles.length >= 2) {
        findings.push({
          analyzerId: "naming",
          severity: "warning",
          confidence,
          message: `${uniqueFiles.length} files use ${conv} while majority uses ${dominant[0]} (H=${normalizedH.toFixed(2)})`,
          locations: uniqueFiles.slice(0, 10).map((f) => ({ file: f })),
          tags: ["naming", "inconsistency"],
        });
      }
    }

    return findings;
  },
};
