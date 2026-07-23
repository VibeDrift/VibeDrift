import { describe, it, expect } from "vitest";
import { formatEventLine } from "@/session/tape";
import type { SessionEvent } from "@/session/types";

const T0 = Date.parse("2026-07-20T10:00:00.000Z");
const at = (secs: number) => new Date(T0 + secs * 1000).toISOString();

const ev = (type: SessionEvent["type"], over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1,
  sid: "s1",
  aid: "a",
  ts: at(0),
  agent: "claude-code",
  projectHash: "h",
  channel: "hook",
  type,
  mode: "passive",
  detail: {},
  ...over,
});

// strip ANSI for assertions (build the escape dynamically to satisfy no-control-regex)
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string | null) => (s ? s.replace(ANSI, "") : s);

describe("formatEventLine", () => {
  it("renders a passive flag with id, badge, and category", () => {
    const line = plain(
      formatEventLine(
        ev("flag", {
          ts: at(6),
          findingId: "DF-1",
          detail: { file: "src/a.ts", category: "async_patterns", dominant: "async/await", observed: ".then() chains" },
        }),
      ),
    );
    // human-readable wall-clock HH:MM:SS (seconds are timezone-invariant); at(6) → :06
    expect(line).toMatch(/\d\d:\d\d:06/);
    expect(line).not.toContain("t+");
    expect(line).toContain("[FLAGGED]");
    expect(line).toContain("DF-1");
    expect(line).toContain("[PASSIVE]");
    expect(line!.toLowerCase()).toContain("async");
    expect(line!.toLowerCase()).not.toContain("prevented");
  });

  it("renders a blocking flag as HELD/BLOCKING", () => {
    const line = plain(formatEventLine(ev("flag", { mode: "blocking", findingId: "DF-3", detail: { file: "x" } })));
    expect(line).toContain("[BLOCKING]");
  });

  it("renders mcp_ask as ASKS and mcp_verdict as REPLIES", () => {
    expect(plain(formatEventLine(ev("mcp_ask", { detail: { promptText: "does backoff.ts exist?" } })))).toContain(
      "ASKS",
    );
    expect(plain(formatEventLine(ev("mcp_verdict", { detail: { observed: "yes, safe to reuse" } })))).toContain(
      "REPLIES",
    );
  });

  it("renders intent_lock and an experimental scope flag", () => {
    expect(plain(formatEventLine(ev("intent_lock", { detail: { promptText: "add webhook" } })))).toContain(
      "contract locked",
    );
    const scope = plain(
      formatEventLine(
        ev("flag", { findingId: "DF-scope-2", detail: { file: "ui/x.ts", category: "scope", observed: "edit unrelated to the task", experimental: true } }),
      ),
    );
    expect(scope).toContain("[EXPERIMENTAL]");
    expect(scope).toContain("scope");
  });

  it("renders the agent's accept/park/decline decisions with the reason", () => {
    const acc = plain(
      formatEventLine(
        ev("decision", { ts: at(16), channel: "mcp", findingId: "DF-1", detail: { decision: "accept", reason: "rest of routes/ is async/await" } }),
      ),
    );
    expect(acc).toMatch(/\d\d:\d\d:16/); // at(16) → :16
    expect(acc).not.toContain("t+");
    expect(acc).toContain("AGENT");
    expect(acc).toContain("[ACCEPT]");
    expect(acc).toContain("DF-1");
    expect(acc).toContain("rest of routes/ is async/await");
    // a decision is a stated intent, never a verified outcome
    expect(acc!.toLowerCase()).not.toContain("resolved");
    expect(acc!.toLowerCase()).not.toContain("fixed");
    expect(acc!.toLowerCase()).not.toContain("prevented");

    expect(plain(formatEventLine(ev("decision", { findingId: "DF-2", detail: { decision: "park" } })))).toContain("[PARK]");
    expect(plain(formatEventLine(ev("decision", { findingId: "DF-3", detail: { decision: "decline" } })))).toContain("[DECLINE]");
  });

  it("hides a decision event with an unknown/absent decision value", () => {
    expect(formatEventLine(ev("decision", { findingId: "DF-1", detail: {} }))).toBeNull();
  });

  it("does not crash on a valid-JSON but wrong-shape event (missing detail)", () => {
    const bad = { v: 1, type: "flag", findingId: "DF-9" } as unknown as SessionEvent;
    expect(() => formatEventLine(bad)).not.toThrow();
  });

  it("renders session/user/edit rows and hides command rows", () => {
    expect(plain(formatEventLine(ev("session_start")))).toContain("SESSION");
    expect(plain(formatEventLine(ev("user_prompt", { detail: { promptText: "add webhook" } })))).toContain("add webhook");
    expect(plain(formatEventLine(ev("edit", { detail: { file: "src/a.ts", diffstat: "+5" } })))).toContain("src/a.ts");
    expect(formatEventLine(ev("command"))).toBeNull();
  });
});
