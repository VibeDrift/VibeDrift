/**
 * Pure session summary: fold a ledger's events into counts.
 *
 * Resolution model: a flag is resolved if it carries outcome "resolved" or a
 * later `resolve` event names its findingId; held if it is a blocking flag or a
 * `hold` event names it; open otherwise.
 *
 * Decisions (accept/park/decline) are a SEPARATE axis from resolution: they
 * record what the agent SAID it would do, not whether the drift signal actually
 * cleared. A flag can be declined yet still open, or accepted and later resolved.
 * The two are counted independently and never conflated.
 */

import { fileMatchesAnchors } from "./anchors.js";
import type { SessionEvent } from "./types.js";

export interface SessionSummary {
  edits: number;
  /** confirmed (non-experimental) flags in the headline */
  flagged: number;
  resolved: number;
  held: number;
  open: number;
  /** experimental signals (scope drift) — tracked apart from the headline */
  experimental: number;
  /** the agent's own calls on flags (last decision per finding wins). Orthogonal
   *  to resolved/held/open: a decision is a stated intent, not a verified outcome. */
  decisions: { accepted: number; parked: number; declined: number };
  findings: string[];
  /** Phase 3 coverage: task target files that got an edit / total task files.
   *  null when the task named no files. */
  coverage: { touched: number; total: number } | null;
}

export function summarize(events: SessionEvent[]): SessionSummary {
  const flags = new Map<string, "open" | "resolved" | "held">();
  // last decision per finding wins (append-only ledger, iterated in order)
  const decisionByFinding = new Map<string, "accept" | "park" | "decline">();
  let anonFlagged = 0;
  let experimental = 0;
  let edits = 0;
  let anchorFiles: string[] = [];
  const editedFiles = new Set<string>();

  for (const e of events) {
    if (e.type === "decision" && e.findingId && e.detail.decision) {
      decisionByFinding.set(e.findingId, e.detail.decision);
      continue;
    }
    if (e.type === "edit") {
      edits++;
      if (e.detail.file) editedFiles.add(e.detail.file);
    } else if (e.type === "intent_lock") {
      // each intent_lock carries the full current anchor set, so the last one
      // has all files (including those added by follow-up prompts).
      if (e.detail.anchorFiles?.length) anchorFiles = e.detail.anchorFiles;
    } else if (e.type === "flag") {
      // experimental signals (scope drift) are tracked apart from the headline
      if (e.detail.experimental) {
        experimental++;
        continue;
      }
      const id = e.findingId;
      if (!id) {
        anonFlagged++;
        continue;
      }
      if (e.outcome === "resolved") flags.set(id, "resolved");
      else if (e.outcome === "held" || e.mode === "blocking") flags.set(id, "held");
      else if (!flags.has(id)) flags.set(id, "open");
    } else if (e.type === "resolve" && e.findingId) {
      flags.set(e.findingId, "resolved");
    } else if (e.type === "hold" && e.findingId) {
      flags.set(e.findingId, "held");
    }
  }

  let resolved = 0;
  let held = 0;
  for (const state of flags.values()) {
    if (state === "resolved") resolved++;
    else if (state === "held") held++;
  }
  const flagged = flags.size + anonFlagged;
  const open = flagged - resolved - held;

  // Only count a decision that names a finding this ledger actually flagged, so a
  // stray/mis-correlated decision event can never overstate agent engagement.
  const decisions = { accepted: 0, parked: 0, declined: 0 };
  for (const [id, d] of decisionByFinding) {
    if (!flags.has(id)) continue;
    if (d === "accept") decisions.accepted++;
    else if (d === "park") decisions.parked++;
    else decisions.declined++;
  }

  let coverage: SessionSummary["coverage"] = null;
  if (anchorFiles.length) {
    // bounded matching (a.ts must not match banana.ts); an anchor file is
    // "touched" if some edited file is or is within it.
    const edited = [...editedFiles];
    const touched = anchorFiles.filter((f) =>
      edited.some((e) => fileMatchesAnchors(e, [f])),
    ).length;
    coverage = { touched, total: anchorFiles.length };
  }

  return { edits, flagged, resolved, held, open, experimental, decisions, findings: [...flags.keys()], coverage };
}

export function formatSummary(s: SessionSummary): string {
  // "edits" not "edits checked": an edit outside the repo or above the inline
  // size gate is recorded but not drift-checked, so "checked" would overstate.
  const parts = [`${s.edits} edits`, `${s.flagged} flagged`];
  if (s.resolved) parts.push(`${s.resolved} resolved`);
  if (s.held) parts.push(`${s.held} held`);
  parts.push(`${s.open} open`);
  if (s.experimental) parts.push(`${s.experimental} experimental`);
  const { accepted, parked, declined } = s.decisions;
  if (accepted || parked || declined) {
    const dparts: string[] = [];
    if (accepted) dparts.push(`${accepted} accepted`);
    if (parked) dparts.push(`${parked} parked`);
    if (declined) dparts.push(`${declined} declined`);
    // "agent said:" marks these as stated intents, distinct from the verified
    // resolved/held/open outcomes above — a reader must never read "accepted" as "fixed".
    parts.push(`agent said: ${dparts.join(", ")}`);
  }
  if (s.coverage) parts.push(`${s.coverage.touched}/${s.coverage.total} task files touched`);
  return parts.join(" · ");
}
