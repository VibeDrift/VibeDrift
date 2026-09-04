// Single-entry memoized newline-offset cache. getLineNumber is called once
// per regex match, and analyzers call it repeatedly against the SAME
// file.content string while scanning one file — the naive `content.slice(0,
// index).split("\n")` re-slices and re-splits the whole prefix on every
// call, which is O(index) per call and O(n²) across a dense file with many
// matches. A one-entry cache (calls cluster per file, so a bigger cache
// buys little) turns repeated lookups on the same content into an O(n)
// build once, plus an O(log n) binary search per call. `content === last`
// is a fast reference-equality check for the common case of the same
// string object reused across calls.
let lastContent: string | null = null;
let lastNewlineOffsets: number[] | null = null;

function getNewlineOffsets(content: string): number[] {
  if (content === lastContent && lastNewlineOffsets) return lastNewlineOffsets;
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) offsets.push(i);
  }
  lastContent = content;
  lastNewlineOffsets = offsets;
  return offsets;
}

export function getLineNumber(content: string, index: number): number {
  const offsets = getNewlineOffsets(content);
  // Binary search for the count of newlines strictly before `index` —
  // equivalent to `content.slice(0, index).split("\n").length`.
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

export function densityPer1K(count: number, totalLines: number): number {
  if (totalLines === 0) return 0;
  return Math.round((count / totalLines) * 1000 * 10) / 10;
}
