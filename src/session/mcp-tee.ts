/**
 * Tee an MCP tool's verdict into the active session ledger, so the agent asking
 * VibeDrift (via MCP) and VibeDrift flagging the agent (via hooks) read as one
 * dialogue. Correlated by project hash: the verdict joins the most-recently
 * active session for the repo. No active session -> no-op. Fail-open.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { projectHash, canonicalizeRoot } from "../core/baseline.js";
import { appendEvent, newActivityId, safeSegment } from "./ledger.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent } from "./types.js";

/** A session is "active" if its ledger was touched within this window. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

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
  windowMs: number = ACTIVE_WINDOW_MS,
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

    const mk = (type: SessionEvent["type"], detail: SessionEvent["detail"], channel: "mcp"): SessionEvent => ({
      v: SESSIONS_SCHEMA_VERSION,
      sid: session.sid,
      aid: newActivityId(),
      ts: new Date().toISOString(),
      agent: "claude-code",
      projectHash: hash,
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
