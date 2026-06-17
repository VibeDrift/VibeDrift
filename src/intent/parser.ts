/**
 * Parse team-declared intent from CLAUDE.md / AGENTS.md / .cursorrules.
 *
 * Strategy:
 *   1. Look for intent files in the scan root (6 canonical locations).
 *   2. Walk each file line-by-line, tracking the current heading so we
 *      can detect when we're inside a conventions/patterns/architecture
 *      section (higher-confidence territory).
 *   3. Match against a keyword table per drift category; emit an
 *      IntentHint for every match with line/source/confidence.
 *   4. Deduplicate — the same (category, pattern) declared in multiple
 *      files keeps the highest-confidence instance.
 *
 * Regex-only for now. LLM verification is a future upgrade (higher
 * confidence scores, better negation handling) — deferred behind the
 * existing `--deep` gate.
 */

import { readFile, stat } from "fs/promises";
import { join } from "path";
import type { DriftCategory } from "../drift/types.js";
import type { IntentHint, IntentParseResult } from "./types.js";

const INTENT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "AGENT.md",
  ".cursorrules",
  ".claude/instructions.md",
  // README.md intentionally omitted — too noisy; most READMEs mention
  // patterns in passing without declaring them as conventions.
];

/**
 * Keyword → pattern mapping per drift category. Keys are case-insensitive
 * phrase matches checked against the line text. The value is the canonical
 * pattern string that detectors emit (must match exactly for the hint to
 * influence the dominance vote).
 *
 * Labels in the `labels` map give each pattern a human-readable name.
 */
