/**
 * The session's scope index: which repos one sitting recorded into.
 *
 * A session that edits several repos writes one ledger per repo, keyed by that
 * repo's project hash. The hash is derived from the repo's path and cannot be
 * turned back into one, and the ledger deliberately never carries a machine
 * path — so at the end of a turn nothing knows WHERE those repos are. The Stop
 * hook needs exactly that to learn a repo's patterns in the background, which
 * is what this sidecar carries.
 *
 * Local-only by construction: it sits beside the ledgers under the VibeDrift
 * home, it is not a `.jsonl` file, and every path that ships anything reads
 * `*.jsonl` only (the upload follower and the flush-target scan). Nothing here
 * is ever uploaded.
 *
 * Bounded, atomic and fail-open, like every other per-session sidecar: at most
 * MAX_SESSION_SCOPES entries, written through the shared atomic writer, and
 * every error swallowed — a lost index only means a background rebuild is
 * skipped, never a failed hook.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { safeSegment } from "./ledger.js";

/** A session touching more repos than this in one sitting is not a workspace,
 *  it is a runaway; the cap keeps the sidecar (and the Stop-time work it
 *  drives) bounded. */
export const MAX_SESSION_SCOPES = 32;

/** One repo a session recorded into: the ledger key plus where it lives. */
export interface RecordedScope {
  projectHash: string;
  rootDir: string;
}

interface SerializedScopes {
  v: 1;
  scopes: RecordedScope[];
}

export function sessionScopesPath(sessionsDir: string, workspaceHash: string, sessionId: string): string {
  return join(sessionsDir, safeSegment(workspaceHash), `${safeSegment(sessionId)}.scopes.json`);
}

export async function readSessionScopes(
  sessionsDir: string,
  workspaceHash: string,
  sessionId: string,
): Promise<RecordedScope[]> {
  try {
    const raw = await readFile(sessionScopesPath(sessionsDir, workspaceHash, sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<SerializedScopes>;
    if (!Array.isArray(parsed.scopes)) return [];
    return parsed.scopes.filter(
      (s): s is RecordedScope =>
        !!s && typeof s.projectHash === "string" && typeof s.rootDir === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Remember that this session recorded into a repo. Idempotent per project hash
 * and read-merge-write, so two hook subprocesses for the same session never
 * clobber each other's entries (the same reason the cooldown and outcome
 * sidecars merge rather than overwrite).
 */
export async function recordSessionScope(
  sessionsDir: string,
  workspaceHash: string,
  sessionId: string,
  scope: RecordedScope,
): Promise<void> {
  try {
    const known = await readSessionScopes(sessionsDir, workspaceHash, sessionId);
    if (known.some((s) => s.projectHash === scope.projectHash)) return;
    if (known.length >= MAX_SESSION_SCOPES) return;
    const next: SerializedScopes = { v: 1, scopes: [...known, scope] };
    await mkdir(join(sessionsDir, safeSegment(workspaceHash)), { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      sessionScopesPath(sessionsDir, workspaceHash, sessionId),
      JSON.stringify(next),
      { mode: 0o600 },
    );
  } catch {
    // best-effort: a missing index only costs a background baseline build
  }
}
