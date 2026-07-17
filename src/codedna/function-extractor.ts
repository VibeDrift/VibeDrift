/**
 * Cross-language function extraction for the Code DNA pipeline.
 *
 * Parses function declarations from JS/TS, Go, Python, and Rust sources
 * using regex patterns, then tokenizes their bodies for downstream
 * fingerprinting and operation-sequence analysis.
 */

import type { SourceFile, SupportedLanguage } from "../core/types.js";
import type { ExtractedFunction, FunctionRef } from "./types.js";

// Domain category detection based on function name and body content
export function detectDomainCategory(name: string, body: string): string {
  const lowerName = name.toLowerCase();
  const lowerBody = body.toLowerCase();

  if (/(?:format|display|render|stringify|tostring|totext)/i.test(lowerName)) return "formatting";
  if (/(?:date|time|timestamp|moment|duration)/i.test(lowerName + lowerBody)) return "date_manipulation";
  if (/(?:currency|price|money|dollar|cent|amount)/i.test(lowerName + lowerBody)) return "currency_handling";
  if (/(?:valid|check|verify|assert|ensure|sanitize)/i.test(lowerName)) return "validation";
  if (/(?:parse|deserialize|unmarshal|decode)/i.test(lowerName)) return "parsing";
  if (/(?:serialize|marshal|encode|stringify)/i.test(lowerName)) return "serialization";
  if (/(?:fetch|get|load|read|find|query|list|search)/i.test(lowerName)) return "data_retrieval";
  if (/(?:create|insert|add|save|store|write|put|post)/i.test(lowerName)) return "data_mutation";
  if (/(?:update|patch|modify|edit|set)/i.test(lowerName)) return "data_update";
  if (/(?:delete|remove|destroy|drop|revoke)/i.test(lowerName)) return "data_deletion";
  if (/(?:transform|convert|map|reduce|filter)/i.test(lowerName)) return "data_transformation";
  if (/(?:handle|process|dispatch|route)/i.test(lowerName)) return "request_handling";
  if (/(?:auth|login|logout|token|session|permission|role)/i.test(lowerName + lowerBody)) return "authentication";
  if (/(?:log|debug|trace|info|warn|error)/i.test(lowerName) && lowerName.length < 15) return "logging";
  if (/(?:config|setting|option|preference|env)/i.test(lowerName)) return "configuration";
  if (/(?:send|notify|email|sms|push|broadcast)/i.test(lowerName)) return "notification";

  return "general";
}

// Tokenize body for comparison (strip comments, normalize strings)
export function tokenizeBody(body: string): string[] {
  let cleaned = body.replace(/\/\/.*$/gm, "").replace(/#.*$/gm, "");
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
  cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  cleaned = cleaned.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  cleaned = cleaned.replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return cleaned.match(/[a-zA-Z_]\w*|[0-9]+|[{}()[\];,.:=<>!+\-*/%&|^~?]/g) ?? [];
}

// djb2-style hash — fast, deterministic, and sufficient for grouping
// duplicate candidates (collisions are validated by full token comparison later)
export function simpleHash(tokens: string[]): number {
  let h = 0;
  for (const t of tokens) {
    for (let i = 0; i < t.length; i++) {
      h = ((h << 5) - h + t.charCodeAt(i)) | 0;
    }
  }
  return h;
}

function extractBody(content: string, startAfterBrace: number, language: string): string {
  if (language === "python") {
    const rest = content.slice(startAfterBrace);
    const lines = rest.split("\n");
    const bodyLines: string[] = [];
    let baseIndent = -1;
    for (const line of lines) {
      if (line.trim() === "") { bodyLines.push(line); continue; }
      const indent = line.search(/\S/);
      if (baseIndent === -1) baseIndent = indent;
      if (indent >= baseIndent) bodyLines.push(line);
      else break;
    }
    return bodyLines.join("\n");
  }

  let depth = 1;
  let i = startAfterBrace;
  while (i < content.length && depth > 0) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") depth--;
    i++;
  }
  return content.slice(startAfterBrace, i);
}

interface FnPattern {
  re: RegExp;
  /**
   * true  → the regex match already ends at the start of the body, so the
   *         body begins at `match.index + match[0].length` (Go/Rust end at
   *         the body `{`; Python ends at the `:`).
   * false → the regex match ends at the parameter `)`; the body brace is
   *         located by `findBodyOpenBrace` (JS/TS, where a return-type
   *         annotation can itself contain braces).
   */
  bodyAfterMatch: boolean;
  /** Arrow functions: the body brace follows an `=>` token. */
  isArrow: boolean;
}

