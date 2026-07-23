/**
 * The drift gauge: a smoothed, honest aggregate of the three per-edit signals
 * over a sliding window. Combined with the scoring-v11 noisy-OR family so no
 * single signal dominates, and shown with zone hysteresis so it never flaps.
 * Weights ship labeled "initial calibration" (see the plan).
 */

import type { SessionEvent } from "./types.js";

export type Zone = "green" | "yellow" | "red";

// Initial calibration (labeled as such per the plan): the noisy-OR weights, the
// zone boundaries, the hysteresis margin, and the default window. These move
// once we calibrate on real opt-in ledgers; kept together so that is one edit.
export const GAUGE_WEIGHTS = { scope: 0.5, convention: 0.35, redundancy: 0.4 } as const;
export const GAUGE_DEFAULT_WINDOW = 5;
const GREEN_MAX = 0.25;
const YELLOW_MAX = 0.5;
const HYSTERESIS_MARGIN = 0.05;

/** a = scope drift, b = convention drift, c = redundancy — each in [0,1]. */
export function computeDrift(a: number, b: number, c: number): number {
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const w = GAUGE_WEIGHTS;
  const d = 1 - (1 - w.scope * clamp(a)) * (1 - w.convention * clamp(b)) * (1 - w.redundancy * clamp(c));
  return Math.round(d * 1000) / 1000;
}

export function classifyZone(d: number): Zone {
  if (d < GREEN_MAX) return "green";
  if (d < YELLOW_MAX) return "yellow";
  return "red";
}

/** Require the value to move a margin PAST a boundary before changing zone, so a
 *  value hovering on a threshold does not oscillate. */
export function applyHysteresis(prev: Zone, d: number, margin = HYSTERESIS_MARGIN): Zone {
  const raw = classifyZone(d);
  if (raw === prev) return prev;
  // moving up: only switch if clearly past the upper edge of the current zone
  if (raw === "yellow" && prev === "green" && d < GREEN_MAX + margin) return "green";
  if (raw === "red" && prev === "yellow" && d < YELLOW_MAX + margin) return "yellow";
  // moving down: only switch if clearly below the lower edge of the current zone
  if (raw === "green" && prev === "yellow" && d > GREEN_MAX - margin) return "yellow";
  if (raw === "yellow" && prev === "red" && d > YELLOW_MAX - margin) return "red";
  return raw;
}

/** Fractions over the last `window` edits: scope / convention / redundancy flags
 *  attributed to the edits they followed. Simple and honest: count flag events
 *  by category among the events since the window's first edit. */
export function gaugeSignals(
  events: SessionEvent[],
  window: number,
): { a: number; b: number; c: number } {
  const editIdx: number[] = [];
  events.forEach((e, i) => {
    if (e.type === "edit") editIdx.push(i);
  });
  if (editIdx.length === 0) return { a: 0, b: 0, c: 0 };
  const windowEdits = editIdx.slice(-window);
  const from = windowEdits[0];
  const n = windowEdits.length;

  let scope = 0;
  let convention = 0;
  let redundancy = 0;
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "flag") continue;
    const cat = e.detail.category;
    if (cat === "scope") scope++;
    else if (cat === "redundancy") redundancy++;
    else convention++;
  }
  return { a: scope / n, b: convention / n, c: redundancy / n };
}
