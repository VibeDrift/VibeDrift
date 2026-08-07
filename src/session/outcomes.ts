/**
 * Finding-scoped outcomes (Phase 4): a finding resolves only when the construct
 * it was actually raised against is gone from the file — never because some
 * unrelated file was edited, and never because a classifier went quiet. The
 * re-check is triggered by an edit to the finding's own file: every function in
 * the file's current content is indexed once, and each open finding is measured
 * against its own anchor (see finding-anchor.ts). Scope findings are
 * experimental and not auto-resolved here. Revert detection is byte-exact and
 * best-effort (a formatter changes bytes, so it never false-positives) and
 * stays out of the resolution rate.
 *
 * Known limits, stated plainly so nobody reads the resolved count as complete:
 *  - A RESOLVE IS ABOUT ONE CONSTRUCT, NOT THE FILE. The hook keeps at most one
 *    open finding per (file, category): a second flag of the same category on
 *    the same file is deduped away and never becomes an open finding (see
 *    hook-entry.ts). So a file can hold several constructs carrying the same
 *    flagged pattern while only the first is anchored, and resolving that one
 *    fires a resolve event for the file+category while the unflagged siblings
 *    still carry the identical pattern. Read a resolve as "the construct that
 *    was flagged is gone", never as "this file is clean".
 *  - a RENAMED file is never re-checked; the re-check matches on the exact path
 *    the finding was raised on, so the finding stays open under the old name.
 *  - a fix applied by something the hook does not observe (a shell rewrite, a
 *    formatter, an editor outside the agent) never triggers a re-check at all,
 *    so the self-corrected count is structurally an undercount.
 *  - a function that is renamed AND rewritten in one step is indistinguishable
 *    from a deleted one by name, and its token sequence no longer matches, so
 *    all that holds its finding open is the file-wide presence check; it
 *    resolves once the flagged pattern is nowhere in the file, and if the
 *    rewrite kept the pattern the same edit raises it again.
 *  - the containment test errs toward keeping findings open: a short, generic
 *    token sequence that happens to recur elsewhere in the file holds its
 *    finding open even after the flagged construct was fixed. That is the
 *    intended direction (a stale open finding costs a re-flag; a false resolve
 *    costs the user's trust), but it means "still open" is weaker evidence than
 *    "resolved".
 *  - an anchor with no stored token sequence (the sidecar is parsed without
 *    field validation, so a truncated or hand-edited one can lack it) has
 *    nothing to test containment against, and its missing-symbol case falls
 *    back to the file-wide presence check alone.
 *  - scope findings never auto-resolve.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fileConstructs,
  signalPresent,
  tokensContainedIn,
  ANCHOR_MAX_TOKENS,
  type FindingAnchor,
} from "./finding-anchor.js";
import { safeSegment } from "./ledger.js";
import type { RepoDriftBaseline } from "../core/baseline.js";

export interface OpenFinding {
  findingId: string;
  file: string;
  category: string;
  /** the construct this finding was raised against. Absent on findings carried
   *  over from a session that predates anchoring; those never auto-resolve,
   *  because absence cannot be established for a construct that was never
   *  identified. */
  anchor?: FindingAnchor;
}

export interface OutcomeState {
  open: OpenFinding[];
  /** recent body hashes per file, for byte-exact revert detection */
  hashes: Record<string, string[]>;
}

const MAX_HASHES_PER_FILE = 20;

export function emptyOutcomeState(): OutcomeState {
  return { open: [], hashes: {} };
}

/**
 * Return the open findings on this file whose anchored construct is positively
 * gone from the file's CURRENT full content (not the edit hunk, so a finding on
 * a function the edit never touched cannot resolve).
 *
 * A finding resolves in exactly two ways: the construct it was raised against
 * is still in the file but no longer carries the pattern that was flagged, or
 * that construct is gone — its token sequence is nowhere in the file — AND the
 * pattern is absent from the whole file. A vanished NAME is never enough on its
 * own, because only top-level `function`/`const` forms are indexed and a move
 * into a class or an object literal would otherwise clear a finding whose code
 * is untouched. It never resolves because a classifier declined to answer: the
 * file's functions are indexed uncapped here, so a construct past the flag
 * path's query cap is still found, and presence is asked per construct, so a
 * majority elsewhere in the file cannot outvote it.
 *
 * Fail-open throughout: an unreadable file, an unknown language, an unanchored
 * finding, or any thrown error leaves findings OPEN rather than falsely
 * clearing them.
 */
