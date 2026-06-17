export function scoreBar(score: number, max: number, width = 20): string {
  const filled = Math.round((score / max) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

export function padRight(str: string, len: number): string {
  return str + " ".repeat(Math.max(0, len - str.length));
}

/**
 * Deterministic number formatting for report output.
 *
 * Replaces `Number#toLocaleString()`, which inserts host-locale-specific
 * grouping separators and therefore makes report output non-byte-stable
 * across machines (and can push a report across the upload size cap purely
 * from separator width). `Intl.NumberFormat('en-US')` pins en-US grouping
 * regardless of the process locale. Node 18+ bundles full ICU, so this is
 * available everywhere the CLI runs.
 */
const COUNT_FORMATTER = new Intl.NumberFormat("en-US");

export function formatCount(n: number): string {
  return COUNT_FORMATTER.format(n);
}
