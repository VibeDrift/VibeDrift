/**
 * Tee an MCP tool's verdict into the active session ledger, so the agent asking
 * VibeDrift (via MCP) and VibeDrift flagging the agent (via hooks) read as one
 * dialogue. Correlated by project hash: the verdict joins the most-recently
 * active session for the repo. No active session -> no-op. Fail-open.
 */

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectHash, canonicalizeRoot } from "../core/baseline.js";
import { appendEvent, newActivityId, parseJsonlLines, safeSegment } from "./ledger.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent } from "./types.js";

/** A session is "active" if its ledger was touched within this window.
 *
 *  15 minutes, deliberately equal to the dashboard's live-session freshness
 *  window: a session the dashboard still shows as live must never be refused
 *  by the paths that gate on activity. Both call sites share this one bound —
 *  the MCP verdict tee (teeMcpVerdict, below) and decision capture
 *  (recordFlagDecision in src/session/decision.ts, via listActiveSessions).
 *  If the dashboard window ever changes, change this with it. */
export const SESSION_ACTIVE_WINDOW_MS = 15 * 60_000;

export interface TeeOptions {
  sessionsDir: string;
  rootDir: string;
  tool: string;
  ask: string;
  verdict: string;
  now?: () => number;
}

/** Every ledger in `dir` touched within `windowMs`, newest-first. Shared by the
 *  MCP tee (which takes the newest) and decision capture (which scans them for
 *  the one that raised a given finding). Fail-open: an unreadable dir is []. */
export async function listActiveSessions(
  dir: string,
  now: number,
  windowMs: number = SESSION_ACTIVE_WINDOW_MS,
): Promise<Array<{ sid: string; mtime: number }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ sid: string; mtime: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const s = await stat(join(dir, name));
      if (now - s.mtimeMs > windowMs) continue;
      out.push({ sid: name.slice(0, -".jsonl".length), mtime: s.mtimeMs });
    } catch {
      // vanished; skip
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** How much of a ledger's tail to read looking for the scope's workspace key.
 *  A read, not a parse of the whole file: a long session's ledger runs to
 *  megabytes and an MCP tool call should not pay for that. */
const TAIL_BYTES = 16 * 1024;

/**
 * The workspace this scope's events already carry, if any.
 *
 * An MCP verdict joins the ledger of the repo the tool was asked about, which
 * is the same repo that owns an edit to one of its files — the tee has followed
 * the per-repo rule all along, because the tools take a rootDir. What it cannot
 * know on its own is whether that repo is part of a wider sitting, so it reads
 * the answer off the events already in the ledger rather than inventing one.
 * Absent (a single-repo session, or a scope whose events predate the field)
 * simply means nothing is stamped, which reads as "its own workspace".
 *
 * Fail-open: any error means no stamp.
 */
async function workspaceKeyOf(filePath: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    // The first line of a mid-file read is usually a fragment; parseJsonlLines
    // drops what will not parse, which is exactly the right behaviour here.
    for (const ev of parseJsonlLines(buf.toString("utf8")).reverse()) {
      if (typeof ev.workspaceKey === "string" && ev.workspaceKey.length > 0) return ev.workspaceKey;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function activeSession(
  dir: string,
  now: number,
): Promise<{ sid: string; mtime: number } | null> {
  return (await listActiveSessions(dir, now))[0] ?? null;
}

export async function teeMcpVerdict(opts: TeeOptions): Promise<void> {
  try {
    const now = (opts.now ?? Date.now)();
    const hash = projectHash(canonicalizeRoot(opts.rootDir));
    const dir = join(opts.sessionsDir, safeSegment(hash));
    const session = await activeSession(dir, now);
    if (!session) return;

    const workspaceKey = await workspaceKeyOf(join(dir, `${safeSegment(session.sid)}.jsonl`));

    const mk = (type: SessionEvent["type"], detail: SessionEvent["detail"], channel: "mcp"): SessionEvent => ({
      v: SESSIONS_SCHEMA_VERSION,
      sid: session.sid,
      aid: newActivityId(),
      ts: new Date().toISOString(),
      agent: "claude-code",
      projectHash: hash,
      ...(workspaceKey ? { workspaceKey } : {}),
      channel,
      type,
      mode: "passive",
      detail,
    });

    await appendEvent(opts.sessionsDir, hash, session.sid, mk("mcp_ask", { toolName: opts.tool, promptText: opts.ask }, "mcp"));
    await appendEvent(opts.sessionsDir, hash, session.sid, mk("mcp_verdict", { toolName: opts.tool, observed: opts.verdict }, "mcp"));
  } catch {
    // teeing is best-effort; never break the MCP tool
  }
}
