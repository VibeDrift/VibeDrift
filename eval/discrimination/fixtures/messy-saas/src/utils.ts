// Grab-bag utils. Mixed naming, an unused export, and DUPLICATE #3.

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// DUPLICATE #3 (a): id maker, also pasted in session.ts
export function make_id(prefix: string): string {
  return prefix + "_" + Math.random().toString(36).substring(2, 11);
}

// PHANTOM: never used anywhere
export function deepClone(obj: any): any {
  return JSON.parse(JSON.stringify(obj));
}

// snake_case sibling of clamp, slightly different — naming drift
export function clamp_value(n: number, lo: number, hi: number) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
