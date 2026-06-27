/*
 * SCHEMA NOTICE: The parsing logic below is based on the documented Claude Code
 * --output-format stream-json format (stream_event wrappers + raw API events).
 * This MUST be validated against REAL `claude -p --output-format stream-json --verbose`
 * output during the Phase 2 pilot before any confirmatory run. The hand-authored
 * fixtures in test/fixtures/ are SYNTHETIC and may diverge from actual claude CLI
 * output in field names, event ordering, or wrapper structure. Do NOT treat token
 * or cost figures from this parser as accurate until the schema is confirmed live.
 */

import type { PerTurnUsage } from "./types.js";

export interface ParsedUsage {
  /** Cumulative session totals across all 4 token classes (missing fields default to 0). */
  usage: PerTurnUsage;
  /** result.total_cost_usd if present — client-side estimate; recompute separately. */
  reportedCostUsd: number | null;
  /** Count of system/compact_boundary events encountered. */
  compactionEvents: number;
  /** result.num_turns if present, else count of message_start events. */
  turns: number;
  /** Model id from first message_start.message.model, then system-init .model, else null. */
  modelId: string | null;
}

/**
 * Parse the stdout of `claude -p --output-format stream-json --verbose` and
 * extract aggregate token usage for the session.
 *
 * Parsing rules:
 * 1. Lines are newline-split; non-JSON and blank lines are silently skipped.
 * 2. If a parsed object has an `.event` field (stream_event wrapper), both the
 *    outer wrapper and the inner event are considered for all lookups.
 * 3. Authoritative path: the LAST object with type="result" and a usage field
 *    supplies the cumulative totals, reportedCostUsd, and num_turns.
 * 4. Fallback (no result object): sum per-message usage by grouping message_start
 *    and message_delta events; for each message take input/cache from message_start
 *    and output from that message's LAST message_delta (output_tokens is cumulative
 *    within a message, so only the final value is used).
 */
export function parseClaudeUsage(stdout: string): ParsedUsage {
  // ── Step 1: parse all lines ──────────────────────────────────────────────
  // allObjects: outer + inner (for result/compact_boundary/modelId lookups).
  // effectiveEvents: one event per source line (inner if wrapped, else outer)
  //   — used for ordered message grouping in the fallback path.
  const allObjects: Record<string, unknown>[] = [];
  const effectiveEvents: Record<string, unknown>[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // tolerate non-JSON lines
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    allObjects.push(rec);

    const inner = rec.event;
    if (inner !== null && typeof inner === "object") {
      const innerRec = inner as Record<string, unknown>;
      allObjects.push(innerRec);
      effectiveEvents.push(innerRec);
    } else {
      effectiveEvents.push(rec);
    }
  }

  // ── Step 4: count compaction events ─────────────────────────────────────
  let compactionEvents = 0;
  for (const obj of allObjects) {
    if (obj.type === "system" && obj.subtype === "compact_boundary") {
      compactionEvents++;
    }
  }

  // ── Step 5: resolve modelId ──────────────────────────────────────────────
  let modelId: string | null = null;
  for (const obj of allObjects) {
    if (obj.type === "message_start") {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (typeof msg?.model === "string") {
        modelId = msg.model;
        break;
      }
    }
  }
  if (!modelId) {
    for (const obj of allObjects) {
      if (obj.type === "system" && obj.subtype === "init" && typeof obj.model === "string") {
        modelId = obj.model;
        break;
      }
    }
  }

  // ── Step 2: authoritative path (last result with usage) ─────────────────
  let resultObj: Record<string, unknown> | null = null;
  for (const obj of allObjects) {
    if (obj.type === "result" && obj.usage != null) {
      resultObj = obj;
    }
  }

  if (resultObj !== null) {
    const u = resultObj.usage as Record<string, unknown>;
    const usage: PerTurnUsage = {
      input_tokens: toInt(u.input_tokens),
      output_tokens: toInt(u.output_tokens),
      cache_creation_input_tokens: toInt(u.cache_creation_input_tokens),
      cache_read_input_tokens: toInt(u.cache_read_input_tokens),
    };
    return {
      usage,
      reportedCostUsd: typeof resultObj.total_cost_usd === "number" ? resultObj.total_cost_usd : null,
      compactionEvents,
      turns: typeof resultObj.num_turns === "number" ? resultObj.num_turns : countMessageStarts(allObjects),
      modelId,
    };
  }

  // ── Step 3: fallback — sum per-message usage ─────────────────────────────
  // Use effectiveEvents (ordered, one-per-line) to correctly sequence message
  // boundaries and message_delta overwrite behavior.
  interface MessageAccum {
    inputTokens: number;
    cacheCreation: number;
    cacheRead: number;
    lastDeltaOutput: number;
  }

  const messages: MessageAccum[] = [];
  let current: MessageAccum | null = null;

  for (const ev of effectiveEvents) {
    if (ev.type === "message_start") {
      const msgUsage = (ev.message as Record<string, unknown> | undefined)
        ?.usage as Record<string, unknown> | undefined;
      current = {
        inputTokens: toInt(msgUsage?.input_tokens),
        cacheCreation: toInt(msgUsage?.cache_creation_input_tokens),
        cacheRead: toInt(msgUsage?.cache_read_input_tokens),
        lastDeltaOutput: 0,
      };
      messages.push(current);
    } else if (ev.type === "message_delta" && current !== null) {
      const deltaUsage = ev.usage as Record<string, unknown> | undefined;
      if (deltaUsage?.output_tokens !== undefined) {
        // output_tokens is cumulative within the message; last value wins.
        current.lastDeltaOutput = toInt(deltaUsage.output_tokens);
      }
    }
  }

  const summed: PerTurnUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  for (const msg of messages) {
    summed.input_tokens += msg.inputTokens;
    summed.output_tokens += msg.lastDeltaOutput;
    summed.cache_creation_input_tokens += msg.cacheCreation;
    summed.cache_read_input_tokens += msg.cacheRead;
  }

  return {
    usage: summed,
    reportedCostUsd: null,
    compactionEvents,
    turns: messages.length,
    modelId,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toInt(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function countMessageStarts(objects: Record<string, unknown>[]): number {
  return objects.filter((o) => o.type === "message_start").length;
}
