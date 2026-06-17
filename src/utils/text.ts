export function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

export function densityPer1K(count: number, totalLines: number): number {
  if (totalLines === 0) return 0;
  return Math.round((count / totalLines) * 1000 * 10) / 10;
}
