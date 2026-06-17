/**
 * Human-friendly "time since" formatting for CLI output.
 *
 * Pure and deterministic: pass `nowMs` to make it testable. Used by
 * `vibedrift status` to render "last deep scan: 5 days ago" and (later) by the
 * deep-scan nudge to phrase how long it has been.
 */
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * Format an ISO-8601 timestamp as a coarse "N units ago" string relative to
 * `nowMs` (defaults to the current time). Sub-minute and future gaps read as
 * "just now"; an unparseable input returns "unknown" rather than throwing.
 */
export function formatTimeSince(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const diff = nowMs - then;
  if (diff < MIN) return "just now";
  if (diff < HOUR) return plural(Math.floor(diff / MIN), "minute");
  if (diff < DAY) return plural(Math.floor(diff / HOUR), "hour");
  if (diff < MONTH) return plural(Math.floor(diff / DAY), "day");
  return plural(Math.floor(diff / MONTH), "month");
}
