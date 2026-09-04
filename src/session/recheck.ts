/**
 * Re-check a project's OPEN session findings against the tree as it stands
 * now, and record the ones whose flagged construct is positively gone.
 *
 * Why this exists: a finding resolves in-loop only when a later hook-visible
 * edit of the same file drops the anchored construct. On a recorded session
 * every fix went through Bash before the hook watched Bash, so 21 findings
 * sat "open, no call recorded" whatever had happened to them since. This is
 * the honest close-out for such a backlog: the same finding-scoped predicate
 * the hook uses (`recheckFile`), over each file's current content, never a
 * guess. Honest cuts both ways: on that session 2 of the 21 clear, and the
 * other 19 stay open because their flagged code is still on disk.
 *
 * What it is NOT: an in-loop fix. Every resolve it appends carries
 * `detail.via = "recheck"`, and consumers count those apart from the hook's
 * own resolves, so "fixed · verified" keeps meaning "the agent's next edit
 * cleared it".
 *
 * Fail-open per finding: an unreadable or missing file leaves its findings
 * open and is reported, never resolved by absence of the file.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoDriftBaseline } from "../core/baseline.js";
import { appendEvent, newActivityId, safeSegment } from "./ledger.js";
import { readOutcomeState, recheckFile, writeOutcomeState, type OpenFinding } from "./outcomes.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent } from "./types.js";

export const RECHECK_VIA = "recheck" as const;

export interface RecheckSessionResult {
  sessionId: string;
  resolved: OpenFinding[];
  stillOpen: OpenFinding[];
  /** files an open finding points at that could not be read (left open) */
  missingFiles: string[];
}

export interface RecheckProjectOptions {
  rootDir: string;
  projectHash: string;
  sessionsDir: string;
  baseline: RepoDriftBaseline;
  /** restrict to one session id; default every session with open findings */
  sessionId?: string;
  /** report only; append nothing, rewrite no sidecar */
  dryRun?: boolean;
  now?: () => Date;
  readFileText?: (abs: string) => Promise<string>;
}

/** Session ids that have an outcome sidecar under this project. */
export async function sessionsWithOutcomes(sessionsDir: string, projectHash: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(sessionsDir, safeSegment(projectHash)));
  } catch {
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith(".outcomes.json"))
    .map((n) => n.slice(0, -".outcomes.json".length));
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ids;
}

export async function recheckProject(opts: RecheckProjectOptions): Promise<RecheckSessionResult[]> {
  const now = opts.now ?? (() => new Date());
  const readText = opts.readFileText ?? ((abs: string) => readFile(abs, "utf8"));
  const ids = opts.sessionId
    ? [opts.sessionId]
    : await sessionsWithOutcomes(opts.sessionsDir, opts.projectHash);

  const out: RecheckSessionResult[] = [];
  for (const sid of ids) {
    const state = await readOutcomeState(opts.sessionsDir, opts.projectHash, sid);
    const open = state.open.filter((f) => f.category !== "scope");
    if (open.length === 0) continue;

    const byFile = new Map<string, OpenFinding[]>();
    for (const f of open) {
      const list = byFile.get(f.file) ?? [];
      list.push(f);
      byFile.set(f.file, list);
    }
    const files = [...byFile.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const resolved: OpenFinding[] = [];
    const missingFiles: string[] = [];
    for (const relFile of files) {
      let content: string;
      try {
        content = await readText(join(opts.rootDir, relFile));
      } catch {
        missingFiles.push(relFile);
        continue;
      }
      // The whole open set is passed, as the hook does; recheckFile filters
      // to this file itself and applies the positive-absence predicate.
      const r = recheckFile(opts.baseline, relFile, content, state.open);
      resolved.push(...r.resolved);
    }

    const resolvedIds = new Set(resolved.map((f) => f.findingId));
    if (!opts.dryRun) {
      for (const f of resolved) {
        const ev: SessionEvent = {
          v: SESSIONS_SCHEMA_VERSION,
          sid,
          aid: newActivityId(),
          ts: now().toISOString(),
          agent: "claude-code",
          projectHash: opts.projectHash,
          channel: "hook",
          type: "resolve",
          mode: "passive",
          findingId: f.findingId,
          detail: { file: f.file, category: f.category, via: RECHECK_VIA },
          outcome: "resolved",
        };
        await appendEvent(opts.sessionsDir, opts.projectHash, sid, ev);
      }
      if (resolved.length > 0) {
        // Tombstone every clear, the same as the hook's own resolve path: the
        // read-merge-write in writeOutcomeState unions `open` with the copy on
        // disk, so without a tombstone this very write would resurrect the
        // finding it is meant to remove.
        await writeOutcomeState(opts.sessionsDir, opts.projectHash, sid, {
          ...state,
          open: state.open.filter((f) => !resolvedIds.has(f.findingId)),
          resolved: [...state.resolved, ...resolvedIds],
        });
      }
    }

    out.push({
      sessionId: sid,
      resolved,
      stillOpen: open.filter((f) => !resolvedIds.has(f.findingId)),
      missingFiles,
    });
  }
  return out;
}
