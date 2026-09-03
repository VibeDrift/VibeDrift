/**
 * Inline drift checks for a single edit event, sharing the exact classifiers
 * the detectors use (via the tools-core pure projection), plus the FYI
 * throttle. Everything here is fail-open: state I/O errors are swallowed and
 * the caller gets an empty outcome rather than an exception.
 *
 * Phase 0 measurement: the check scales ~0.1ms per indexed function, so the
 * inline path is gated to baselines at or under INLINE_CHECK_MAX_ENTRIES;
 * larger repos record the edit and stay quiet (deferred checking is a later
 * phase).
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadBaselineUnchecked, type RepoDriftBaseline } from "../core/baseline.js";
import { detectLanguage } from "../core/language.js";
import { detectDrift } from "./detect.js";
import type { AnchorSite, FindingAnchor } from "./finding-anchor.js";
import { newActivityId, safeSegment } from "./ledger.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent } from "./types.js";
import { isInLoopCheckable } from "../drift/utils.js";
import { verifyCounterpart } from "./counterpart.js";
import { writeFileAtomic } from "./atomic-write.js";

export const INLINE_CHECK_MAX_ENTRIES = 2000;
export const COOLDOWN_MS = 5 * 60_000;

/** A duplicate at or above this similarity is a near-clone: the single most
 *  actionable finding an edit can raise, so it outranks dimension conflicts
 *  for the one advisory that gets messaged. Below it, conflicts keep the lead
 *  (at lower similarity the convention conflict is usually the better call). */
export const STRONG_DUP_SIMILARITY = 0.9;

/**
 * Appended to every MESSAGED advisory. The line used to end with a hint and no
 * instruction; on a real session the agent declined two flags and accepted two
 * in plain chat and none of it reached the ledger, because nothing told it to
 * record a call. `respond_to_flag` is the MCP tool that writes the decision;
 * where the MCP server is not connected the fallback keeps the reason at least
 * visible in the reply.
 */
export const ADVISORY_ASK =
  " Fix it, or record your call with respond_to_flag (accept / park / decline) and one reason; if that tool is unavailable, say the reason in your reply.";

/** One advisory candidate for the single-message pick: the cooldown key, the
 *  agent-facing line, and the recorded flag event it belongs to. */
export interface AdvisoryCandidate {
  key: string;
  message: string;
  event: SessionEvent;
}

/** Order candidates by strength before the cooldown pick: a near-clone
 *  duplicate (similarity >= STRONG_DUP_SIMILARITY) moves ahead of dimension
 *  conflicts; otherwise the incoming order (conflicts first) is preserved.
 *  Pure and stable. This only chooses which finding is MESSAGED — every flag
 *  is still recorded in the ledger regardless. */
export function rankAdvisoryCandidates(candidates: AdvisoryCandidate[]): AdvisoryCandidate[] {
  const strong = (c: AdvisoryCandidate): boolean =>
    c.event.detail.category === "redundancy" &&
    typeof c.event.detail.similarity === "number" &&
    c.event.detail.similarity >= STRONG_DUP_SIMILARITY;
  return [...candidates.filter(strong), ...candidates.filter((c) => !strong(c))];
}

export interface CooldownState {
  nextFindingSeq: number;
  lastFyi: Record<string, number>;
}

/** Merge two cooldown snapshots (this write's local state and whatever is
 *  currently on disk) so a concurrent hook subprocess's progress is never
 *  clobbered by a blind overwrite (upload-state.ts's `commit()` does the same
 *  read-merge-write for the same reason). `nextFindingSeq` only needs to stay
 *  monotonic going forward — it never renames a findingId already minted from
 *  a lower value — so the max is always safe. `lastFyi` is a per-key cooldown
 *  clock: the max timestamp per key is the correct merge, since an earlier
 *  timestamp can never un-expire a throttle the other writer already started. */
export function mergeCooldownState(local: CooldownState, onDisk: CooldownState): CooldownState {
  const lastFyi: Record<string, number> = { ...onDisk.lastFyi };
  for (const [key, ts] of Object.entries(local.lastFyi)) {
    lastFyi[key] = Math.max(lastFyi[key] ?? 0, ts);
  }
  return {
    nextFindingSeq: Math.max(local.nextFindingSeq, onDisk.nextFindingSeq),
    lastFyi,
  };
}

/**
 * The agent-facing line for a duplicate. Names BOTH sides: the function the
 * agent just wrote (from the query site that saw the match) and the indexed
 * counterpart. The old copy named only the counterpart; on a real session the
 * agent, told "duplicates daysInMonth", removed a different function than the
 * one the detector had anchored, and the finding could never close. When only
 * the whole-file query matched there is no single construct to name, so the
 * line says "this edit".
 */
