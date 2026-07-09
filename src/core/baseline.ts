/**
 * RepoDriftBaseline — the per-HEAD cache that makes the MCP server fast.
 *
 * A whole-repo scan is 3–8s; the MCP server can't pay that per tool call. So a
 * normal `vibedrift scan` writes this baseline once (dominant pattern per drift
 * category + the team's intent hints + a MinHash index of every function), the
 * long-lived server loads it once, and each tool call overlays at most one
 * file's worth of work against the cached aggregate.
 *
 * Cache layout mirrors src/core/git-metadata.ts exactly:
 *   ~/.vibedrift/baseline-cache/<sha256(rootDir)[:16]>.json
 * Key is a content merkle (same idea as findings-cache.ts:computeAnalyzerCacheKey)
 * so a stale baseline is detected and rebuilt rather than silently served.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";

import { buildAnalysisContext } from "./discovery.js";
import { runDriftDetection } from "../drift/index.js";
import { parseFiles } from "../utils/ast.js";
import { extractAllFunctions } from "../codedna/function-extractor.js";
import { buildSignature } from "../codedna/minhash.js";
import { SECURITY_SUPPRESSION_SUBCATEGORY } from "../drift/security-suppression.js";
import { MIN_SECURITY_PEERS } from "../scoring/engine.js";
import type { AnalysisContext } from "./types.js";
import type { DriftFinding, DriftCategory } from "../drift/types.js";
import type { IntentHint } from "../intent/types.js";

const CACHE_DIR = join(homedir(), ".vibedrift", "baseline-cache");
/** Bump when vote logic / detector set / signature format changes (invalidates
 *  all caches). v3: method-ANY/ALL routes joined the auth peer group and
 *  securitySubVotes gained the MIN_SECURITY_PEERS floor, so v2 baselines carry
 *  votes the current logic would not produce. getBaseline rebuilds any
 *  persisted baseline whose version differs. */
export const BASELINE_VERSION = 3;

export interface CategoryVote {
  driftCategory: DriftCategory;
  dominantPattern: string;
  dominantCount: number;
  totalRelevantFiles: number;
  consistencyScore: number; // 0-100
  dominantFiles: string[]; // exemplars to copy
  /** Files that drift in this category + the pattern each uses instead — lets
   *  check_file_drift report "your file does X, the repo does Y". */
  deviators: Array<{ path: string; detectedPattern: string }>;
}

export interface MinhashEntry {
  relativePath: string;
  name: string;
  line: number;
  tokens: string[]; // buildSignature tokens, for exact LCS verify
  signature: Uint32Array; // 128 × uint32 MinHash
}

export interface RepoDriftBaseline {
  key: string;
  /** BASELINE_VERSION this baseline was built with. Optional because baselines
   *  persisted before the field shipped carry none; loaders treat absence as
   *  pre-current and rebuild rather than serve (getBaseline's version gate).
   *  assembleBaseline always sets it, so every newly persisted baseline is
   *  versioned. */
  version?: number;
  rootDir: string;
  ctxFiles: Array<{ path: string; hash: string }>;
  perCategoryVote: Partial<Record<DriftCategory, CategoryVote>>;
  /** Per-security-sub-convention votes (Auth middleware / Input validation /
   *  Rate limiting), keyed by sub-category label. Kept separate from
   *  perCategoryVote, which collapses all three into one security_posture slot
   *  by widest denominator — so get_dominant_pattern('auth') can read the AUTH
   *  vote, not whichever sub-convention had the most routes. */
  securitySubVotes?: Partial<Record<string, CategoryVote>>;
  intentHints: IntentHint[];
  minhashIndex: MinhashEntry[];
  builtAt: number;
}

/** On-disk shape: signatures degrade to number[] (JSON has no typed arrays). */
interface SerializedBaseline extends Omit<RepoDriftBaseline, "minhashIndex"> {
  minhashIndex: Array<Omit<MinhashEntry, "signature"> & { signature: number[] }>;
}

