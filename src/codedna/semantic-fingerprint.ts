import { createHash } from "node:crypto";
import type { ExtractedFunction, SemanticFingerprint, SemanticDuplicateGroup, FunctionRef } from "./types.js";
import type { Finding } from "../core/types.js";
import { toFunctionRef } from "./function-extractor.js";

// Normalize a function body for fingerprinting:
// - Strip comments
// - Replace string literals with STR, numbers with NUM
// - Replace local variable names with positional placeholders
// - Normalize whitespace
function normalizeBody(body: string, language: string): string {
  let normalized = body;

  // Strip comments
  normalized = normalized.replace(/\/\/.*$/gm, "");
  normalized = normalized.replace(/#.*$/gm, "");
  normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, "");

  // Replace string literals with STR
  normalized = normalized.replace(/"(?:[^"\\]|\\.)*"/g, "STR");
  normalized = normalized.replace(/'(?:[^'\\]|\\.)*'/g, "STR");
  normalized = normalized.replace(/`(?:[^`\\]|\\.)*`/g, "STR");

  // Replace number literals with NUM
  normalized = normalized.replace(/\b\d+\.?\d*\b/g, "NUM");

  // Extract local variable names and replace with positional placeholders
  const varNames = new Map<string, string>();
  let varCounter = 0;

  // Collect variable declarations
  // Go: var/const + := assignments
  // JS/TS: const/let/var declarations
  // Python: simple assignments
  // Rust: let/let mut
  const declPatterns = [
    /\b(?:var|let|const)\s+(\w+)/g,        // JS/TS/Go/Rust
    /(\w+)\s*:=/g,                           // Go short declarations
    /(\w+)\s*,\s*(\w+)\s*:=/g,              // Go multi-assign
    /^(\w+)\s*=/gm,                          // Python top-level assignment
  ];

  for (const pattern of declPatterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(normalized)) !== null) {
      for (let i = 1; i < match.length; i++) {
        const name = match[i];
        if (name && !varNames.has(name) && name.length > 1 && !/^(STR|NUM|nil|null|undefined|true|false|err|error|ctx|context)$/i.test(name)) {
          varNames.set(name, `_v${varCounter++}`);
        }
      }
    }
  }

  // Also collect function parameter names as variables
  // These should have been captured from the params but we can detect them in the body too

  // Replace variable names with placeholders (longest first to avoid partial replacements)
  const sortedVars = [...varNames.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [name, placeholder] of sortedVars) {
    // Only replace whole-word occurrences
    normalized = normalized.replace(new RegExp(`\\b${escapeRegex(name)}\\b`, "g"), placeholder);
  }

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Simple SHA-256-like hash using FNV-1a (fast, good distribution, no crypto dependency)
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Return as hex string, combine two passes for more bits
  const h1 = (hash >>> 0).toString(16).padStart(8, "0");
  let hash2 = 0x1a47e90b;
  for (let i = str.length - 1; i >= 0; i--) {
    hash2 ^= str.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x01000193);
  }
  const h2 = (hash2 >>> 0).toString(16).padStart(8, "0");
  return h1 + h2;
}

export function computeSemanticFingerprints(functions: ExtractedFunction[]): SemanticFingerprint[] {
  return functions.map((fn) => ({
    functionRef: toFunctionRef(fn),
    normalizedHash: fnv1aHash(normalizeBody(fn.rawBody, fn.language)),
  }));
}

export function findDuplicateGroups(
  fingerprints: SemanticFingerprint[],
  functions: ExtractedFunction[],
): SemanticDuplicateGroup[] {
  // Build lookup: "name:file" → ExtractedFunction for SHA-256 verification
  const fnLookup = new Map<string, ExtractedFunction>();
  for (const fn of functions) {
    fnLookup.set(`${fn.name}:${fn.file}`, fn);
  }

  // Group by FNV-1a hash (fast, but can collide)
  const byHash = new Map<string, SemanticFingerprint[]>();
  for (const fp of fingerprints) {
    if (!byHash.has(fp.normalizedHash)) byHash.set(fp.normalizedHash, []);
    byHash.get(fp.normalizedHash)!.push(fp);
  }

  const groups: SemanticDuplicateGroup[] = [];
  let groupCounter = 0;

  for (const [hash, fps] of byHash) {
    if (fps.length < 2) continue;

    // Verify with SHA-256 of normalized body to eliminate FNV-1a collisions
    const bySha = new Map<string, SemanticFingerprint[]>();
    for (const fp of fps) {
      const key = `${fp.functionRef.name}:${fp.functionRef.file}`;
      const fn = fnLookup.get(key);
      if (!fn) continue;

      const sha = createHash("sha256")
        .update(normalizeBody(fn.rawBody, fn.language))
        .digest("hex");

      if (!bySha.has(sha)) bySha.set(sha, []);
      bySha.get(sha)!.push(fp);
    }

    // Only emit sub-groups where ≥2 functions share the same SHA-256
    for (const [, shaGroup] of bySha) {
      if (shaGroup.length < 2) continue;

      const uniqueFiles = new Set(shaGroup.map((fp) => fp.functionRef.file));
      if (uniqueFiles.size < 2) continue;

      groups.push({
        groupId: `fingerprint-${groupCounter++}`,
        hash,
        functions: shaGroup.map((fp) => fp.functionRef),
      });
    }
  }

  return groups;
}

// Caps on how much of a duplicate group we materialize into the finding.
// On heterogeneous codebases groups are small (2-5 members) and these
// caps never bite. On registries / theme-variant codebases (shadcn-ui,
// Material-UI, etc.) groups can have 60-200+ members; without these
// caps a single finding can balloon to 30-50KB and blow the upload
// payload. Scoring is unaffected: one finding produces one weight
// regardless of locations count.
const MAX_FINGERPRINT_NAMES_IN_MESSAGE = 10;
const MAX_FINGERPRINT_LOCATIONS = 20;

export function fingerprintFindings(groups: SemanticDuplicateGroup[]): Finding[] {
  return groups.map((group) => {
    const total = group.functions.length;
    const allNames = group.functions.map((f) => `${f.name}()`);
    const namesDisplay =
      total > MAX_FINGERPRINT_NAMES_IN_MESSAGE
        ? allNames.slice(0, MAX_FINGERPRINT_NAMES_IN_MESSAGE).join(", ") +
          ` (+${total - MAX_FINGERPRINT_NAMES_IN_MESSAGE} more)`
        : allNames.join(", ");

    const locations = group.functions.slice(0, MAX_FINGERPRINT_LOCATIONS).map((f) => ({
      file: f.relativePath,
      line: f.line,
      snippet: f.name + "()",
    }));

    const finding: Finding = {
      analyzerId: "codedna-fingerprint",
      severity: "error" as const,
      confidence: 1.0,
      message: `Exact semantic duplicate: ${namesDisplay} have identical normalized bodies across ${total} files`,
      locations,
      tags: ["codedna", "duplicate", "fingerprint"],
    };

    if (total > MAX_FINGERPRINT_LOCATIONS) {
      finding.metadata = { ...(finding.metadata ?? {}), truncatedLocations: total };
    }

    return finding;
  });
}