export function recheckFile(
  baseline: RepoDriftBaseline,
  relFile: string,
  content: string,
  open: OpenFinding[],
): { resolved: OpenFinding[] } {
  const here = open.filter((f) => f.file === relFile && f.category !== "scope");
  if (here.length === 0) return { resolved: [] };

  // Indexed ONCE for the whole re-check: per-finding extraction would be
  // functions x findings work on a path with a hard time budget.
  let constructs: ReturnType<typeof fileConstructs>;
  try {
    constructs = fileConstructs(relFile, content);
  } catch {
    return { resolved: [] };
  }
  if (!constructs) return { resolved: [] };

  const resolved: OpenFinding[] = [];
  for (const f of here) {
    const anchor = f.anchor;
    if (!anchor) continue;
    try {
      // Byte-for-byte (modulo formatting and comments) still in the file.
      if (constructs.hashes.has(anchor.tokenHash)) continue;

      if (anchor.kind === "function" && anchor.symbol) {
        const body = constructs.bodies.get(anchor.symbol);
        if (body === undefined) {
          // A missing symbol is NOT proof the code is gone. Only top-level
          // `function`/`const` forms are indexed, so moving the flagged
          // function into a class or an object literal drops the name from the
          // index while the flagged code sits byte-identical on disk.
          //
          // First ask the question that survives wrapping: is the construct's
          // own token sequence still EXACTLY somewhere in this file? If it is,
          // the code moved rather than went away, and the finding stays open no
          // matter what any pattern predicate says. This is an exact-sequence
          // fast path; a clone that was wrapped AND cosmetically edited by even
          // one token slips past it, so the fall-through presence predicate is
          // what has to catch that. For redundancy that predicate is raw-token
          // shingle containment OR'd with the whole-file duplicate query (see
          // signalPresent): containment catches the wrap plus one-token edit the
          // query used to dilute away, and the query catches the all-identifier
          // rename or over-long clone that containment misses (#86).
          // Only a COMPLETE sequence is evidence the construct is unchanged. A
          // capped one holds the first ANCHOR_MAX_TOKENS tokens, so containment
          // proves the prefix survived, not that the flagged pattern did: in a
          // long function the pattern often sits past the cap, and a genuine fix
          // there would otherwise hold the finding open forever.
          const whole = (anchor.tokens?.length ?? 0) < ANCHOR_MAX_TOKENS;
          if (whole && tokensContainedIn(anchor.tokens, content)) continue;
          // Not contained exactly: fall back to the presence predicate over the
          // whole file, so a renamed-and-reshaped construct still has to have
          // dropped the flagged pattern (or its clone) before anything resolves.
          if (!signalPresent(f.category, anchor, content, relFile, baseline)) resolved.push(f);
          continue;
        }
        if (!signalPresent(f.category, anchor, body, relFile, baseline)) resolved.push(f);
        continue;
      }

      // A whole-body anchor (an edit that held no extractable function): ask the
      // presence predicate over the whole file, which is a superset of what was
      // flagged, so it errs toward keeping the finding open.
      if (!signalPresent(f.category, anchor, content, relFile, baseline)) resolved.push(f);
    } catch {
      // this finding stays open
    }
  }
  return { resolved };
}

export function detectRevert(
  relFile: string,
  body: string,
  hashes: Record<string, string[]>,
): { reverted: boolean } {
  const h = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const seen = hashes[relFile] ?? [];
  const reverted = seen.includes(h);
  const next = [...seen, h].slice(-MAX_HASHES_PER_FILE);
  hashes[relFile] = next;
  return { reverted };
}

function statePath(sessionsDir: string, projectHash: string, sessionId: string): string {
  return join(sessionsDir, safeSegment(projectHash), `${safeSegment(sessionId)}.outcomes.json`);
}

export async function readOutcomeState(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
): Promise<OutcomeState> {
  try {
    const raw = await readFile(statePath(sessionsDir, projectHash, sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<OutcomeState>;
    return {
      open: Array.isArray(parsed.open) ? parsed.open : [],
      hashes: parsed.hashes && typeof parsed.hashes === "object" ? parsed.hashes : {},
    };
  } catch {
    return emptyOutcomeState();
  }
}

export async function writeOutcomeState(
  sessionsDir: string,
  projectHash: string,
  sessionId: string,
  state: OutcomeState,
): Promise<void> {
  try {
    await mkdir(join(sessionsDir, safeSegment(projectHash)), { recursive: true, mode: 0o700 });
    await writeFile(statePath(sessionsDir, projectHash, sessionId), JSON.stringify(state), { mode: 0o600 });
  } catch {
    // best-effort; losing outcome state degrades to "flags stay open", never a failure
  }
}
