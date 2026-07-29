/**
 * Shared async-pattern classifier — the single source of truth for the
 * "async_await" vs "then_chains" vocabulary. Used by the async-consistency
 * drift detector (to classify each file) AND by the MCP validate_change tool
 * (to classify a proposed function body against the repo's dominant), so the
 * two can never disagree on what a pattern is called.
 */
export type AsyncStyle = "async_await" | "then_chains" | "mixed";

/**
 * Human-readable display names. The drift detector stores these (not the raw
 * keys) in DriftFinding.dominantPattern, so any consumer comparing a classified
 * style to a baseline's dominant must compare in this vocabulary.
 */
export const ASYNC_STYLE_NAMES: Record<AsyncStyle, string> = {
  async_await: "async/await",
  then_chains: ".then() chains",
  mixed: "mixed async patterns",
};

/** Count `await` and `.then(` occurrences, skipping comment lines and type/interface decls. */
export function asyncCounts(content: string): { awaitCount: number; thenCount: number } {
  let awaitCount = 0;
  let thenCount = 0;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (/\bawait\s+/.test(line) && !t.startsWith("//") && !t.startsWith("*")) {
      awaitCount++;
    }
    if (
      /\.\s*then\s*\(/.test(line) &&
      !t.startsWith("//") &&
      !t.startsWith("*") &&
      !/type\s|interface\s/.test(line)
    ) {
      thenCount++;
    }
  }
  return { awaitCount, thenCount };
}

/**
 * Classify a chunk of source by its async style. Returns null when there are
 * fewer than 2 async operations (too little signal to classify), matching the
 * async-consistency detector's per-file gate.
 */
export function classifyAsyncStyle(content: string): AsyncStyle | null {
  const { awaitCount, thenCount } = asyncCounts(content);
  const total = awaitCount + thenCount;
  if (total < 2) return null;
  const awaitRatio = awaitCount / total;
  if (awaitRatio > 0.7) return "async_await";
  if (awaitRatio < 0.3) return "then_chains";
  return "mixed";
}

/** A display name back to its style key, or null when the string isn't one of
 *  this axis's names. */
export function asyncStyleFromName(label: string): AsyncStyle | null {
  for (const key of Object.keys(ASYNC_STYLE_NAMES) as AsyncStyle[]) {
    if (ASYNC_STYLE_NAMES[key] === label) return key;
  }
  return null;
}

/**
 * PRESENCE, not dominance: does this chunk still contain the style at all?
 * classifyAsyncStyle answers "what is this body mostly", which is the right
 * question for a vote and the wrong one for "did the flagged code go away" — a
 * half-converted body reads as mixed, and a converted neighbour can outvote an
 * untouched `.then()` chain. Presence never goes quiet like that.
 */
export function hasAsyncStyle(content: string, style: AsyncStyle): boolean {
  const { awaitCount, thenCount } = asyncCounts(content);
  if (style === "async_await") return awaitCount > 0;
  if (style === "then_chains") return thenCount > 0;
  return awaitCount > 0 && thenCount > 0;
}