export function projectHash(rootDir: string): string {
  return createHash("sha256").update(rootDir).digest("hex").slice(0, 16);
}

/**
 * Content merkle over (path, content-hash). Sorted by path so the key is
 * order-independent; prefixed with BASELINE_VERSION so a logic bump invalidates
 * every cached baseline at once.
 */
export function computeBaselineKey(files: Array<{ path: string; hash: string }>): string {
  const merkle = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}:${f.hash}`)
    .join("\n");
  return createHash("sha256").update(`${BASELINE_VERSION}\n${merkle}`).digest("hex");
}

/**
 * Project each drift category's tally off the fired DriftFindings. A category
 * with multiple findings (e.g. architectural sub-aspects) keeps the one
 * covering the most files — the most representative dominant for the category.
 * Fully-consistent categories emit no finding, so they have no entry here and
 * tools report them as 100%-consistent by inference.
 *
 * The suppression-audit finding (security-suppression.ts, subCategory
 * SECURITY_SUPPRESSION_SUBCATEGORY) is excluded: it is a hygiene audit trail
 * ("N routes excluded"), not a dominance vote, so it must never win the
 * security_posture slot in place of a real auth/validation/rate-limit vote
 * (or occupy that slot when no real vote fires at all, which would make
 * check_file_drift report a nonsensical "route excluded from the security
 * consistency check" deviation for the suppressed file). It still reaches
 * `result.findings` for the CLI render; only the persisted baseline vote
 * excludes it.
 */
export function votesFromFindings(
  findings: DriftFinding[],
): Partial<Record<DriftCategory, CategoryVote>> {
  const out: Partial<Record<DriftCategory, CategoryVote>> = {};
  for (const f of findings) {
    if (f.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY) continue;
    const existing = out[f.driftCategory];
    if (existing && existing.totalRelevantFiles >= f.totalRelevantFiles) continue;
    out[f.driftCategory] = toCategoryVote(f);
  }
  return out;
}

/** Build a CategoryVote from a single finding. Shared by votesFromFindings
 *  (keyed by driftCategory) and securitySubVotesFromFindings (keyed by
 *  subCategory) so the vote shape lives in exactly one place. */
export function toCategoryVote(f: DriftFinding): CategoryVote {
  return {
    driftCategory: f.driftCategory,
    dominantPattern: f.dominantPattern,
    dominantCount: f.dominantCount,
    totalRelevantFiles: f.totalRelevantFiles,
    consistencyScore: f.consistencyScore,
    dominantFiles: f.dominantFiles ?? [],
    deviators: f.deviatingFiles.map((d) => ({ path: d.path, detectedPattern: d.detectedPattern })),
  };
}

/**
 * Like votesFromFindings but for the security sub-conventions, keyed by
 * `subCategory` instead of `driftCategory`. Only security_posture findings that
 * carry a subCategory participate; each sub-key keeps the widest-denominator
 * finding (same tie-break as votesFromFindings). The suppression-audit
 * subCategory is excluded for the same reason as in votesFromFindings above:
 * it is an audit trail, not a sub-convention vote, so it must not leave a
 * bogus "Suppression audit" entry in the persisted securitySubVotes.
 *
 * Findings whose route sample is below MIN_SECURITY_PEERS are also dropped:
 * the scoring engine demotes those same findings to advisory (too thin a
 * sample to trust, see applySecurityMinPeerFloor), so persisting them here
 * would let the MCP serve a 2-of-3-routes vote as the authoritative
 * convention while the scan refuses to score it. One floor, one boundary.
 */
export function securitySubVotesFromFindings(
  findings: DriftFinding[],
): Partial<Record<string, CategoryVote>> {
  const out: Partial<Record<string, CategoryVote>> = {};
  for (const f of findings) {
    if (f.driftCategory !== "security_posture" || !f.subCategory) continue;
    if (f.subCategory === SECURITY_SUPPRESSION_SUBCATEGORY) continue;
    if (f.totalRelevantFiles < MIN_SECURITY_PEERS) continue;
    const key = f.subCategory;
    const existing = out[key];
    if (existing && existing.totalRelevantFiles >= f.totalRelevantFiles) continue;
    out[key] = toCategoryVote(f);
  }
  return out;
}

/**
 * Assemble a baseline from ALREADY-computed scan pieces. `vibedrift scan`
 * calls this with the ctx + drift findings it just produced, so writing the
 * baseline as a scan side-effect costs only the function-signature pass — no
 * second whole-repo scan. `buildBaseline` is the standalone (re-scan) entry.
 */
export function assembleBaseline(
  rootDir: string,
  ctx: AnalysisContext,
  driftFindings: DriftFinding[],
): RepoDriftBaseline {
  const ctxFiles = ctx.files.map((file) => ({
    path: file.relativePath,
    hash: createHash("sha256").update(file.content).digest("hex"),
  }));

  const minhashIndex: MinhashEntry[] = extractAllFunctions(ctx.files).map((fn) => {
    const sig = buildSignature(fn.rawBody);
    return {
      relativePath: fn.relativePath,
      name: fn.name,
      line: fn.line,
      tokens: sig.tokens,
      signature: sig.signature,
    };
  });

  return {
    key: computeBaselineKey(ctxFiles),
    version: BASELINE_VERSION,
    rootDir,
    ctxFiles,
    perCategoryVote: votesFromFindings(driftFindings),
    securitySubVotes: securitySubVotesFromFindings(driftFindings),
    intentHints: ctx.intentHints ?? [],
    minhashIndex,
    builtAt: Date.now(),
  };
}

/** Standalone builder: scans `rootDir` from scratch, then assembles. */
export async function buildBaseline(rootDir: string): Promise<RepoDriftBaseline> {
  const { ctx } = await buildAnalysisContext(rootDir);
  await parseFiles(ctx.files);
  const { driftFindings } = runDriftDetection(ctx);
  return assembleBaseline(rootDir, ctx, driftFindings);
}

export async function writeBaseline(b: RepoDriftBaseline): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const serial: SerializedBaseline = {
    ...b,
    minhashIndex: b.minhashIndex.map((e) => ({ ...e, signature: Array.from(e.signature) })),
  };
  await writeFile(join(CACHE_DIR, `${projectHash(b.rootDir)}.json`), JSON.stringify(serial), "utf8");
}

/**
 * Drop the persisted baseline for a repo so the next build re-runs discovery
 * from scratch. Called after exclusions change (`vibedrift init` / `ignore` /
 * the MCP init tool), because the cached baseline was keyed on the old file
 * set and its freshness check only re-hashes files it already knows — it would
 * keep serving now-ignored files until a full rescan otherwise. No-op if no
 * baseline is persisted.
 */
export async function deletePersistedBaseline(rootDir: string): Promise<void> {
  await rm(join(CACHE_DIR, `${projectHash(rootDir)}.json`), { force: true });
}

function hydrate(parsed: SerializedBaseline): RepoDriftBaseline {
  return {
    ...parsed,
    minhashIndex: parsed.minhashIndex.map((e) => ({ ...e, signature: Uint32Array.from(e.signature) })),
  };
}

/** Read the persisted baseline regardless of freshness (caller checks staleness). */
export async function loadBaselineUnchecked(rootDir: string): Promise<RepoDriftBaseline | null> {
  let raw: string;
  try {
    raw = await readFile(join(CACHE_DIR, `${projectHash(rootDir)}.json`), "utf8");
  } catch {
    return null;
  }
  return hydrate(JSON.parse(raw) as SerializedBaseline);
}

/** Read the persisted baseline only if its key matches `expectKey` (else null → rebuild). */
export async function loadBaseline(
  rootDir: string,
  expectKey: string,
): Promise<RepoDriftBaseline | null> {
  const loaded = await loadBaselineUnchecked(rootDir);
  if (!loaded || loaded.key !== expectKey) return null;
  return loaded;
}
