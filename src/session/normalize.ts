/**
 * Normalize a Claude Code hook stdin payload into a SessionEvent, or null for
 * anything we do not record (fail-open: unknown means ignore, never error).
 *
 * Data-minimization invariants:
 * - prompt text is secret-masked before it ever reaches a SessionEvent;
 * - Bash commands are recorded as a bare `command` event with no command text;
 * - the transcript_path in the payload is deliberately never read.
 */

import { maskSecrets } from "./mask.js";
import { newActivityId } from "./ledger.js";
import { SESSIONS_SCHEMA_VERSION } from "./types.js";
import type { SessionEvent, SessionEventDetail } from "./types.js";

export const EDIT_TOOLS = ["Edit", "Write", "MultiEdit"] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function countLines(body: string): number {
  const s = body.endsWith("\n") ? body.slice(0, -1) : body;
  return s.length === 0 ? 0 : s.split("\n").length;
}

export function extractEditedBody(
  toolName: string,
  toolInput: Record<string, unknown>,
): { file?: string; body?: string; diffstat?: string } | null {
  const file = asString(toolInput.file_path) ?? undefined;
  if (toolName === "Edit") {
    const body = asString(toolInput.new_string) ?? "";
    return { file, body, diffstat: `+${countLines(body)}` };
  }
  if (toolName === "Write") {
    const body = asString(toolInput.content) ?? asString(toolInput.file_text) ?? "";
    return { file, body, diffstat: `+${countLines(body)}` };
  }
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    const parts: string[] = [];
    for (const e of edits) {
      const rec = asRecord(e);
      const s = rec ? asString(rec.new_string) : null;
      if (s) parts.push(s);
    }
    const body = parts.join("\n");
    return { file, body, diffstat: `+${countLines(body)}` };
  }
  return null;
}

export function normalizeHookPayload(
  raw: unknown,
  ctx: { projectHash: string },
): (SessionEvent & { body?: string }) | null {
  const p = asRecord(raw);
  if (!p) return null;
  const sid = asString(p.session_id);
  const eventName = asString(p.hook_event_name);
  if (!sid || !eventName) return null;

  const mk = (
    type: SessionEvent["type"],
    detail: SessionEventDetail,
    body?: string,
  ): SessionEvent & { body?: string } => ({
    v: SESSIONS_SCHEMA_VERSION,
    sid,
    aid: newActivityId(),
    ts: new Date().toISOString(),
    agent: "claude-code",
    projectHash: ctx.projectHash,
    channel: "hook",
    type,
    mode: "passive",
    detail,
    ...(body !== undefined ? { body } : {}),
  });

  if (eventName === "SessionStart") return mk("session_start", {});
  if (eventName === "Stop" || eventName === "SessionEnd") return mk("session_end", {});

  if (eventName === "UserPromptSubmit") {
    const prompt = asString(p.prompt) ?? asString(p.user_prompt);
    if (!prompt) return null;
    return mk("user_prompt", { promptText: maskSecrets(prompt) });
  }

  if (eventName === "PostToolUse") {
    const toolName = asString(p.tool_name);
    const toolInput = asRecord(p.tool_input);
    if (!toolName) return null;
    if ((EDIT_TOOLS as readonly string[]).includes(toolName) && toolInput) {
      const ext = extractEditedBody(toolName, toolInput);
      if (!ext) return null;
      return mk("edit", { file: ext.file, toolName, diffstat: ext.diffstat }, ext.body);
    }
    if (toolName === "Bash") return mk("command", { toolName });
    return null;
  }

  return null;
}
