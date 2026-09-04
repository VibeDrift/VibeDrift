/**
 * One-vs-N near-duplicate search for a single function body against a cached
 * index of function token-streams. Uses the low-level MinHash primitives
 * directly (buildSignature → tokens, then exact LCS verify) rather than
 * sampler.ts's band helper, which caps at SIMILARITY_BAND_HIGH (0.80) to
 * EXCLUDE obvious clones — here we want the full range, including exact dups.
 *
 * Index/query asymmetry (issue #81): every `SimIndexEntry` is built from
 * `extractAllFunctions(...).rawBody` (`core/baseline.ts`), which is BODY-ONLY
 * -- it excludes the function's own declaration line. A caller who pastes a
 * whole function (signature included, the natural thing to do) gets a query
 * token stream the index entry never had, which can deflate the similarity
 * score below either consuming threshold. For short functions this isn't a
 * gradual deflation -- `lcsSimilarity`'s length-ratio gate can return a hard
 * 0 before any LCS runs at all, because the signature alone can more than
 * double the token count relative to a small body-only entry.
 *
 * Fix: score the query BOTH as given and, when a leading signature can be
 * heuristically stripped, with that stripped too, and keep the higher of the
 * two per index entry. This is monotone -- it can only raise a score toward
 * what a body-only query would have found, never invent a match that
 * wouldn't otherwise exist -- so a wrong strip (e.g. on a body that legitimately
 * opens with a nested block) never makes things worse than not stripping at
 * all; it just loses to the raw candidate in the max.
 */
import { buildSignature, lcsSimilarity, type SimilaritySignature } from "./minhash.js";

/** How far into the text a plausible signature-ending brace/colon must sit to
 *  be treated as one. Real TypeScript signatures with inline object-type
 *  parameters or multi-line generic constraints routinely run past 200 chars
 *  (measured against this repo's own src/), so this is deliberately generous.
 *  Safe to widen further: the "closest to the end of the text" selection in
 *  `stripLeadingSignature` is what actually guarantees correctness, not this
 *  cutoff -- it only bounds how far into a long paste we bother looking. */
const SIGNATURE_ZONE = 600;

/** Bare keywords that open a brace block without being a declaration --
 *  `try {`, `catch (e) {`, `if (x) {`, etc. A block like this can still be
 *  the LAST statement in a real body, which makes its own closing brace land
 *  suspiciously close to the text's end -- exactly the signal the "closest
 *  to the end" rule is looking for. Without this guard, recursing into an
 *  already-correctly-stripped body can mistake its own trailing try/catch
 *  for another signature layer and strip away real code. */
const CONTROL_FLOW_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "try", "else", "do", "finally"]);

/** Is the brace at `braceIdx` immediately preceded (mod an optional
 *  parenthesized clause, e.g. `catch (e)`) by a bare control-flow keyword? */
function precededByControlFlow(text: string, braceIdx: number): boolean {
  const window = text.slice(Math.max(0, braceIdx - 60), braceIdx).replace(/\s+$/, "");
  const withoutParen = window.replace(/\([^()]*\)\s*$/, "").replace(/\s+$/, "");
  const words = withoutParen.split(/\s+/);
  return CONTROL_FLOW_KEYWORDS.has(words[words.length - 1]);
}

/**
 * If `text` looks like it opens with a function declaration, return just the
 * body past that declaration (mirroring the shared extractor's rawBody
 * convention: opening `{` excluded, closing `}` included; Python: dedented
 * block after the `:` line). Returns null when no plausible split point
 * exists, so the caller falls back to scoring the raw text as-is.
 *
 * Deliberately language-agnostic: `find_similar_function` has no target file
 * at all (the function doesn't exist yet), so there's nothing reliable to
 * detect a language from. Also deliberately doesn't try to recognize a
 * signature by shape (e.g. `name(` or `name<T>(`) -- generic type parameters,
 * multi-line param lists, and a return type that itself contains a brace
 * (`(): { x: number } {`) all defeat a simple "does the prefix look like a
 * signature" regex. Instead: try every `{` within the signature zone as a
 * candidate body-open, and keep whichever one's balanced match consumes
 * closest to the end of the text -- the real body brace is the one whose
 * matching `}` is (near) the last character, because everything after an
 * EARLIER brace (like a return-type object literal) is more function left to
 * go, so its own match closes well short of the end.
 */
