/**
 * Implementation-gap detector.
 *
 * Flags functions whose bodies are placeholder returns. The motivating
 * bug: the VibeDrift API shipped a function in production that looked
 * like:
 *
 *   for i, val in enumerate(body.llm_validations):
 *       response.llm_validations.append(LlmValidationResult(
 *           finding_index=i,
 *           verdict="unvalidated",
 *           explanation="LLM proxy not yet implemented",
 *       ))
 *
 * That's a hardcoded placeholder string returned from a production
 * code path. The existing hygiene layer caught a low-signal TODO
 * density finding and a mild "unreachable code" warning, but neither
 * flagged the specific anti-pattern: "this function advertises a
 * shape it doesn't actually compute."
 *
 * This detector fires on two signals:
 *
 *   1. **Placeholder string returns.** Functions that return a
 *      string literal whose content matches a known placeholder
 *      vocabulary: "unvalidated", "not implemented", "TBD",
 *      "placeholder", "stub", "fake", "dummy", "coming soon", "todo".
 *      Exact phrase match, case-insensitive, whole-word.
 *
 *   2. **Explicit not-implemented markers.** `raise NotImplementedError`
 *      in Python, `throw new Error("Not implemented")` or similar in
 *      JS/TS/Go/Rust. These are always severity=error because the
 *      language itself says the function isn't done.
 *
 * This is a HYGIENE detector, not a drift detector. It doesn't
 * compare files against each other; it fires on a per-function
 * syntactic signal. Registered under intentClarity (where the
 * "generic clarity" hygiene lives) rather than architecturalConsistency.
 *
 * Language support: JavaScript, TypeScript, Python, Go, Rust — the
 * full set VibeDrift supports.
 */

import type { Analyzer } from "./base.js";
import type { AnalysisContext, Finding } from "../core/types.js";
import { getLineNumber } from "../utils/text.js";

/**
 * Phrases that, when they show up as the entire content of a return
 * string or as an Error/Exception message, strongly suggest the
 * surrounding function is a stub. Matched case-insensitively against
 * the literal value, trimmed.
 */
const PLACEHOLDER_PHRASES = new Set([
  "unvalidated",
  "unimplemented",
  "not implemented",
  "not yet implemented",
  "todo",
  "tbd",
  "placeholder",
  "stub",
  "stubbed",
  "fake",
  "dummy",
  "mock",
  "coming soon",
  "under construction",
  "wip",
  "work in progress",
]);

/**
 * Return-with-string-literal patterns. Each captures a single string
 * literal — we then test that literal against PLACEHOLDER_PHRASES.
 * Regex-only because we don't carry AST info in the hygiene pipeline.
 */
const RETURN_STRING_PATTERNS: { lang: string; regex: RegExp }[] = [
  // JS/TS: `return "..."` or `return '...'` or `return \`...\``
  { lang: "javascript", regex: /\breturn\s+(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)\s*[;,)}\n]/g },
  { lang: "typescript", regex: /\breturn\s+(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)\s*[;,)}\n]/g },
  // Python: `return "..."` or `return '...'`
  { lang: "python", regex: /\breturn\s+(?:"([^"\n]*)"|'([^'\n]*)')/g },
  // Go: `return "..."`
  { lang: "go", regex: /\breturn\s+"([^"\n]*)"/g },
  // Rust: `return "..."` or expression-style `"..."`
  { lang: "rust", regex: /\breturn\s+"([^"\n]*)"/g },
];

/**
 * Key-value assignments returning placeholder strings, as used in the
 * Pydantic constructor pattern that triggered this detector's creation.
 * Catches `verdict="unvalidated"` anywhere in a function body.
 */