export function formatDuplicateAdvisory(a: {
  file: string;
  findingId: string;
  site: AnchorSite | undefined;
  counterpart: { name: string; path: string; line: number };
  similarity: number;
}): string {
  const mine =
    a.site?.kind === "function" && a.site.symbol
      ? `your ${a.site.symbol} (${a.file}${a.site.line !== undefined ? `:${a.site.line}` : ""})`
      : "this edit";
  return (
    `[vibedrift] flagged ${a.file} (${a.findingId}): ${mine} duplicates ${a.counterpart.name} ` +
    `(${a.counterpart.path}:${a.counterpart.line}), ${a.similarity.toFixed(2)} similar; prefer importing it.`
  );
}

export interface EditCheckOptions {
  rootDir: string;
  projectHash: string;
  sessionId: string;
  sessionsDir: string;
  file: string;
  body: string;
  loadBaselineFor?: (rootDir: string) => Promise<RepoDriftBaseline | null>;
  now?: () => number;
}

export interface EditCheckOutcome {
  flags: SessionEvent[];
  fyi: string | null;
  /** the baseline that was loaded (if any), so callers can reuse it for the
   *  finding-scoped outcome re-check without loading it twice */
  baseline: RepoDriftBaseline | null;
  /** findingId to the construct the finding was raised against. Local only:
   *  this feeds the session's outcome sidecar and is never part of an event. */
  anchors: Record<string, FindingAnchor>;
  /** true only when the drift detection actually RAN on this edit (flagged or
   *  clean); false when it was skipped (missing/oversized baseline, load or
   *  detect error). The honest denominator for drift density (P1.7). */
  checked: boolean;
}

function statePath(opts: EditCheckOptions): string {
  return join(
    opts.sessionsDir,
    safeSegment(opts.projectHash),
    `${safeSegment(opts.sessionId)}.cooldown.json`,
  );
}

async function readState(opts: EditCheckOptions): Promise<CooldownState> {
  try {
    const raw = await readFile(statePath(opts), "utf8");
    const parsed = JSON.parse(raw) as Partial<CooldownState>;
    return {
      nextFindingSeq: typeof parsed.nextFindingSeq === "number" ? parsed.nextFindingSeq : 1,
      lastFyi: parsed.lastFyi && typeof parsed.lastFyi === "object" ? parsed.lastFyi : {},
    };
  } catch {
    return { nextFindingSeq: 1, lastFyi: {} };
  }
}

async function writeState(opts: EditCheckOptions, state: CooldownState): Promise<void> {
  try {
    // Read-merge-write (not a blind overwrite): a concurrent hook subprocess
    // for the same session may have advanced nextFindingSeq or started a
    // cooldown on a key this call never touched between our read and this
    // write. Re-reading here and merging keeps that progress instead of
    // losing it (see mergeCooldownState).
    const onDisk = await readState(opts);
    const merged = mergeCooldownState(state, onDisk);
    await writeFileAtomic(statePath(opts), JSON.stringify(merged), { mode: 0o600 });
  } catch {
    // cooldown is best-effort; losing it degrades to an extra FYI, never a failure
  }
}

/** Stat-gate for the hook path's baseline read: it runs ahead of the ledger
 *  append and the 2s watchdog cannot preempt a synchronous JSON.parse, so an
 *  oversized cache is a skip (checked=false), never a session stall. Far
 *  above any baseline the inline entry gate would accept anyway. */
const HOOK_BASELINE_MAX_BYTES = 8 * 1024 * 1024;

/** Read a file for counterpart verification. Null on any failure, which the
 *  verifier treats as fail-open. */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// Test-only re-export (kept at module scope, tree-shaken from the bundle):
// the read-merge-write is only observable when the disk changes between a
// caller's read and its write, which no public entry point can interleave.
export const __test_writeCooldownState = writeState;

