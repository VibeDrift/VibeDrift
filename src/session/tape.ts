/**
 * Pure tape-line rendering for the live event tape and dashboard replay.
 * One colored line per event; returns null for events not shown on the tape.
 * Vocabulary is observational (flagged / diverges / duplicates / asks / replies).
 */

import chalk from "chalk";
import type { SessionEvent } from "./types.js";

/** Wall-clock time of an event as HH:MM:SS — human-readable and matching the
 *  dashboard's decision-log timestamps. Falls back to --:--:-- on a bad ts. */
function stamp(ev: SessionEvent): string {
  const t = Date.parse(ev.ts);
  if (!Number.isFinite(t)) return chalk.dim("--:--:--");
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, "0");
  return chalk.dim(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
}

export function formatEventLine(ev: SessionEvent): string | null {
  // A ledger line can be valid JSON but the wrong shape (a truncated/foreign
  // write); never let a missing `detail` crash the live loop.
  const d = ev.detail ?? {};
  const s = stamp(ev);
  switch (ev.type) {
    case "session_start":
      return `${s}  SESSION    ${chalk.dim("capture started")}`;
    case "session_end":
      return `${s}  SESSION    ${chalk.dim("session end")}`;
    case "user_prompt":
      return `${s}  USER       ${(d.promptText ?? "").slice(0, 64)}`;
    case "edit":
      return `${s}  AGENT      edits ${d.file ?? ""} ${chalk.dim(d.diffstat ?? "")}`;
    case "intent_lock": {
      const label = d.observed === "expanded" ? "intent expanded" : "contract locked";
      return `${s}  ${chalk.cyan("INTENT")}     ${chalk.cyan(label)} ${chalk.dim(`· ${d.promptText ?? ""}`)}`;
    }
    case "flag": {
      const badge = ev.mode === "blocking" ? chalk.red("[BLOCKING]") : chalk.yellow("[PASSIVE]");
      const verb = ev.mode === "blocking" ? chalk.red("[HELD]") : chalk.yellow("[FLAGGED]");
      const id = ev.findingId ? `${ev.findingId} ` : "";
      const exp = d.experimental ? chalk.dim(" [EXPERIMENTAL]") : "";
      let msg: string;
      if (d.category === "redundancy") {
        msg = `duplicates ${d.similarTo ?? ""}${d.similarity ? ` (${d.similarity} similar)` : ""}`;
      } else if (d.category === "scope") {
        msg = `scope: ${d.observed ?? "edit unrelated to the task"}`;
      } else {
        msg = `${d.category ?? "drift"}: repo uses ${d.dominant ?? "?"}, this uses ${d.observed ?? "?"}`;
      }
      return `${s}  ${chalk.yellow("VIBEDRIFT")}  ${verb} ${id}${badge}${exp} ${msg}`;
    }
    case "mcp_ask":
      return `${s}  AGENT      ${chalk.cyan("[ASKS]")} ${chalk.dim((d.promptText ?? "").slice(0, 60))}`;
    case "mcp_verdict":
      return `${s}  ${chalk.yellow("VIBEDRIFT")}  ${chalk.cyan("[REPLIES]")} ${chalk.dim((d.observed ?? "").slice(0, 60))}`;
    case "decision": {
      // the agent's own call on a flag — a stated intent, distinct from the
      // verified [RESOLVED]/[HELD] outcomes below (an ACCEPT is not a fix).
      const badge =
        d.decision === "accept"
          ? chalk.green("[ACCEPT]")
          : d.decision === "park"
            ? chalk.yellow("[PARK]")
            : d.decision === "decline"
              ? chalk.red("[DECLINE]")
              : null;
      if (!badge) return null; // unknown/absent decision: not shown
      const id = ev.findingId ? `${ev.findingId} ` : "";
      const reason = d.reason ? chalk.dim((d.reason ?? "").slice(0, 60)) : "";
      return `${s}  AGENT      ${badge} ${id}${reason}`;
    }
    case "resolve":
      return `${s}  ${chalk.yellow("VIBEDRIFT")}  ${chalk.green("[RESOLVED]")} ${ev.findingId ?? ""} ${chalk.dim(d.file ?? "")}`;
    case "hold":
      return `${s}  ${chalk.yellow("VIBEDRIFT")}  ${chalk.red("[HELD]")} ${ev.findingId ?? ""}`;
    case "recheck":
      return `${s}  ${chalk.dim(`AGENT      ${d.file ?? ""} ${d.observed ?? ""}`)}`;
    default:
      return null; // command, and any event type not shown on the tape
  }
}