const FIELD_ASSIGN_PATTERNS: { lang: string; regex: RegExp }[] = [
  // Python kwargs: `verdict="unvalidated"`, `explanation='not implemented'`.
  // This is the pattern that slipped through in api/routes/analyze.py —
  // a Pydantic constructor call passing placeholder strings as kwargs.
  { lang: "python", regex: /\b\w+\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/g },
  // Python dict: `"verdict": "unvalidated"` (string key with colon).
  { lang: "python", regex: /["']\w+["']\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)')/g },
  // JS/TS object: `verdict: "unvalidated"` (bare or quoted key).
  { lang: "javascript", regex: /["']?\w+["']?\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/g },
  { lang: "typescript", regex: /["']?\w+["']?\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/g },
];

/**
 * Explicit "not implemented" markers. Language-specific and always
 * severity=error — the language itself declares the function is
 * incomplete.
 */
const NOT_IMPLEMENTED_PATTERNS: { lang: string; regex: RegExp; label: string }[] = [
  { lang: "python", regex: /\braise\s+NotImplementedError\b/g, label: "NotImplementedError" },
  { lang: "javascript", regex: /\bthrow\s+new\s+Error\s*\(\s*["'`]Not\s+implemented/gi, label: "throw new Error('Not implemented')" },
  { lang: "typescript", regex: /\bthrow\s+new\s+Error\s*\(\s*["'`]Not\s+implemented/gi, label: "throw new Error('Not implemented')" },
  { lang: "go", regex: /\bpanic\s*\(\s*"(?:not\s+implemented|unimplemented|todo)/gi, label: "panic('not implemented')" },
  { lang: "rust", regex: /\b(?:unimplemented|todo)\s*!\s*\(/gi, label: "unimplemented!() or todo!()" },
];

function matchesPlaceholder(literal: string | undefined): boolean {
  if (!literal) return false;
  const cleaned = literal.trim().toLowerCase();
  if (cleaned.length === 0 || cleaned.length > 60) return false;
  return PLACEHOLDER_PHRASES.has(cleaned);
}

interface Hit {
  file: string;
  line: number;
  snippet: string;
  kind: "placeholder_return" | "placeholder_field" | "not_implemented";
  label: string;
}

export const implementationGapAnalyzer: Analyzer = {
  id: "implementation-gap",
  name: "Implementation Gap",
  category: "intentClarity",
  requiresAST: false,
  applicableLanguages: "all",
  version: 1,

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    const hits: Hit[] = [];

    for (const file of ctx.files) {
      if (!file.language) continue;

      // 1. Not-implemented markers (always error severity).
      for (const pattern of NOT_IMPLEMENTED_PATTERNS) {
        if (pattern.lang !== file.language) continue;
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match;
        while ((match = regex.exec(file.content)) !== null) {
          hits.push({
            file: file.relativePath,
            line: getLineNumber(file.content, match.index),
            snippet: match[0],
            kind: "not_implemented",
            label: pattern.label,
          });
        }
      }

      // 2. Placeholder string returns.
      for (const pattern of RETURN_STRING_PATTERNS) {
        if (pattern.lang !== file.language) continue;
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match;
        while ((match = regex.exec(file.content)) !== null) {
          const literal = match[1] || match[2] || match[3];
          if (!matchesPlaceholder(literal)) continue;
          hits.push({
            file: file.relativePath,
            line: getLineNumber(file.content, match.index),
            snippet: `return "${literal}"`,
            kind: "placeholder_return",
            label: literal,
          });
        }
      }

      // 3. Field assignments carrying placeholder values.
      //    E.g. `verdict="unvalidated"` inside a Pydantic constructor.
      //    To avoid flooding the report we cap per-file hits at 3 for
      //    this category — one placeholder usually indicates the stub,
      //    and nearby ones are just the supporting structure.
      let fieldHits = 0;
      for (const pattern of FIELD_ASSIGN_PATTERNS) {
        if (pattern.lang !== file.language) continue;
        const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
        let match;
        while ((match = regex.exec(file.content)) !== null && fieldHits < 3) {
          const literal = match[1] || match[2] || match[3];
          if (!matchesPlaceholder(literal)) continue;
          hits.push({
            file: file.relativePath,
            line: getLineNumber(file.content, match.index),
            snippet: match[0].trim(),
            kind: "placeholder_field",
            label: literal,
          });
          fieldHits++;
        }
      }
    }

    if (hits.length === 0) return findings;

    // Group not-implemented markers as errors (the language itself
    // declares them incomplete) and placeholder returns/fields as
    // warnings (less certain: the string might be intentional error
    // message text, not a stub).
    const errorHits = hits.filter((h) => h.kind === "not_implemented");
    const warnHits = hits.filter((h) => h.kind !== "not_implemented");

    if (errorHits.length > 0) {
      findings.push({
        analyzerId: "implementation-gap",
        severity: "error",
        confidence: 0.95,
        message: `${errorHits.length} function(s) marked explicitly as not implemented (${[...new Set(errorHits.map((h) => h.label))].join(", ")})`,
        locations: errorHits.slice(0, 10).map((h) => ({
          file: h.file,
          line: h.line,
          snippet: h.snippet,
        })),
        tags: ["implementation-gap", "not-implemented"],
      });
    }

    if (warnHits.length > 0) {
      findings.push({
        analyzerId: "implementation-gap",
        severity: warnHits.length >= 3 ? "error" : "warning",
        confidence: 0.75,
        message: `${warnHits.length} placeholder return(s) found in production code — functions that return hardcoded strings like "${warnHits[0].label}" instead of computed values`,
        locations: warnHits.slice(0, 10).map((h) => ({
          file: h.file,
          line: h.line,
          snippet: h.snippet,
        })),
        tags: ["implementation-gap", "placeholder"],
      });
    }

    return findings;
  },
};