const CATEGORY_KEYWORDS: Record<string, { pattern: string; keywords: string[]; label: string }[]> = {
  architectural_consistency: [
    { pattern: "repository", label: "repository pattern", keywords: ["repository pattern", "repository-pattern", "use repositories", "repository classes", "repo pattern"] },
    { pattern: "raw_sql", label: "raw SQL queries", keywords: ["raw sql", "raw queries", "direct sql", "db.query"] },
    { pattern: "orm", label: "ORM methods", keywords: ["orm", "prisma", "typeorm", "sequelize"] },
    { pattern: "exception_throw", label: "typed errors (throw)", keywords: ["throw typed", "throw errors", "typed exceptions", "typed errors", "throw an error"] },
    { pattern: "result_type", label: "Result<T> returns", keywords: ["result<", "result type", "result-type"] },
    { pattern: "http_error_response", label: "HTTP error response objects", keywords: ["error response object", "{ error }", "error json"] },
  ],
  naming_conventions: [
    { pattern: "camelCase", label: "camelCase", keywords: ["camelcase"] },
    { pattern: "PascalCase", label: "PascalCase", keywords: ["pascalcase"] },
    { pattern: "snake_case", label: "snake_case", keywords: ["snake_case", "snake-case"] },
    { pattern: "kebab-case", label: "kebab-case", keywords: ["kebab-case", "kebab case"] },
    { pattern: "SCREAMING_SNAKE", label: "SCREAMING_SNAKE", keywords: ["screaming snake", "screaming_snake"] },
  ],
  async_patterns: [
    { pattern: "async_await", label: "async/await", keywords: ["async/await", "async await", "use async await"] },
    { pattern: "then_chain", label: ".then() chains", keywords: [".then chain", "promise chain", ".then()"] },
    { pattern: "callback", label: "callbacks", keywords: ["callback style", "use callbacks"] },
  ],
  export_style: [
    { pattern: "named", label: "named exports", keywords: ["named exports", "named export only", "no default exports", "avoid default exports"] },
    { pattern: "default", label: "default exports", keywords: ["default exports", "default export", "use default exports"] },
  ],
  import_style: [
    { pattern: "alias", label: "path alias", keywords: ["path alias", "alias imports", "@/ imports", "use aliases"] },
    { pattern: "relative", label: "relative paths", keywords: ["relative imports", "relative paths", "use relative"] },
  ],
  return_shape_consistency: [
    // Detector emits: "throws" | "result_type" | "tuple" | "result_object" | "null_sentinel".
    // The hint pattern value must match the detector's emitted value exactly
    // for seeding to bind — `throws` (not `throw`), `result_object` etc.
    { pattern: "throws", label: "throw on error", keywords: ["throw on error", "throw instead of return", "throws on error"] },
    { pattern: "result_type", label: "Result<T>/Either", keywords: ["result<", "result type", "either<", "either type", "result/either"] },
    { pattern: "tuple", label: "tuple (value, error)", keywords: ["tuple return", "(value, error)", "value, err"] },
    { pattern: "result_object", label: "{ error } return object", keywords: ["{ error }", "error return shape", "error object return", "error-object return"] },
    { pattern: "null_sentinel", label: "null/undefined sentinel", keywords: ["null sentinel", "undefined sentinel", "return null on error"] },
  ],
  logging_consistency: [
    // Detector emits: "console" | "structured" | "debug_pkg" | "python_logging" | "go_slog".
    { pattern: "structured", label: "structured logger", keywords: ["structured logger", "structured logging", "winston", "pino", "bunyan", "log4js", "use a structured logger"] },
    { pattern: "console", label: "console.*", keywords: ["console.log", "console logging", "use console"] },
    { pattern: "debug_pkg", label: "debug() package", keywords: ["debug package", "use debug()"] },
    { pattern: "python_logging", label: "Python logging module", keywords: ["python logging", "logging.getLogger"] },
    { pattern: "go_slog", label: "Go slog", keywords: ["slog", "log/slog", "go slog"] },
  ],
  state_management_consistency: [
    // Detector emits: "redux" | "zustand" | "mobx" | "jotai" | "recoil" | "context" | "local_state".
    // Patterns are frontend-ecosystem-specific; a team declaring "use Zustand"
    // should auto-flag files that reach for Redux or MobX instead.
    { pattern: "redux", label: "Redux", keywords: ["redux", "use redux", "redux toolkit", "rtk"] },
    { pattern: "zustand", label: "Zustand", keywords: ["zustand", "use zustand"] },
    { pattern: "mobx", label: "MobX", keywords: ["mobx", "use mobx"] },
    { pattern: "jotai", label: "Jotai", keywords: ["jotai", "use jotai"] },
    { pattern: "recoil", label: "Recoil", keywords: ["recoil", "use recoil"] },
    { pattern: "context", label: "React Context", keywords: ["react context", "context api", "use context"] },
    { pattern: "local_state", label: "local component state", keywords: ["local state", "usestate", "component state"] },
  ],
  test_structure_consistency: [
    // Detector emits: "bdd_nested" | "flat_test" | "mocha" | "ava" | "tap" for framework,
    // "framework_mocks" | "sinon" | "manual" for mock style.
    { pattern: "bdd_nested", label: "describe/it (BDD)", keywords: ["describe/it", "describe / it", "bdd style tests", "nested describe"] },
    { pattern: "flat_test", label: "flat test()", keywords: ["flat test", "test() function", "use test()"] },
    { pattern: "framework_mocks", label: "framework mocks", keywords: ["jest.fn", "vi.fn", "vitest mocks", "jest mocks"] },
    { pattern: "sinon", label: "sinon mocks", keywords: ["sinon", "use sinon"] },
    { pattern: "manual", label: "manual stubs", keywords: ["manual stubs", "manual mocks"] },
  ],
  security_posture: [
    // Consumed by the security-consistency detector. A declared "auth required"
    // rule lets it flag uniformly-unauthed mutating routes even when no peer
    // majority exists (the uniform-wrongness baseline).
    {
      pattern: "auth_required",
      label: "auth required on all routes",
      keywords: [
        "require auth", "require authentication", "all endpoints require auth",
        "all routes require auth", "all routes authenticated", "authenticated endpoints",
        "auth on all routes", "every endpoint requires authentication", "require login",
        "all endpoints must be authenticated",
      ],
    },
  ],
};

/** Labels indexed by (category, pattern) for downstream lookup. */
export function labelFor(category: DriftCategory, pattern: string): string | null {
  const entries = CATEGORY_KEYWORDS[category];
  if (!entries) return null;
  return entries.find((e) => e.pattern === pattern)?.label ?? null;
}

/**
 * Detect whether the line (and surrounding section heading) suggests a
 * convention declaration. Used to bump confidence: keywords inside a
 * "## Conventions" heading are more trustworthy than the same keyword
 * appearing in passing prose.
 */
