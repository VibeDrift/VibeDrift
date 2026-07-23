import { describe, it, expect } from "vitest";
import { summarize, formatSummary } from "@/session/summary";
import type { SessionEvent } from "@/session/types";

let seq = 0;
const ev = (type: SessionEvent["type"], over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1,
  sid: "s1",
  aid: `evt-${seq++}`,
  ts: new Date().toISOString(),
  agent: "claude-code",
  projectHash: "h",
  channel: "hook",
  type,
  mode: "passive",
  detail: {},
  ...over,
});

describe("summarize", () => {
  it("counts edits and flags, all open when no outcomes", () => {
    const s = summarize([
      ev("session_start"),
      ev("user_prompt"),
      ev("edit"),
      ev("flag", { findingId: "DF-1" }),
      ev("edit"),
      ev("flag", { findingId: "DF-2" }),
      ev("session_end"),
    ]);
    expect(s).toMatchObject({ edits: 2, flagged: 2, resolved: 0, held: 0, open: 2 });
  });

  it("counts a later resolve event against its finding", () => {
    const s = summarize([
      ev("edit"),
      ev("flag", { findingId: "DF-1" }),
      ev("flag", { findingId: "DF-2" }),
      ev("resolve", { findingId: "DF-1" }),
    ]);
    expect(s).toMatchObject({ flagged: 2, resolved: 1, open: 1 });
  });

  it("counts a hold and a blocking flag as held", () => {
    const s = summarize([
      ev("flag", { findingId: "DF-1", mode: "blocking" }),
      ev("flag", { findingId: "DF-2" }),
      ev("hold", { findingId: "DF-2" }),
    ]);
    expect(s.held).toBe(2);
    expect(s.open).toBe(0);
  });

  it("formatSummary is observational, never claims prevention", () => {
    const line = formatSummary(summarize([ev("edit"), ev("flag", { findingId: "DF-1" })]));
    expect(line).toContain("1 flagged");
    expect(line.toLowerCase()).not.toContain("prevented");
    expect(line.toLowerCase()).not.toContain("blocked");
  });

  it("reports coverage of the task's target files", () => {
    const s = summarize([
      ev("intent_lock", { detail: { anchorFiles: ["routes/billing.ts", "lib/retry.ts"] } }),
      ev("edit", { detail: { file: "routes/billing.ts" } }),
      ev("edit", { detail: { file: "ui/theme.ts" } }),
    ]);
    expect(s.coverage).toEqual({ touched: 1, total: 2 });
    expect(formatSummary(s)).toContain("1/2 task files touched");
  });

  it("coverage denominator includes files added by a follow-up prompt (last lock wins)", () => {
    const s = summarize([
      ev("intent_lock", { detail: { anchorFiles: ["routes/billing.ts"] } }),
      ev("intent_lock", { detail: { anchorFiles: ["routes/billing.ts", "routes/orders.ts"], observed: "expanded" } }),
      ev("edit", { detail: { file: "routes/billing.ts" } }),
    ]);
    expect(s.coverage).toEqual({ touched: 1, total: 2 });
  });

  it("keeps experimental scope flags OUT of the headline flagged/open", () => {
    const s = summarize([
      ev("edit"),
      ev("flag", { findingId: "DF-1", detail: { category: "async_patterns" } }),
      ev("flag", { findingId: "DF-scope-2", detail: { category: "scope", experimental: true } }),
    ]);
    expect(s.flagged).toBe(1);
    expect(s.experimental).toBe(1);
    expect(s.open).toBe(1);
    expect(formatSummary(s)).toContain("1 experimental");
  });

  it("has null coverage when the task named no files", () => {
    expect(summarize([ev("edit")]).coverage).toBeNull();
  });

  it("tallies the agent's accept/park/decline decisions", () => {
    const s = summarize([
      ev("flag", { findingId: "DF-1" }),
      ev("flag", { findingId: "DF-2" }),
      ev("flag", { findingId: "DF-3" }),
      ev("decision", { findingId: "DF-1", detail: { decision: "accept" } }),
      ev("decision", { findingId: "DF-2", detail: { decision: "park" } }),
      ev("decision", { findingId: "DF-3", detail: { decision: "decline" } }),
    ]);
    expect(s.decisions).toEqual({ accepted: 1, parked: 1, declined: 1 });
    expect(formatSummary(s)).toContain("1 accepted, 1 parked, 1 declined");
  });

  it("keeps only the last decision per finding", () => {
    const s = summarize([
      ev("flag", { findingId: "DF-1" }),
      ev("decision", { findingId: "DF-1", detail: { decision: "park" } }),
      ev("decision", { findingId: "DF-1", detail: { decision: "accept" } }),
    ]);
    expect(s.decisions).toEqual({ accepted: 1, parked: 0, declined: 0 });
  });

  it("treats a decision as orthogonal to the resolved/open outcome", () => {
    // DF-1 is both DECLINED (a stated intent) and still OPEN (no re-check cleared it);
    // DF-2 is ACCEPTED and later RESOLVED. The two axes are counted independently.
    const s = summarize([
      ev("flag", { findingId: "DF-1" }),
      ev("flag", { findingId: "DF-2" }),
      ev("decision", { findingId: "DF-1", detail: { decision: "decline" } }),
      ev("decision", { findingId: "DF-2", detail: { decision: "accept" } }),
      ev("resolve", { findingId: "DF-2" }),
    ]);
    expect(s).toMatchObject({ flagged: 2, resolved: 1, open: 1 });
    expect(s.decisions).toEqual({ accepted: 1, parked: 0, declined: 1 });
  });

  it("omits the decision clause when there are none", () => {
    const line = formatSummary(summarize([ev("edit"), ev("flag", { findingId: "DF-1" })]));
    expect(line).not.toContain("accepted");
    expect(line).not.toContain("declined");
  });
});
