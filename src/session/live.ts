/**
 * The live event tape: follows the active session ledger and prints each new
 * event as a tape line, with a repainted one-line status footer, and a summary
 * block at session end. Append-only above, single repainting line below (no TUI
 * framework — just `\r\x1b[2K` to clear the footer line).
 */

import chalk from "chalk";
import { SessionFollower } from "./follow.js";
import { formatEventLine } from "./tape.js";
import { summarize, formatSummary, type SessionSummary } from "./summary.js";
import { computeDrift, gaugeSignals, applyHysteresis, GAUGE_DEFAULT_WINDOW, type Zone } from "./gauge.js";
import type { SessionEvent } from "./types.js";

const CLEAR_LINE = "\r\x1b[2K";
const GAUGE_WINDOW = GAUGE_DEFAULT_WINDOW;

function gaugeLabel(zone: Zone, d: number): string {
  const dot = zone === "red" ? chalk.red("●") : zone === "yellow" ? chalk.yellow("●") : chalk.green("●");
  return `${dot} drift ${d.toFixed(2)}`;
}

export interface LiveTapeOptions {
  sessionsDir: string;
  projectHash: string;
  out: NodeJS.WritableStream;
  intervalMs?: number;
  signal?: AbortSignal;
  /** injectable sleeper for tests; defaults to real setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** fired once per session id the first time it shows a real edit — used to
   *  count a trial session server-side (a session counts only with activity). */
  onFirstEdit?: (sessionId: string) => void;
}

function footer(count: number, s: SessionSummary, gauge: string): string {
  return chalk.dim(
    `⟳ watching · ${count} events · ${s.flagged} flagged · ${s.open} open · ${gauge} · Ctrl-C to stop`,
  );
}

export async function runLiveTape(opts: LiveTapeOptions): Promise<void> {
  const interval = opts.intervalMs ?? 300;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const follower = new SessionFollower(opts.sessionsDir, opts.projectHash);
  const all: SessionEvent[] = [];
  let footerShown = false;
  let zone: Zone = "green";
  const editedSessions = new Set<string>();
  // Only count sessions whose activity arrives AFTER we start watching — the
  // first poll replays the existing ledger, and a pre-existing/old session must
  // not be charged against the trial.
  const startedAt = Date.now();

  const write = (s: string) => opts.out.write(s);
  const clearFooter = () => {
    if (footerShown) {
      write(CLEAR_LINE);
      footerShown = false;
    }
  };
  const showFooter = () => {
    const { a, b, c } = gaugeSignals(all, GAUGE_WINDOW);
    const d = computeDrift(a, b, c);
    zone = applyHysteresis(zone, d);
    write(footer(all.length, summarize(all), gaugeLabel(zone, d)));
    footerShown = true;
  };

  while (!opts.signal?.aborted) {
    const batch = await follower.poll();
    if (batch.length) {
      clearFooter();
      for (const ev of batch) {
        all.push(ev);
        if (
          ev.type === "edit" &&
          ev.sid &&
          !editedSessions.has(ev.sid) &&
          (Date.parse(ev.ts) || 0) >= startedAt
        ) {
          editedSessions.add(ev.sid);
          try {
            opts.onFirstEdit?.(ev.sid);
          } catch {
            // trial counting is best-effort; never break the tape
          }
        }
        const line = formatEventLine(ev);
        if (line) write(`${line}\n`);
        if (ev.type === "session_end") {
          const s = summarize(all);
          write(`\n${chalk.bold("session summary")}  ${formatSummary(s)}\n\n`);
        }
      }
      showFooter();
    }
    if (opts.signal?.aborted) break;
    await sleep(interval);
  }
  clearFooter();
}