export async function runEditChecks(opts: EditCheckOptions): Promise<EditCheckOutcome> {
  const load = opts.loadBaselineFor ?? ((rootDir: string) => loadBaselineUnchecked(rootDir, HOOK_BASELINE_MAX_BYTES));
  const now = opts.now ?? Date.now;

  let baseline: RepoDriftBaseline | null;
  try {
    baseline = await load(opts.rootDir);
  } catch {
    return { flags: [], fyi: null, baseline: null, anchors: {}, checked: false };
  }
  if (!baseline || baseline.minhashIndex.length > INLINE_CHECK_MAX_ENTRIES) {
    return { flags: [], fyi: null, baseline: null, anchors: {}, checked: false };
  }

  // Forward slashes on every platform: the baseline stores its relative paths
  // that way (core/discovery.ts) and so does the edit event the hook records,
  // so a Windows separator here would both miss the baseline and hash a flag to
  // a different file pseudonym than its own edit.
  const relPath = relative(opts.rootDir, opts.file).replace(/\\/g, "/") || opts.file;

  // Non-code is a skip class (P1 contract): prose and config bodies would
  // dilute the checked-edit denominator, and a code snippet quoted inside
  // docs must not flag. The gate and the flag path exit together — stamping
  // checked=false while still flagging would orphan flags outside the
  // density denominator.
  //
  // isInLoopCheckable extends the same contract to test setup, seeds, scripts,
  // examples and scratch files. An agent writes those to different conventions
  // on purpose, so judging them against application conventions is measurably
  // wrong: 8 of 21 findings in the recorded population landed on such files and
  // every one was a false positive.
  if (detectLanguage(relPath) === null || !isInLoopCheckable(relPath)) {
    return { flags: [], fyi: null, baseline, anchors: {}, checked: false };
  }

  let detected: ReturnType<typeof detectDrift>;
  try {
    detected = detectDrift(baseline, relPath, opts.body);
  } catch {
    // the check errored, so it did NOT run — never report an errored edit as checked
    return { flags: [], fyi: null, baseline, anchors: {}, checked: false };
  }
  const conflictsByDim = detected.conflicts;
  const dupsByLoc = detected.dups;

  const state = await readState(opts);
  const flags: SessionEvent[] = [];
  const anchors: Record<string, FindingAnchor> = {};
  const candidates: AdvisoryCandidate[] = [];

  const mkFlag = (detail: SessionEvent["detail"]): SessionEvent => ({
    v: SESSIONS_SCHEMA_VERSION,
    sid: opts.sessionId,
    aid: newActivityId(),
    ts: new Date().toISOString(),
    agent: "claude-code",
    projectHash: opts.projectHash,
    channel: "hook",
    type: "flag",
    mode: "passive",
    findingId: `DF-${state.nextFindingSeq++}`,
    detail,
    outcome: null,
  });

  for (const [dimension, c] of conflictsByDim) {
    const event = mkFlag({
      file: relPath,
      category: dimension,
      dominant: c.dominantPattern,
      observed: c.yourPattern,
    });
    flags.push(event);
    const site = detected.conflictSites.get(dimension);
    if (site && event.findingId) anchors[event.findingId] = { ...site, observed: c.yourPattern };
    candidates.push({
      key: `${relPath}|${dimension}`,
      message: `[vibedrift] flagged ${relPath} (${event.findingId}): ${c.fixHint}`,
      event,
    });
  }

  // Verify the counterpart before citing it. The index is built once per
  // session, so by now the function it names may have moved or been lifted out
  // entirely — in which case the agent MOVED this code rather than duplicating
  // it, and "prefer importing it" would point at a file it just emptied.
  // Measured on a recorded session: this is every duplicate advisory that
  // session produced. See src/session/counterpart.ts.
  const topDup = [...dupsByLoc.values()].sort((a, b) => b.similarity - a.similarity)[0];
  const dupStatus = topDup
    ? verifyCounterpart({
        name: topDup.name,
        relativePath: topDup.relativePath,
        line: topDup.line,
        fileContent: await readFileOrNull(join(opts.rootDir, topDup.relativePath)),
        language: detectLanguage(topDup.relativePath),
      })
    : null;
  if (topDup && dupStatus && dupStatus.status !== "gone") {
    const where = `${topDup.relativePath}:${dupStatus.line}`;
    const event = mkFlag({
      file: relPath,
      category: "redundancy",
      similarTo: where,
      similarity: topDup.similarity,
    });
    flags.push(event);
    const site = detected.dupSites.get(where);
    if (site && event.findingId) anchors[event.findingId] = { ...site, observed: where };
    candidates.push({
      key: `${relPath}|redundancy`,
      message: formatDuplicateAdvisory({
        file: relPath,
        findingId: event.findingId ?? "DF-?",
        site,
        counterpart: { name: topDup.name, path: topDup.relativePath, line: dupStatus.line },
        similarity: topDup.similarity,
      }),
      event,
    });
  }

  let fyi: string | null = null;
  const t = now();
  for (const cand of rankAdvisoryCandidates(candidates)) {
    const last = state.lastFyi[cand.key];
    if (last !== undefined && t - last < COOLDOWN_MS) continue;
    state.lastFyi[cand.key] = t;
    // The recorded msgToAgent is the exact text delivered, ask included.
    cand.event.msgToAgent = cand.message + ADVISORY_ASK;
    fyi = cand.event.msgToAgent;
    break;
  }

  if (flags.length > 0) await writeState(opts, state);
  return { flags, fyi, baseline, anchors, checked: true };
}
