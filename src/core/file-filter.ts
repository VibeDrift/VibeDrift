import type { SourceFile } from "./types.js";

/**
 * Apply --include / --exclude glob filtering to a discovered file set.
 *
 * Semantics:
 *   - If `includes` is non-empty, a file must match AT LEAST ONE include pattern.
 *   - A file matching ANY exclude pattern is dropped.
 *   - Patterns are matched against the file's `relativePath` (the path
 *     relative to the project root that we already track in SourceFile).
 *
 * We implement a small, dependency-free glob → regex converter that supports
 * the patterns developers actually use:
 *
 *   *           — any sequence within a single path segment
 *   **          — any sequence including slashes
 *   ?           — any single character within a segment
 *   {a,b,c}     — alternation
 *   [abc]       — character class
 *   trailing /  — directory match
 *
 * Negated patterns (`!foo`) are not supported here — use --exclude instead.
 */

/**
 * Path segments that almost always denote test inputs or generated code
 * rather than the product itself. Used only to *suggest* exclusions — we
 * never drop these automatically, since "what counts as my code" is the
 * user's call. Deliberately conservative: real test files (`*.test.ts`,
 * `test/`) are NOT here, because tests are real code that drifts.
 */
const SUGGESTABLE_SEGMENTS = [
  "fixtures",
  "__fixtures__",
  "__mocks__",
  "mocks",
  "snapshots",
  "__snapshots__",
  "generated",
  "__generated__",
];

const GENERATED_FILE_RE = /\.(generated|gen)\.[A-Za-z0-9]+$/;

export interface ExclusionSuggestion {
  /** Number of scanned files that look like fixtures/generated code. */
  count: number;
  /** Suggested `.vibedriftignore` globs covering those files, sorted. */
  globs: string[];
}

/**
 * Inspect a set of scanned paths and suggest exclusions for files that look
 * like fixtures or generated code. Pure and dependency-free so the scan
 * command can surface a one-line nudge ("N files look like fixtures — exclude
 * them") without re-walking the tree. Returns `count: 0` when nothing matches,
 * which is how the nudge auto-suppresses once a `.vibedriftignore` is in place
 * (those files never reach the scanned set).
 */
export function suggestExclusions(relativePaths: string[]): ExclusionSuggestion {
  const globs = new Set<string>();
  let count = 0;

  for (const path of relativePaths) {
    const segments = path.split("/");
    let matched = false;
    for (const seg of SUGGESTABLE_SEGMENTS) {
      if (segments.includes(seg)) {
        globs.add(`**/${seg}/**`);
        matched = true;
      }
    }
    if (GENERATED_FILE_RE.test(path)) {
      globs.add("**/*.generated.*");
      matched = true;
    }
    if (matched) count++;
  }

  return { count, globs: [...globs].sort() };
}

export function applyIncludeExclude(
  files: SourceFile[],
  includes: string[],
  excludes: string[],
): SourceFile[] {
  const includeRegexes = includes.map(globToRegex);
  const excludeRegexes = excludes.map(globToRegex);

  const useInclude = includeRegexes.length > 0;

  return files.filter((file) => {
    const path = file.relativePath;

    if (useInclude && !includeRegexes.some((re) => re.test(path))) {
      return false;
    }
    if (excludeRegexes.some((re) => re.test(path))) {
      return false;
    }
    return true;
  });
}

/**
 * Convert a single glob pattern to a JavaScript RegExp.
 * Anchored: matches the *whole* relative path.
 *
 * Test cases this handles:
 *   "src/**"             → src/anything (any depth)
 *   "**\/*.test.ts"      → any file ending in .test.ts at any depth
 *   "src/?ndex.ts"       → src/index.ts or src/Cndex.ts ...
 *   "src/{a,b}/main.ts"  → src/a/main.ts or src/b/main.ts
 */
export function globToRegex(glob: string): RegExp {
  // Strip a leading "./"
  let pattern = glob.replace(/^\.\//, "");

  // Trailing "/" → directory match (anything inside)
  if (pattern.endsWith("/")) {
    pattern = pattern + "**";
  }

  let result = "";
  let i = 0;
  let inClass = false;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (inClass) {
      if (ch === "]") {
        inClass = false;
        result += "]";
      } else {
        // Escape regex meta inside char classes except ! and ^
        result += escapeInClass(ch);
      }
      i++;
      continue;
    }

    switch (ch) {
      case "*": {
        if (pattern[i + 1] === "*") {
          // ** — match any sequence including /
          // Followed by /  ⇒ "(?:.*/)?" so "src/**/foo" matches "src/foo" too
          if (pattern[i + 2] === "/") {
            result += "(?:.*/)?";
            i += 3;
          } else {
            result += ".*";
            i += 2;
          }
        } else {
          // * — any sequence excluding /
          result += "[^/]*";
          i++;
        }
        break;
      }
      case "?": {
        result += "[^/]";
        i++;
        break;
      }
      case "[": {
        inClass = true;
        result += "[";
        i++;
        // A leading "!" (glob's negation, e.g. "[!abc]") or "^" (already
        // regex-native) negates the class. Without this, "!" fell through to
        // escapeInClass and was emitted as a LITERAL "!" character inside the
        // class — so "[!_]*.ts" matched a literal "!" or "_" instead of
        // negating, silently breaking every negated character class.
        if (pattern[i] === "!" || pattern[i] === "^") {
          result += "^";
          i++;
        }
        break;
      }
      case "{": {
        // {a,b,c} → (?:a|b|c)
        const close = pattern.indexOf("}", i);
        if (close === -1) {
          result += "\\{";
          i++;
          break;
        }
        const inner = pattern.slice(i + 1, close);
        const parts = inner.split(",").map((p) => p.trim()).filter(Boolean);
        if (parts.length > 0) {
          result += "(?:" + parts.map(escapeRegex).join("|") + ")";
        } else {
          result += "\\{\\}";
        }
        i = close + 1;
        break;
      }
      default: {
        result += escapeRegex(ch);
        i++;
        break;
      }
    }
  }

  return new RegExp("^" + result + "$");
}

function escapeRegex(ch: string): string {
  if (/[.+^${}()|\\]/.test(ch)) return "\\" + ch;
  return ch;
}

function escapeInClass(ch: string): string {
  if (ch === "\\") return "\\\\";
  return ch;
}
