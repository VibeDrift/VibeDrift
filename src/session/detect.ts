/**
 * Shared drift detection for a file's content: the SAME multi-query
 * decomposition the flag path and the outcome re-check both need. A single
 * whole-body query dilutes redundancy below the 0.8 threshold (a 3-function
 * body vs a 1-function index entry scores ~0.33) and can classify a
 * mixed-async body as null, so both the raise AND the resolve must query the
 * whole body PLUS each extracted function body — otherwise a still-present
 * finding falsely reads "resolved".
 */

import { validateChangeAgainstBaseline } from "../tools-core/index.js";
import { extractAllFunctions } from "../codedna/function-extractor.js";
import { detectLanguage } from "../core/language.js";
import { anchorTokenHash, anchorTokens, type AnchorSite } from "./finding-anchor.js";
import type { RepoDriftBaseline } from "../core/baseline.js";

const MAX_FUNCTIONS = 5;

export interface DetectedConflict {
  dominantPattern: string;
  yourPattern: string;
  fixHint: string;
}
export interface DetectedDup {
  relativePath: string;
  name: string;
  line: number;
  similarity: number;
}
export interface Detected {
  conflicts: Map<string, DetectedConflict>;
  dups: Map<string, DetectedDup>;
  /** which query saw each conflict, keyed by dimension. */
  conflictSites: Map<string, AnchorSite>;
  /** which query saw each duplicate, keyed by "path:line". */
  dupSites: Map<string, AnchorSite>;
}

interface Query {
  body: string;
  site: AnchorSite;
}

/** A function site is sharper than the whole-body site: it survives the file
 *  changing around it, so it wins even when the whole body reported first.
 *  Used for duplicates, where the map key IS the observed label (the matched
 *  location), so every query filed under a key reported that same label. */
function keepSharper(sites: Map<string, AnchorSite>, key: string, site: AnchorSite): void {
  const prev = sites.get(key);
  if (!prev || (prev.kind === "file" && site.kind === "function")) sites.set(key, site);
}

/** The site a conflict was seen at, kept next to the label seen there. A
 *  dimension can carry several labels at once (a body with both a raw driver
 *  call and a fetch), and the recorded label is the one the FIRST query
 *  reported, so a sharper site may only replace it when that later query
 *  reported the SAME label. Otherwise the anchor would name a construct that
 *  never carried the flagged pattern, and an edit to that construct would clear
 *  a finding whose flagged code is untouched. */
interface ConflictSite {
  site: AnchorSite;
  yourPattern: string;
}

/** Throws only if validateChangeAgainstBaseline throws; callers wrap. */
export function detectDrift(
  baseline: RepoDriftBaseline,
  relFile: string,
  content: string,
): Detected {
  const queries: Query[] = [
    {
      body: content,
      site: { kind: "file", tokenHash: anchorTokenHash(content), tokens: anchorTokens(content) },
    },
  ];
  try {
    const language = detectLanguage(relFile);
    if (language) {
      const fns = extractAllFunctions([
        { path: relFile, relativePath: relFile, language, content, lineCount: content.split("\n").length },
      ]);
      for (const fn of fns.slice(0, MAX_FUNCTIONS)) {
        queries.push({
          body: fn.rawBody,
          site: {
            kind: "function",
            symbol: fn.name,
            tokenHash: anchorTokenHash(fn.rawBody),
            tokens: anchorTokens(fn.rawBody),
          },
        });
      }
    }
  } catch {
    // extraction is an accuracy booster, never a requirement
  }

  const conflicts = new Map<string, DetectedConflict>();
  const dups = new Map<string, DetectedDup>();
  const seenConflicts = new Map<string, ConflictSite>();
  const dupSites = new Map<string, AnchorSite>();
  for (const q of queries) {
    const result = validateChangeAgainstBaseline(baseline, relFile, q.body);
    for (const c of result.conflicts) {
      const prev = seenConflicts.get(c.dimension);
      if (!prev) {
        conflicts.set(c.dimension, c);
        seenConflicts.set(c.dimension, { site: q.site, yourPattern: c.yourPattern });
        continue;
      }
      if (prev.yourPattern === c.yourPattern && prev.site.kind === "file" && q.site.kind === "function") {
        seenConflicts.set(c.dimension, { site: q.site, yourPattern: c.yourPattern });
      }
    }
    for (const d of result.duplicateOf) {
      const key = `${d.relativePath}:${d.line}`;
      const prev = dups.get(key);
      if (!prev || d.similarity > prev.similarity) dups.set(key, d);
      keepSharper(dupSites, key, q.site);
    }
  }
  const conflictSites = new Map<string, AnchorSite>();
  for (const [dimension, seen] of seenConflicts) conflictSites.set(dimension, seen.site);
  return { conflicts, dups, conflictSites, dupSites };
}