export function stripLeadingSignature(text: string): string | null {
  const trimmedLen = text.replace(/\s+$/, "").length;
  let best: string | null = null;
  let bestGap = Infinity;

  let searchFrom = 0;
  for (let braceIdx = text.indexOf("{", searchFrom); braceIdx !== -1 && braceIdx < SIGNATURE_ZONE; braceIdx = text.indexOf("{", searchFrom)) {
    searchFrom = braceIdx + 1;
    if (precededByControlFlow(text, braceIdx)) continue;
    let depth = 1;
    let i = braceIdx + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    if (depth !== 0) continue; // unbalanced from here; not a real candidate
    const gap = trimmedLen - i;
    if (gap < 0 || gap > 2) continue; // doesn't reach (near) the end of the text
    const body = text.slice(braceIdx + 1, i);
    // body includes the trailing `}` (the rawBody convention), so checking
    // body.trim() for emptiness is wrong -- "}" trims to "}", not "". Check
    // the content BEFORE that trailing brace instead.
    if (body.slice(0, -1).trim().length === 0) continue;
    if (gap < bestGap) {
      best = body;
      bestGap = gap;
    }
  }
  if (best) {
    // Nested wrapper (e.g. a class containing the method): the "closest to
    // the end" rule always prefers the OUTERMOST brace first (it wraps
    // everything, so its gap is smallest), which strips the class but
    // leaves the method's own signature line sitting at the start of the
    // result. Recurse on the result to peel further layers. Guaranteed to
    // terminate: `best` is always strictly shorter than `text` (it excludes
    // at least the wrapper's own declaration), so each call operates on a
    // smaller string.
    return stripLeadingSignature(best) ?? best;
  }

  // Python: a `def name(...):` (optionally `async def`, optionally a return
  // annotation) line, then a dedent-delimited block.
  const defMatch = text.match(/^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*(?:->[^:]*)?:\s*\n/);
  if (defMatch && defMatch[0].length < SIGNATURE_ZONE) {
    const rest = text.slice(defMatch[0].length);
    return rest.trim().length > 0 ? rest : null;
  }

  return null;
}

export interface SimIndexEntry {
  relativePath: string;
  name: string;
  line: number;
  tokens: string[];
}

export interface SimMatch {
  relativePath: string;
  name: string;
  line: number;
  similarity: number;
}

export function findSimilarToBody(
  body: string,
  index: SimIndexEntry[],
  opts: { threshold: number; cap: number },
): SimMatch[] {
  const q = buildSignature(body);
  // Second candidate: the same text with a leading signature stripped, when
  // one can be found. Scored against the SAME index entries; the higher of
  // the two per entry wins (see module doc for why this is safe).
  const stripped = stripLeadingSignature(body);
  const qStripped: SimilaritySignature | null = stripped ? buildSignature(stripped) : null;

  const out: SimMatch[] = [];
  for (const e of index) {
    // Pass the caller's own threshold as the length-ratio pre-filter's bound:
    // the gate then skips exactly the pairs that cannot reach it, and no others.
    let sim = lcsSimilarity(q.tokens, e.tokens, opts.threshold);
    if (qStripped) sim = Math.max(sim, lcsSimilarity(qStripped.tokens, e.tokens, opts.threshold));
    if (sim >= opts.threshold) {
      out.push({
        relativePath: e.relativePath,
        name: e.name,
        line: e.line,
        similarity: Number(sim.toFixed(3)),
      });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, opts.cap);
}
