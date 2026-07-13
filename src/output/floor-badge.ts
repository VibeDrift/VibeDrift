/**
 * Shared floor-trip detector for the render-only "Security floor" badge
 * (Phase 2, Task 3).
 *
 * Consumes two disjoint finding families that are both high-precision
 * enough to warrant a warning regardless of the repo's overall drift
 * consistency:
 *   - `security-floor` (src/analyzers/security.ts): committed secrets,
 *     disabled TLS verification. Hygiene-kind, does not touch the drift
 *     composite.
 *   - `codedna-taint` (src/codedna/taint-analysis.ts) findings whose sink is
 *     `code_injection` or `command_injection`: unsanitized input reaching
 *     eval/exec.
 *
 * RENDER ONLY: `hasFloorTrip` never reads or writes compositeScore/grade.
 * Callers (src/output/terminal.ts, src/output/html.ts) use its result only
 * to decide whether to print a warning line/chip. This is a locked
 * constraint — see the grade-invariance test in
 * test/unit/output/floor-badge.test.ts.
 */

import type { Finding } from "../core/types.js";
import { INJECTION_SINK_LABELS } from "../codedna/taint-analysis.js";

export interface FloorTripResult {
  tripped: boolean;
  reasons: string[];
}

// Known security-floor rule messages (src/analyzers/security.ts SECURITY_PATTERNS,
// floor: true subset) mapped to a short, stable reason phrase. Matched against
// the raw finding message since analyzerId alone ("security-floor") doesn't
// distinguish which rule fired. Order matters: first match wins.
const FLOOR_REASON_RULES: Array<{ test: RegExp; reason: string }> = [
  { test: /private key/i, reason: "private key in source" },
  { test: /AWS access key/i, reason: "AWS access key in source" },
  { test: /hardcoded API key/i, reason: "hardcoded API key in source" },
  { test: /hardcoded authentication token/i, reason: "hardcoded auth token in source" },
  { test: /TLS certificate verification disabled/i, reason: "TLS certificate verification disabled" },
];

function reasonForFloorFinding(message: string): string {
  for (const rule of FLOOR_REASON_RULES) {
    if (rule.test.test(message)) return rule.reason;
  }
  // Fallback for a future floor rule this table doesn't know about yet:
  // strip the trailing " in <file>:<line>" suffix security.ts appends to
  // every message, and lowercase the leading word so it reads as a clause.
  const stripped = message.replace(/\s+in\s+\S+:\d+$/, "").trim();
  return stripped.length > 0 ? stripped.charAt(0).toLowerCase() + stripped.slice(1) : "security floor rule tripped";
}

function isInjectionTaintFinding(f: Finding): boolean {
  if (f.analyzerId !== "codedna-taint") return false;
  // One-hop flows (findOneHopFlows in taint-analysis.ts) embed the raw sink
  // category string directly in the message (e.g. "reaches command_injection
  // sink"); direct-sink flows embed the human sink label instead (e.g. "code
  // evaluation"). Check both so neither shape is missed.
  if (f.message.includes("code_injection") || f.message.includes("command_injection")) return true;
  for (const label of INJECTION_SINK_LABELS) {
    if (f.message.includes(label)) return true;
  }
  return false;
}

/**
 * Scan a finding set for an absolute security floor trip. Pure and
 * side-effect free; safe to call from any renderer.
 */
export function hasFloorTrip(findings: Finding[]): FloorTripResult {
  const reasons = new Set<string>();
  for (const f of findings) {
    if (f.analyzerId === "security-floor") {
      reasons.add(reasonForFloorFinding(f.message));
    } else if (isInjectionTaintFinding(f)) {
      reasons.add("unsanitized input reaches eval/exec");
    }
  }
  return { tripped: reasons.size > 0, reasons: [...reasons] };
}
