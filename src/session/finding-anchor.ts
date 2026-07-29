/**
 * Finding anchors: the construct a session finding was actually raised against.
 *
 * The flag path judges the EDIT (the hunk the agent just wrote); the re-check
 * judges the whole file as it now sits on disk. That asymmetry is deliberate —
 * a finding must not resolve because of a function the edit never touched — but
 * it means the re-check has to re-find the flagged construct rather than ask
 * "does this file still smell?". The classifiers answer the second question and
 * go quiet in four ways that have nothing to do with the code being fixed: a
 * capped number of per-function queries, a majority vote over the whole body, a
 * "mixed" verdict that maps to no pattern at all, and a similarity query that
 * falls under the duplicate threshold because the surrounding file grew.
 *
 * So each finding carries an anchor: what kind of construct was flagged, its
 * name, a hash of its normalized tokens, a bounded prefix of those tokens, and
 * the pattern label that was observed. The re-check resolves only on the
 * POSITIVE ABSENCE of that construct, never on a classifier's silence.
 *
 * The token prefix exists because the name and the hash both go missing for a
 * construct that was merely WRAPPED: only top-level `function`/`const` forms
 * are indexed, so moving a flagged function into a class or an object literal
 * drops it out of the index while its code is byte-identical on disk. The
 * prefix lets the re-check ask the one question that survives wrapping — is
 * this exact token sequence still somewhere in the file?
 *
 * Anchors are local: they live in the per-session outcome sidecar next to the
 * ledger and are never part of a session event (see upload-schema.ts, which
 * builds the wire shape from an allow-list that has no anchor field), so the
 * token prefix costs nothing on the wire and nothing new leaves the machine.
 */

import { createHash } from "node:crypto";
import { extractAllFunctions, tokenizeBody } from "../codedna/function-extractor.js";
import { detectLanguage } from "../core/language.js";
import { validateChangeAgainstBaseline } from "../tools-core/index.js";
import { asyncStyleFromName, hasAsyncStyle } from "../drift/async-style.js";
import { hasDataAccessPattern } from "../drift/architectural-contradiction.js";
import { hasReturnShape } from "../drift/return-shape-consistency.js";
import type { RepoDriftBaseline } from "../core/baseline.js";

/** Where a signal was seen. A function site is sharper than a file site: it can
 *  be re-found by name, by token hash, or by token-sequence containment after
 *  the file around it changes. */
export interface AnchorSite {
  kind: "file" | "function";
  symbol?: string;
  tokenHash: string;
  /** the construct's normalized tokens, capped at ANCHOR_MAX_TOKENS. Optional
   *  because the sidecar is parsed without field validation, so a truncated or
   *  hand-edited one can arrive without it. */
  tokens?: string[];
}

export interface FindingAnchor extends AnchorSite {
  /** the pattern label that was observed (e.g. ".then() chains"), or, for a
   *  duplicate, the location it matched. A bounded detector vocabulary. */
  observed: string;
}

function hashTokens(tokens: string[]): string {
  return createHash("sha256").update(tokens.join(" ")).digest("hex").slice(0, 16);
}

/** Identity of a construct by its NORMALIZED tokens, so a reformat, a comment
 *  edit, or a rename of the function itself does not lose the anchor. */
export function anchorTokenHash(body: string): string {
  return hashTokens(tokenizeBody(body));
}

/**
 * How many normalized tokens of the flagged construct the anchor keeps. This
 * codebase runs 4 to 12 tokens per line of code, so 400 covers a 30-to-100-line
 * function whole and caps a longer one at its first 400 tokens, which is about
 * 2.5KB of JSON per anchor in the sidecar. Truncating to a PREFIX is safe in
 * one direction only, and it is the safe one: a prefix is contained whenever
 * the whole sequence is, so a truncated anchor can keep a finding open that a
 * full one would have kept open too, and can never clear one.
 */
export const ANCHOR_MAX_TOKENS = 400;

/** The construct's normalized tokens, bounded for storage. */
export function anchorTokens(body: string): string[] {
  return tokenizeBody(body).slice(0, ANCHOR_MAX_TOKENS);
}

/**
 * Is this exact normalized token sequence still somewhere in `content`?
 *
 * Answers the one question that survives wrapping: the construct's name and its
 * whole-body hash both change when it is moved into a class or an object
 * literal, but its token sequence does not. Comparison is on joined tokens with
 * space delimiters on both ends, so a match can only start and end on a token
 * boundary (the tokenizer never emits a token containing a space).
 *
 * An empty or absent sequence answers false: no evidence is not evidence of
 * presence, and the caller falls back to its pattern check.
 */
export function tokensContainedIn(tokens: string[] | undefined, content: string): boolean {
  if (!tokens || tokens.length === 0) return false;
  const haystack = ` ${tokenizeBody(content).join(" ")} `;
  return haystack.includes(` ${tokens.join(" ")} `);
}

export interface FileConstructs {
  /** token hash of every function in the file — uncapped, computed once. */
  hashes: Set<string>;
  /** function name to its raw body (first declaration wins). */
  bodies: Map<string, string>;
}

/**
 * Index every function in the file's current content, once per re-check. Null
 * when the content cannot be read as source at all (unknown language), because
 * then absence cannot be established and nothing may resolve.
 */
export function fileConstructs(relFile: string, content: string): FileConstructs | null {
  const language = detectLanguage(relFile);
  if (!language) return null;
  const fns = extractAllFunctions([
    {
      path: relFile,
      relativePath: relFile,
      language,
      content,
      lineCount: content.split("\n").length,
    },
  ]);
  const hashes = new Set<string>();
  const bodies = new Map<string, string>();
  for (const fn of fns) {
    hashes.add(hashTokens(fn.bodyTokens));
    if (!bodies.has(fn.name)) bodies.set(fn.name, fn.rawBody);
  }
  return { hashes, bodies };
}

/**
 * Is the anchored signal still present in this body? Presence, not dominance:
 * a body that half-converted, or that is outnumbered by its neighbours, still
 * CONTAINS what was flagged. Unknown categories and labels answer "present", so
 * an unrecognized finding stays open instead of clearing on a guess.
 */
export function signalPresent(
  category: string,
  anchor: FindingAnchor,
  body: string,
  relFile: string,
  baseline: RepoDriftBaseline,
): boolean {
  switch (category) {
    case "async_patterns": {
      const style = asyncStyleFromName(anchor.observed);
      return style === null ? true : hasAsyncStyle(body, style);
    }
    case "architectural_consistency": {
      const present = hasDataAccessPattern(body, relFile, anchor.observed);
      return present === null ? true : present;
    }
    case "return_shape_consistency": {
      const present = hasReturnShape(body, anchor.observed);
      return present === null ? true : present;
    }
    case "redundancy": {
      // One similarity call over the index the flag path already used, not a
      // rescan of the file. A file anchor has no single body to re-query, so it
      // stays open.
      //
      // `body` is the anchored function's own body when that function is still
      // indexed; when it is not, the caller passes the whole file, and a
      // whole-file query DILUTES a small clone below the duplicate threshold.
      // That is why the caller checks token containment before it gets here:
      // this query is trusted to say "gone" only for a construct whose token
      // sequence is already known to be absent from the file.
      if (anchor.kind !== "function") return true;
      return validateChangeAgainstBaseline(baseline, relFile, body).duplicateOf.length > 0;
    }
    default:
      return true;
  }
}
