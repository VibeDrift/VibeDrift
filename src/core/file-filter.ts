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