// Balance a `{ ... }` block. `i` must point at the opening `{`. Returns the
// index just past the matching `}`, or -1 if unbalanced.
function skipBraceBlock(content: string, i: number): number {
  let depth = 0;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Scan a TypeScript return-type annotation starting just after its `:`.
 * Returns the index positioned at the function body `{`, at an arrow `=>`, or
 * at a `;` (overload/ambient signature, no body). Returns -1 if it runs off
 * the end.
 *
 * The hard part is telling a return-type object `{ ... }` apart from the
 * function body `{ ... }`. We balance any top-level `{ ... }` and peek at what
 * follows: `|`/`&` means it was a union/intersection member (keep scanning);
 * another `{` (or, for arrows, an `=>`) means the balanced block was the
 * return type and the body comes next; anything else means the balanced block
 * WAS the body. `=>` only terminates the scan for arrows — for a `function`
 * declaration a top-level `=>` belongs to a function-type return (e.g.
 * `(): () => void { ... }`), not to a body.
 */
function skipReturnType(content: string, i: number, isArrow: boolean): number {
  const n = content.length;
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  while (i < n) {
    const c = content[i];
    if (c === "<") angle++;
    else if (c === ">" && angle > 0) angle--;
    else if (c === "(") paren++;
    else if (c === ")") {
      if (paren > 0) paren--;
      else return -1; // unbalanced — bail rather than run off
    } else if (c === "[") bracket++;
    else if (c === "]" && bracket > 0) bracket--;
    else if (angle === 0 && paren === 0 && bracket === 0) {
      if (c === "{") {
        const after = skipBraceBlock(content, i);
        if (after < 0) return -1;
        let k = after;
        while (k < n && /\s/.test(content[k])) k++;
        if (content[k] === "|" || content[k] === "&") {
          i = k + 1;
          continue;
        }
        if (content[k] === "{") return k; // next { is the body
        if (isArrow && content[k] === "=" && content[k + 1] === ">") return k;
        return i; // this { was the body
      }
      if (c === ";") return i; // overload signature, no body
      if (isArrow && c === "=" && content[i + 1] === ">") return i;
    }
    i++;
  }
  return -1;
}

/**
 * Given an index just after a function's parameter `)`, return the index of
 * the body's opening `{`, skipping an optional return-type annotation (which
 * may contain braces) and — for arrows — the `=>`. Returns -1 when there is no
 * brace body (overload/ambient declaration, or an expression-bodied arrow).
 */
function findBodyOpenBrace(content: string, fromIndex: number, isArrow: boolean): number {
  const n = content.length;
  let i = fromIndex;
  while (i < n && /\s/.test(content[i])) i++;
  if (content[i] === ":") {
    i = skipReturnType(content, i + 1, isArrow);
    if (i < 0) return -1;
    while (i < n && /\s/.test(content[i])) i++;
  }
  if (isArrow) {
    if (content[i] === "=" && content[i + 1] === ">") {
      i += 2;
      while (i < n && /\s/.test(content[i])) i++;
    } else {
      return -1; // not a brace-bodied arrow (e.g. expression body)
    }
  }
  return content[i] === "{" ? i : -1;
}

function getLanguagePatterns(language: SupportedLanguage): FnPattern[] {
  if (language === "go") {
    return [{ re: /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:[^{]*)?\{/g, bodyAfterMatch: true, isArrow: false }];
  }
  if (language === "javascript" || language === "typescript") {
    return [
      // Match up to the parameter `)`; findBodyOpenBrace locates the body brace
      // past any return-type annotation (which may contain `{`, `<>`, `=>`).
      { re: /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g, bodyAfterMatch: false, isArrow: false },
      { re: /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:<[^>]*>\s*)?\(([^)]*)\)/g, bodyAfterMatch: false, isArrow: true },
    ];
  }
  if (language === "python") {
    return [{ re: /def\s+(\w+)\s*\(([^)]*)\)\s*(?:->[^:]*)?:/g, bodyAfterMatch: true, isArrow: false }];
  }
  if (language === "rust") {
    return [{ re: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:->[^{]*)?\{/g, bodyAfterMatch: true, isArrow: false }];
  }
  return [];
}

// Extract all functions from a single source file
export function extractFunctionsFromFile(file: SourceFile): ExtractedFunction[] {
  const functions: ExtractedFunction[] = [];
  if (!file.language) return functions;

  const patterns = getLanguagePatterns(file.language);

  for (const { re, bodyAfterMatch, isArrow } of patterns) {
    const regex = new RegExp(re.source, re.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const name = match[1];
      const paramsStr = match[2];

      let startIndex: number;
      if (bodyAfterMatch) {
        startIndex = match.index + match[0].length;
      } else {
        const braceIdx = findBodyOpenBrace(file.content, match.index + match[0].length, isArrow);
        if (braceIdx < 0) continue;
        startIndex = braceIdx + 1;
      }
      const line = file.content.slice(0, match.index).split("\n").length;

      const body = extractBody(file.content, startIndex, file.language);
      if (body.length < 10) continue;

      const params = paramsStr.trim() ? paramsStr.split(",").map((p) => p.trim()) : [];
      const declarationCode = (file.content.split("\n")[line - 1] ?? "").trim();
      const tokens = tokenizeBody(body);
      if (tokens.length < 5) continue;

      functions.push({
        name,
        file: file.path,
        relativePath: file.relativePath,
        line,
        language: file.language,
        params,
        paramCount: params.length,
        rawBody: body,
        declarationCode,
        domainCategory: detectDomainCategory(name, body),
        bodyTokens: tokens,
        bodyTokenCount: tokens.length,
        bodyHash: simpleHash(tokens),
      });
    }
  }

  return functions;
}

// Extract all functions from the entire analysis context
export function extractAllFunctions(files: SourceFile[]): ExtractedFunction[] {
  const allFunctions: ExtractedFunction[] = [];
  for (const file of files) {
    allFunctions.push(...extractFunctionsFromFile(file));
  }
  return allFunctions;
}

/** Convert an ExtractedFunction to a FunctionRef. Shared by fingerprint + opseq. */
export function toFunctionRef(fn: ExtractedFunction): FunctionRef {
  return { file: fn.file, relativePath: fn.relativePath, name: fn.name, line: fn.line };
}
