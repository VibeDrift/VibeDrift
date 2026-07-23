/**
 * Finding-scoped outcomes (Phase 4): a finding resolves only when the SAME
 * finding re-runs over its actual inputs and passes — never because some
 * unrelated file was edited. Re-check is triggered by an edit to the finding's
 * own file: the new body is re-validated, and an open convention/redundancy
 * finding whose signal no longer fires is resolved. Scope findings are
 * experimental and not auto-resolved here. Revert detection is byte-exact and
 * best-effort (a formatter changes bytes, so it never false-positives) and
 * stays out of the resolution rate.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectDrift } from "./detect.js";
import { safeSegment } from "./ledger.js";
import type { RepoDriftBaseline } from "../core/baseline.js";

export interface OpenFinding {
  findingId: string;
  file: string;
  category: string;
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

/** Re-run the drift detection over the file's CURRENT full content (not the
 *  edit hunk) using the SAME multi-query decomposition the flag path uses, and
 *  return the open findings on that file whose signal is genuinely gone. Using
 *  the same detection avoids the dilution trap where a whole-body query misses
 *  a per-function duplicate; using the full file (not the hunk) avoids resolving
 *  a finding on a function the current edit did not even touch. Fail-open: on
 *  any error nothing resolves (a finding stays open rather than falsely clears). */
export function recheckFile(
  baseline: RepoDriftBaseline,
  relFile: string,
  content: string,
  open: OpenFinding[],
): { resolved: OpenFinding[] } {
  const here = open.filter((f) => f.file === relFile && f.category !== "scope");
  if (here.length === 0) return { resolved: [] };

  let conflictDims: Set<string>;
  let hasDup: boolean;
  try {
    const d = detectDrift(baseline, relFile, content);
    conflictDims = new Set(d.conflicts.keys());
    hasDup = d.dups.size > 0;
  } catch {
    return { resolved: [] };
  }

  const resolved = here.filter((f) =>
    f.category === "redundancy" ? !hasDup : !conflictDims.has(f.category),
  );
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
