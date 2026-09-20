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
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decisionEventFor,
  deliverQueuedResponses,
  parseQueued,
  responseBriefing,
  type QueuedResponse,
} from "../../src/session/flag-responses.js";

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
