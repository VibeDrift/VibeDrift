import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFlagDecision, MAX_REASON_LEN } from "@/session/decision";
import { appendEvent, sessionFilePath, readSessionEvents } from "@/session/ledger";
import { projectHash } from "@/core/baseline";
import type { SessionEvent } from "@/session/types";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-dec-")));

let seq = 0;
const flag = (sid: string, findingId: string, over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1,
  sid,
  aid: `evt-${seq++}`,
  ts: new Date().toISOString(),
  agent: "claude-code",
  projectHash: "x",
  channel: "hook",
  type: "flag",
  mode: "passive",
  findingId,
  detail: {},
  outcome: null,
  ...over,
});

describe("recordFlagDecision", () => {
  it("appends a decision event against a raised flag", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    await appendEvent(sessionsDir, hash, "live", flag("live", "DF-1"));

    const res = await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-1",
      decision: "accept",
      reason: "the rest of routes/ is async/await; rewriting to match",
    });

    expect(res).toMatchObject({ ok: true, sid: "live", findingId: "DF-1", decision: "accept" });
    const events = await readSessionEvents(sessionFilePath(sessionsDir, hash, "live"));
    const dec = events.find((e) => e.type === "decision")!;
    expect(dec.findingId).toBe("DF-1");
    expect(dec.channel).toBe("mcp");
    expect(dec.mode).toBe("passive");
    expect(dec.detail.decision).toBe("accept");
    expect(dec.detail.reason).toContain("async/await");
  });

  it("masks a secret in the reason before persisting", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    await appendEvent(sessionsDir, hash, "live", flag("live", "DF-1"));

    await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-1",
      decision: "decline",
      reason: `config sets OPENAI_API_KEY=${["sk-", "ant-", "api03-", "AAAABBBBCCCCDDDD1234"].join("")} so it's fine`,
    });

    const events = await readSessionEvents(sessionFilePath(sessionsDir, hash, "live"));
    const reason = events.find((e) => e.type === "decision")!.detail.reason!;
    expect(reason).not.toContain("AAAABBBBCCCCDDDD1234");
    expect(reason).toContain("[masked]");
  });

  it("caps an overlong reason", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    await appendEvent(sessionsDir, hash, "live", flag("live", "DF-1"));

    await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-1",
      decision: "park",
      reason: "a".repeat(MAX_REASON_LEN + 1000),
    });

    const events = await readSessionEvents(sessionFilePath(sessionsDir, hash, "live"));
    expect(events.find((e) => e.type === "decision")!.detail.reason!.length).toBe(MAX_REASON_LEN);
  });

  it("rejects an unknown finding id with the known ids as a hint", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    await appendEvent(sessionsDir, hash, "live", flag("live", "DF-1"));
    await appendEvent(sessionsDir, hash, "live", flag("live", "DF-2"));
    // an experimental scope signal is NOT a respondable flag
    await appendEvent(
      sessionsDir,
      hash,
      "live",
      flag("live", "DF-scope-1", { detail: { experimental: true } }),
    );

    const res = await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-9",
      decision: "accept",
      reason: "typo'd id",
    });

    expect(res.ok).toBe(false);
    if (!res.ok && res.code === "unknown_finding") {
      expect(res.knownFindings).toEqual(["DF-1", "DF-2"]);
    } else {
      throw new Error(`expected unknown_finding, got ${JSON.stringify(res)}`);
    }
    // nothing recorded
    const events = await readSessionEvents(sessionFilePath(sessionsDir, hash, "live"));
    expect(events.some((e) => e.type === "decision")).toBe(false);
  });

  it("reports no_active_session when the repo has no ledger", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp(); // never wrote a ledger for this hash
    const res = await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-1",
      decision: "accept",
      reason: "x",
    });
    expect(res).toEqual({ ok: false, code: "no_active_session" });
  });

  it("rejects a bad decision value", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const res = await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-1",
      // deliberately invalid
      decision: "maybe" as unknown as "accept",
      reason: "x",
    });
    expect(res).toEqual({ ok: false, code: "bad_decision" });
  });

  it("prefers the ledger where a colliding id is still open+undecided", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    // Both concurrent sessions minted DF-1. The NEWER one already responded to
    // its DF-1 (decided); the older one is still awaiting a response.
    await appendEvent(sessionsDir, hash, "older", flag("older", "DF-1"));
    await appendEvent(sessionsDir, hash, "newer", flag("newer", "DF-1"));
    await appendEvent(sessionsDir, hash, "newer", {
      ...flag("newer", "DF-1"),
      type: "decision",
      channel: "mcp",
      detail: { decision: "decline", reason: "already handled here" },
    });

    const base = Date.now();
    utimesSync(sessionFilePath(sessionsDir, hash, "older"), new Date(base - 60_000), new Date(base - 60_000));
    utimesSync(sessionFilePath(sessionsDir, hash, "newer"), new Date(base), new Date(base));

    const res = await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-1",
      decision: "accept",
      reason: "this is the still-open one",
      now: () => base + 1000,
    });

    // even though "newer" is newer AND also raised DF-1, it's already decided, so
    // the open+undecided "older" ledger wins.
    expect(res).toMatchObject({ ok: true, sid: "older" });
  });

  it("unions known findings across active ledgers in the not-found hint", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    // newest ledger has NO flags (only an edit); an older active one holds DF-3.
    await appendEvent(sessionsDir, hash, "newer", {
      ...flag("newer", "DF-1"),
      type: "edit",
      findingId: undefined,
      detail: { file: "a.ts" },
    });
    await appendEvent(sessionsDir, hash, "older", flag("older", "DF-3"));

    const base = Date.now();
    utimesSync(sessionFilePath(sessionsDir, hash, "older"), new Date(base - 60_000), new Date(base - 60_000));
    utimesSync(sessionFilePath(sessionsDir, hash, "newer"), new Date(base), new Date(base));

    const res = await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-9",
      decision: "accept",
      reason: "typo",
      now: () => base + 1000,
    });

    expect(res.ok).toBe(false);
    if (!res.ok && res.code === "unknown_finding") {
      // the hint sees the OLDER ledger's DF-3, not just the empty newest one
      expect(res.knownFindings).toContain("DF-3");
    } else {
      throw new Error(`expected unknown_finding, got ${JSON.stringify(res)}`);
    }
  });

  it("records against the ledger that RAISED the id, not just the newest active one", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    // older ledger raised DF-1
    await appendEvent(sessionsDir, hash, "older", flag("older", "DF-1"));
    // newer ledger raised something else
    await appendEvent(sessionsDir, hash, "newer", flag("newer", "DF-7"));

    // make "newer" strictly newer so newest-first would pick it if we didn't scan
    const base = Date.now();
    utimesSync(sessionFilePath(sessionsDir, hash, "older"), new Date(base - 60_000), new Date(base - 60_000));
    utimesSync(sessionFilePath(sessionsDir, hash, "newer"), new Date(base), new Date(base));

    const res = await recordFlagDecision({
      sessionsDir,
      rootDir,
      findingId: "DF-1",
      decision: "accept",
      reason: "belongs to the older session",
      now: () => base + 1000,
    });

    expect(res).toMatchObject({ ok: true, sid: "older" });
    const newerEvents = await readSessionEvents(sessionFilePath(sessionsDir, hash, "newer"));
    expect(newerEvents.some((e) => e.type === "decision")).toBe(false);
  });
});
