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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadBaselineUnchecked, type RepoDriftBaseline } from "../core/baseline.js";
import { detectDrift } from "./detect.js";
import { newActivityId, safeSegment } from "./ledger.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent } from "./types.js";

export const INLINE_CHECK_MAX_ENTRIES = 2000;
export const COOLDOWN_MS = 5 * 60_000;

interface CooldownState {
  nextFindingSeq: number;
  lastFyi: Record<string, number>;
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
    await mkdir(join(opts.sessionsDir, safeSegment(opts.projectHash)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(statePath(opts), JSON.stringify(state), { mode: 0o600 });
  } catch {
    // cooldown is best-effort; losing it degrades to an extra FYI, never a failure
  }
}

export async function runEditChecks(opts: EditCheckOptions): Promise<EditCheckOutcome> {
  const load = opts.loadBaselineFor ?? loadBaselineUnchecked;
  const now = opts.now ?? Date.now;

  let baseline: RepoDriftBaseline | null;
  try {
    baseline = await load(opts.rootDir);
  } catch {
    return { flags: [], fyi: null, baseline: null };
  }
  if (!baseline || baseline.minhashIndex.length > INLINE_CHECK_MAX_ENTRIES) {
    return { flags: [], fyi: null, baseline: null };
  }

  const relPath = relative(opts.rootDir, opts.file) || opts.file;

  let conflictsByDim: Map<string, { dominantPattern: string; yourPattern: string; fixHint: string }>;
  let dupsByLoc: Map<string, { relativePath: string; name: string; line: number; similarity: number }>;
  try {
    const detected = detectDrift(baseline, relPath, opts.body);
    conflictsByDim = detected.conflicts;
    dupsByLoc = detected.dups;
  } catch {
    return { flags: [], fyi: null, baseline };
  }

  const state = await readState(opts);
  const flags: SessionEvent[] = [];
  const candidates: Array<{ key: string; message: string; event: SessionEvent }> = [];

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
    candidates.push({
      key: `${relPath}|${dimension}`,
      message: `[vibedrift] flagged ${relPath} (${event.findingId}): ${c.fixHint}`,
      event,
    });
  }

  const topDup = [...dupsByLoc.values()].sort((a, b) => b.similarity - a.similarity)[0];
  if (topDup) {
    const where = `${topDup.relativePath}:${topDup.line}`;
    const event = mkFlag({
      file: relPath,
      category: "redundancy",
      similarTo: where,
      similarity: topDup.similarity,
    });
    flags.push(event);
    candidates.push({
      key: `${relPath}|redundancy`,
      message: `[vibedrift] flagged ${relPath} (${event.findingId}): new function duplicates ${topDup.name} at ${where} (${topDup.similarity.toFixed(2)} similar); prefer importing it.`,
      event,
    });
  }

  let fyi: string | null = null;
  const t = now();
  for (const cand of candidates) {
    const last = state.lastFyi[cand.key];
    if (last !== undefined && t - last < COOLDOWN_MS) continue;
    state.lastFyi[cand.key] = t;
    cand.event.msgToAgent = cand.message;
    fyi = cand.message;
    break;
  }

  if (flags.length > 0) await writeState(opts, state);
  return { flags, fyi, baseline };
}
