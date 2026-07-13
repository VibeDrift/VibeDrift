/**
 * Shannon entropy of a discrete distribution given raw counts.
 * Range: [0, log₂(k)] where k is the number of non-zero categories.
 */
export function shannonEntropy(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let H = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    H -= p * Math.log2(p);
  }
  return H;
}