function sectionBoost(currentHeading: string | null): number {
  if (!currentHeading) return 0;
  const h = currentHeading.toLowerCase();
  if (/\b(conventions?|patterns?|architecture|style|standards?|rules?|guidelines?)\b/.test(h)) {
    return 0.2;
  }
  return 0;
}

/**
 * Detect negation — "do NOT use default exports" should not emit a hint
 * favoring the default-export pattern. Simple heuristic: look for common
 * negation phrasings preceding the keyword.
 */
function isNegated(line: string, keyword: string): boolean {
  const idx = line.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx < 0) return false;
  const prefix = line.slice(0, idx).toLowerCase();
  return /(don'?t|do not|avoid|never|no\s|dont|instead of)\s*$|(don'?t|do not|avoid|never|dont)\s+\w*\s*$/.test(prefix);
}

function parseContent(content: string, source: string): IntentHint[] {
  const hints: IntentHint[] = [];
  const lines = content.split("\n");
  let currentHeading: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line.length === 0) continue;

    // Track the most recent markdown heading so we can boost confidence
    // for keywords that appear inside a "conventions" section.
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      currentHeading = headingMatch[1];
      continue;
    }

    const boost = sectionBoost(currentHeading);
    const lineLower = line.toLowerCase();

    // Walk each (category, pattern, keywords) bucket looking for matches.
    for (const [category, patterns] of Object.entries(CATEGORY_KEYWORDS)) {
      for (const { pattern, keywords, label } of patterns) {
        for (const kw of keywords) {
          const kwLower = kw.toLowerCase();
          // Word-boundary match — prevents "orm" from firing on "format"
          // or "transform". For phrases (containing spaces / punctuation)
          // we fall back to substring match since they're already specific.
          const isWordLike = /^\w+$/.test(kwLower);
          const matched = isWordLike
            ? new RegExp(`\\b${kwLower}\\b`).test(lineLower)
            : lineLower.includes(kwLower);
          if (!matched) continue;
          if (isNegated(line, kw)) continue;

          // Base confidence: 0.5 for a bare match in prose; 0.7 inside
          // a conventions heading; 0.9 if the line ALSO looks like an
          // imperative declaration (starts with "use", "always", etc.)
          let confidence = 0.5 + boost;
          if (/^(?:-\s+)?(?:use|always|prefer|require|enforce|must)\b/i.test(line)) {
            confidence = Math.min(0.95, confidence + 0.2);
          }

          hints.push({
            category: category as DriftCategory,
            pattern,
            label,
            source,
            line: i + 1,
            text: line.slice(0, 200),
            confidence: Math.round(confidence * 100) / 100,
          });
        }
      }
    }
  }

  return hints;
}

/**
 * Collapse duplicate (category, pattern) hints — keep the highest-
 * confidence one. When confidence ties, prefer the earlier source in
 * INTENT_FILES (CLAUDE.md > AGENTS.md > .cursorrules > ...).
 */
function dedupe(hints: IntentHint[]): IntentHint[] {
  const priority = new Map<string, number>(INTENT_FILES.map((f, i) => [f, i]));
  const best = new Map<string, IntentHint>();
  for (const h of hints) {
    const key = `${h.category}:${h.pattern}`;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, h);
      continue;
    }
    if (h.confidence > existing.confidence) {
      best.set(key, h);
    } else if (h.confidence === existing.confidence) {
      const pH = priority.get(h.source) ?? 99;
      const pE = priority.get(existing.source) ?? 99;
      if (pH < pE) best.set(key, h);
    }
  }
  return [...best.values()];
}

export async function parseIntentFiles(rootDir: string): Promise<IntentParseResult> {
  const scanned: string[] = [];
  const missing: string[] = [];
  const allHints: IntentHint[] = [];

  for (const f of INTENT_FILES) {
    const full = join(rootDir, f);
    try {
      const s = await stat(full);
      if (!s.isFile()) {
        missing.push(f);
        continue;
      }
      const content = await readFile(full, "utf8");
      scanned.push(f);
      allHints.push(...parseContent(content, f));
    } catch {
      missing.push(f);
    }
  }

  return {
    hints: dedupe(allHints),
    sourcesScanned: scanned,
    sourcesMissing: missing,
  };
}
