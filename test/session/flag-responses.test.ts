/**
 * Delivering a person's answer into the ledger.
 *
 * This is the only path where data flows from the dashboard back to the
 * machine, so the tests are mostly about not losing or mis-attributing
 * anything on the way:
 *
 *   an answer becomes an ordinary decision event, in the repo's own ledger,
 *   tagged `via: "human"` so nothing downstream reports it as the agent's;
 *
 *   it is acknowledged only after it is written, so a crash between the two
 *   re-delivers rather than drops;
 *
 *   and every failure is silent, because this runs on an agent's hook path.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decisionEventFor,
  deliverQueuedResponses,
  describeFlag,
  flagContextFrom,
  parseQueued,
  responseBriefing,
  type QueuedResponse,
} from "../../src/session/flag-responses.js";
import type { SessionEvent } from "../../src/session/types.js";

let dir: string;
const HASH = "81a512c4a735dfa8";
const SID = "s-1";

const queued = (over: Partial<QueuedResponse> = {}): QueuedResponse => ({
  id: "r1",
  projectHash: HASH,
  sessionId: SID,
  findingId: "DF-1",
  decision: "decline",
  reason: "intentional copy pending refactor review",
  ...over,
});

/** The API's wire shape (snake_case), as the endpoint returns it. */
const wire = (over: Record<string, unknown> = {}) => ({
  responses: [
    {
      id: "r1",
      project_hash: HASH,
      session_id: SID,
      finding_id: "DF-1",
      decision: "decline",
      reason: "intentional copy pending refactor review",
      created_at: "2026-09-20T21:00:00Z",
      ...over,
    },
  ],
});

