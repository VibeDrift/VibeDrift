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
  return cleaned.match(/[a-zA-Z_]\w*|[0-9]+|[{}()\[\];,.:=<>!+\-*/%&|^~?]/g) ?? [];
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

function getLanguagePatterns(language: SupportedLanguage): RegExp[] {
  const patterns: RegExp[] = [];
  if (language === "go") {
    patterns.push(/func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:[^{]*)?\{/g);
  } else if (language === "javascript" || language === "typescript") {
    patterns.push(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]*)?\{/g);
    patterns.push(/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]*)?\s*=>\s*\{/g);
  } else if (language === "python") {
    patterns.push(/def\s+(\w+)\s*\(([^)]*)\)\s*(?:->[^:]*)?:/g);
  } else if (language === "rust") {
    patterns.push(/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:->[^{]*)?\{/g);
  }
  return patterns;
}

// Extract all functions from a single source file
export function extractFunctionsFromFile(file: SourceFile): ExtractedFunction[] {
  const functions: ExtractedFunction[] = [];
  if (!file.language) return functions;

  const patterns = getLanguagePatterns(file.language);

  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(file.content)) !== null) {
      const name = match[1];
      const paramsStr = match[2];
      const startIndex = match.index + match[0].length;
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