function ledgerEvents(): Array<Record<string, unknown>> {
  const path = join(dir, HASH, `${SID}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Put a flag in the ledger the answer will be written into, the way a real
 *  session would have left one there. */
function seedFlag(detail: Record<string, unknown>, findingId = "DF-1"): void {
  mkdirSync(join(dir, HASH), { recursive: true });
  const ev = {
    v: 1,
    sid: SID,
    aid: `evt-seed-${findingId}`,
    ts: "2026-08-09T00:54:07.653Z",
    agent: "claude-code",
    projectHash: HASH,
    channel: "hook",
    type: "flag",
    mode: "passive",
    findingId,
    detail,
  };
  writeFileSync(join(dir, HASH, `${SID}.jsonl`), `${JSON.stringify(ev)}\n`, { flag: "a" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vd-answers-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a person's answer becomes a decision in the repo's own ledger", () => {
  it("writes it, and never as the agent's call", () => {
    const ev = decisionEventFor(queued(), "2026-09-20T21:00:00.000Z") as unknown as Record<string, unknown>;
    expect(ev.type).toBe("decision");
    expect(ev.findingId).toBe("DF-1");
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.decision).toBe("decline");
    expect(detail.via).toBe("human");
  });

  it("masks the reason on the way in, because it arrived over the network", () => {
    // A Bearer header shape: it exercises the same masker as a vendor key
    // without putting a string that LOOKS like a live credential into the
    // repo, which is a fight with push protection nobody should win.
    const leak = "Bearer ZmFrZS10b2tlbi1mb3ItbWFza2luZy10ZXN0";
    const ev = decisionEventFor(
      queued({ reason: `the old copy still had ${leak} in it` }),
      "2026-09-20T21:00:00.000Z",
    ) as unknown as Record<string, unknown>;
    const reason = String((ev.detail as Record<string, unknown>).reason);
    expect(reason).not.toContain(leak);
    expect(reason).toContain("the old copy still had");
  });
});

describe("delivery: write first, acknowledge after", () => {
  const okFetch = (calls: string[]) =>
    (async (url: unknown, init?: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/pending")) return new Response(JSON.stringify(wire()), { status: 200 });
      void init;
      return new Response(JSON.stringify({ delivered: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

  it("writes the answer, then acks exactly what it wrote", async () => {
    const calls: string[] = [];
    const written = await deliverQueuedResponses({
      sessionsDir: dir,
      projectHash: HASH,
      apiUrl: "https://api.example",
      token: "t",
      fetchImpl: okFetch(calls),
    });
    expect(written).toHaveLength(1);
    const events = ledgerEvents();
    expect(events).toHaveLength(1);
    expect((events[0].detail as Record<string, unknown>).via).toBe("human");
    // The ack follows the write, not the read.
    expect(calls[0]).toContain("/pending");
    expect(calls[1]).toContain("/ack");
  });

  it("asks only about the repo it is in", async () => {
    const calls: string[] = [];
    await deliverQueuedResponses({
      sessionsDir: dir,
      projectHash: HASH,
      apiUrl: "https://api.example",
      token: "t",
      fetchImpl: okFetch(calls),
    });
    expect(calls[0]).toContain(`project_hash=${HASH}`);
  });

  it("does not ack when nothing was queued", async () => {
    const calls: string[] = [];
    const empty = (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ responses: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await deliverQueuedResponses({ sessionsDir: dir, projectHash: HASH, apiUrl: "https://api.example", token: "t", fetchImpl: empty })).toEqual([]);
    expect(calls.some((c) => c.includes("/ack"))).toBe(false);
  });

  it("keeps the local write when the ack fails, so the answer is not lost", async () => {
    const flaky = (async (url: unknown) => {
      if (String(url).includes("/pending")) return new Response(JSON.stringify(wire()), { status: 200 });
      throw new Error("network gone");
    }) as unknown as typeof fetch;
    const written = await deliverQueuedResponses({ sessionsDir: dir, projectHash: HASH, apiUrl: "https://api.example", token: "t", fetchImpl: flaky });
    expect(written).toHaveLength(1);
    expect(ledgerEvents()).toHaveLength(1);
  });
});

describe("it fails silently, because it runs on an agent's hook path", () => {
  it("returns nothing when the fetch throws", async () => {
    const dead = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(
      deliverQueuedResponses({ sessionsDir: dir, projectHash: HASH, apiUrl: "https://api.example", token: "t", fetchImpl: dead }),
    ).resolves.toEqual([]);
    expect(ledgerEvents()).toEqual([]);
  });

  it("returns nothing on a non-200", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      deliverQueuedResponses({ sessionsDir: dir, projectHash: HASH, apiUrl: "https://api.example", token: "t", fetchImpl: bad }),
    ).resolves.toEqual([]);
  });

  it("drops a malformed answer rather than writing half a decision", () => {
    expect(parseQueued(wire({ decision: "maybe" }))).toEqual([]);
    expect(parseQueued(wire({ finding_id: "" }))).toEqual([]);
    expect(parseQueued({ responses: "not a list" })).toEqual([]);
    expect(parseQueued(null)).toEqual([]);
  });
});

describe("what the agent is told", () => {
  it("says who answered and what to do about it", () => {
    const text = responseBriefing([queued()]) ?? "";
    expect(text).toContain("A person answered");
    expect(text).toContain("DF-1");
    expect(text).toContain("leave it as written");
    expect(text).toContain("intentional copy pending refactor review");
  });

  it("tells the agent to change the code on an accept", () => {
    expect(responseBriefing([queued({ decision: "accept" })])).toContain("change the code");
  });

  it("says nothing when there is nothing to say", () => {
    expect(responseBriefing([])).toBeNull();
  });
});

/**
 * A finding id is unique only within a sitting: the first flag of every
 * session is DF-1. An answer that travels as an id alone therefore arrives
 * ambiguous, and an agent acting on it changes the wrong file. These are the
 * tests that bind the fix.
 */
describe("an answer names the file, not just the finding id", () => {
  it("reads what the flag said out of this machine's own ledger", () => {
    const events = [
      { type: "edit", findingId: undefined, detail: { file: "noise.ts" } },
      { type: "flag", findingId: "DF-2", detail: { file: "other.ts", category: "redundancy" } },
      {
        type: "flag",
        findingId: "DF-1",
        detail: { file: "src/drift/report-helpers.ts", category: "redundancy", similarTo: "src/drift/utils.ts:204", similarity: 1 },
      },
    ] as unknown as SessionEvent[];
    expect(flagContextFrom(events, "DF-1")).toEqual({
      file: "src/drift/report-helpers.ts",
      what: "duplicates src/drift/utils.ts:204 (1.00 similar)",
    });
  });

  it("takes the most recent raise when one id was flagged twice", () => {
    const events = [
      { type: "flag", findingId: "DF-1", detail: { file: "first.ts", category: "redundancy" } },
      { type: "flag", findingId: "DF-1", detail: { file: "second.ts", category: "redundancy" } },
    ] as unknown as SessionEvent[];
    expect(flagContextFrom(events, "DF-1")?.file).toBe("second.ts");
  });

  it("knows nothing rather than guessing when the flag is not in the ledger", () => {
    expect(flagContextFrom([], "DF-1")).toBeUndefined();
  });

  it("describes a pattern conflict in the same words the tape uses", () => {
    expect(
      describeFlag({ category: "return_shape_consistency", dominant: "null/undefined sentinels", observed: "throws on error" }),
    ).toBe("return_shape_consistency: this project uses null/undefined sentinels, that change used throws on error");
  });

  it("puts the file in the briefing, so the agent edits the right one", async () => {
    seedFlag({
      file: "src/drift/report-helpers.ts",
      category: "redundancy",
      similarTo: "src/drift/utils.ts:204",
      similarity: 1,
    });
    const ok = (async (url: unknown) =>
      String(url).includes("/pending")
        ? new Response(JSON.stringify(wire({ decision: "accept", reason: "" })), { status: 200 })
        : new Response(JSON.stringify({ delivered: 1 }), { status: 200 })) as unknown as typeof fetch;

    const written = await deliverQueuedResponses({
      sessionsDir: dir,
      projectHash: HASH,
      apiUrl: "https://api.example",
      token: "t",
      fetchImpl: ok,
    });
    const text = responseBriefing(written) ?? "";
    expect(text).toContain("src/drift/report-helpers.ts");
    expect(text).toContain("duplicates src/drift/utils.ts:204");
    expect(text).toContain("change the code");
  });

  it("names the sitting instead of implying THIS session's DF-1", () => {
    const text = responseBriefing([queued()]) ?? "";
    expect(text).toContain("not this one");
    expect(text).toContain(SID.slice(0, 8));
  });
});
