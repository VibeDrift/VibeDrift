import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUploader, shouldSync, type UploaderOptions } from "@/session/uploader";
import { uploadStatePath } from "@/session/upload-state";
import { appendEvent } from "@/session/ledger";
import type { UploadEvent } from "@/session/upload-schema";
import type { IngestAck } from "@/session/ingest-ack";
import type { SessionEvent } from "@/session/types";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-up-")));

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

/** Run the uploader for exactly `ticks` poll cycles, then abort. */
function runFor(
  opts: Omit<UploaderOptions, "signal" | "sleep">,
  ticks: number,
): Promise<void> {
  const controller = new AbortController();
  let n = 0;
  return runUploader({
    ...opts,
    signal: controller.signal,
    sleep: async () => {
      if (++n >= ticks) controller.abort();
    },
  });
}

const fullAck = (events: UploadEvent[]): IngestAck => ({
  accepted: events.length,
  results: events.map((e) => ({ activityId: e.activityId, status: "accepted" as const })),
});

describe("shouldSync", () => {
  it("is off by default and in every partial state", () => {
    expect(shouldSync({})).toBe(false);
    expect(shouldSync({ sessionsSyncEnabled: true })).toBe(false); // no token
    expect(shouldSync({ token: "t" })).toBe(false); // not enabled
    expect(shouldSync({ sessionsSyncEnabled: false, token: "t" })).toBe(false);
  });
  it("is on only when opted in, logged in, and not forced local", () => {
    expect(shouldSync({ sessionsSyncEnabled: true, token: "t" })).toBe(true);
    expect(shouldSync({ sessionsSyncEnabled: true, token: "t" }, true)).toBe(false); // --local-only
  });
});

describe("runUploader", () => {
  it("maps and posts new events, dropping non-uploadable kinds and leaking no prompt text", async () => {
    const sessionsDir = tmp();
    const hash = "h1";
    await appendEvent(sessionsDir, hash, "s1", ev("session_start"));
    await appendEvent(sessionsDir, hash, "s1", ev("user_prompt", { detail: { promptText: "SECRETPROMPT" } }));
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "src/a.ts", diffstat: "+5" } }));
    await appendEvent(sessionsDir, hash, "s1", ev("flag", { findingId: "DF-1", detail: { file: "src/a.ts", category: "async_patterns", dominant: "async/await", observed: ".then() chains" } }));

    const posted: UploadEvent[] = [];
    await runFor({ sessionsDir, projectHash: hash, post: async (e) => { posted.push(...e); return fullAck(e); } }, 2);

    const types = posted.map((p) => p.type);
    expect(types).toContain("session_start");
    expect(types).toContain("edit");
    expect(types).toContain("flag");
    expect(types).not.toContain("user_prompt");
    expect(JSON.stringify(posted)).not.toContain("SECRETPROMPT");
  });

  it("retries a failed flush on the next tick without throwing", async () => {
    const sessionsDir = tmp();
    const hash = "h2";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "src/a.ts", diffstat: "+3" } }));

    const posted: UploadEvent[] = [];
    let calls = 0;
    await runFor({
      sessionsDir,
      projectHash: hash,
      post: async (e) => {
        calls++;
        if (calls === 1) throw new Error("network down");
        posted.push(...e);
        return fullAck(e);
      },
    }, 3);

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(posted.length).toBe(1);
  });

  it("ships the decision reason only under team opt-in", async () => {
    const write = async (dir: string, hash: string) => {
      await appendEvent(dir, hash, "s1", ev("flag", { findingId: "DF-1", detail: { file: "src/a.ts", category: "async_patterns" } }));
      await appendEvent(dir, hash, "s1", ev("decision", { channel: "mcp", findingId: "DF-1", detail: { decision: "decline", reason: "different semantics" } }));
    };

    const offDir = tmp();
    await write(offDir, "hoff");
    const off: UploadEvent[] = [];
    await runFor({ sessionsDir: offDir, projectHash: "hoff", teamIntentOptIn: false, post: async (e) => { off.push(...e); return fullAck(e); } }, 2);
    const offDec = off.find((p) => p.type === "decision")!;
    expect(offDec.decision).toBe("decline");
    expect(offDec.reason).toBeUndefined();

    const onDir = tmp();
    await write(onDir, "hon");
    const on: UploadEvent[] = [];
    await runFor({ sessionsDir: onDir, projectHash: "hon", teamIntentOptIn: true, post: async (e) => { on.push(...e); return fullAck(e); } }, 2);
    const onDec = on.find((p) => p.type === "decision")!;
    expect(onDec.decision).toBe("decline");
    expect(onDec.reason).toContain("different semantics");
  });

  it("R1 KILLER: a backfill far larger than the buffer uploads EVERY event exactly once across runs", async () => {
    const sessionsDir = tmp();
    const hash = "hr1";
    // 3 session files x 8 events = 24 events, buffer capped at 5, batches of 2
    for (const sid of ["sA", "sB", "sC"]) {
      for (let i = 0; i < 8; i++) {
        await appendEvent(sessionsDir, hash, sid, ev("edit", { sid, detail: { file: `src/${sid}-${i}.ts`, diffstat: "+1" } }));
      }
    }
    const posted: UploadEvent[] = [];
    await runFor({
      sessionsDir, projectHash: hash, maxBuffer: 5, batchSize: 2,
      post: async (e) => { posted.push(...e); return fullAck(e); },
    }, 40);

    const ids = posted.map((p) => p.activityId);
    expect(new Set(ids).size).toBe(24); // every event arrived
    expect(ids.length).toBe(24); // and none twice within the run

    // a FRESH uploader (new process) resumes from durable offsets: nothing re-sent
    const rePosted: UploadEvent[] = [];
    await runFor({
      sessionsDir, projectHash: hash, maxBuffer: 5, batchSize: 2,
      post: async (e) => { rePosted.push(...e); return fullAck(e); },
    }, 4);
    expect(rePosted).toHaveLength(0);
  });

  it("R3: an entitlement-locked run advances NO offsets; a later entitled run backfills everything", async () => {
    const sessionsDir = tmp();
    const hash = "hr3";
    for (let i = 0; i < 4; i++) {
      await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: `src/f${i}.ts`, diffstat: "+1" } }));
    }
    let lockedCalls = 0;
    await runFor({
      sessionsDir, projectHash: hash, holdBackoffTicks: 0,
      post: async () => { lockedCalls++; throw { status: 402, detail: "locked" }; },
    }, 3);
    expect(lockedCalls).toBeGreaterThanOrEqual(1);
    const statePath = uploadStatePath(sessionsDir, hash);
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      for (const v of Object.values(state.files as Record<string, { offset: number }>)) {
        expect(v.offset).toBe(0);
      }
    }

    const posted: UploadEvent[] = [];
    await runFor({ sessionsDir, projectHash: hash, post: async (e) => { posted.push(...e); return fullAck(e); } }, 3);
    expect(posted).toHaveLength(4); // the full backlog arrived after the lock lifted
  });

  it("a held event stops its file's commit and is re-sent after the backoff", async () => {
    const sessionsDir = tmp();
    const hash = "hheld";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "src/a.ts", diffstat: "+1" } }));
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "src/b.ts", diffstat: "+1" } }));

    let call = 0;
    const posted: string[][] = [];
    await runFor({
      sessionsDir, projectHash: hash, holdBackoffTicks: 0,
      post: async (e) => {
        call++;
        posted.push(e.map((x) => x.activityId));
        if (call === 1) {
          return {
            accepted: 1,
            results: [
              { activityId: e[0].activityId, status: "accepted" as const },
              { activityId: e[1].activityId, status: "held" as const, code: "unknown_type" },
            ],
          };
        }
        return fullAck(e);
      },
    }, 4);

    expect(posted.length).toBeGreaterThanOrEqual(2);
    // second call re-sent ONLY the held event
    expect(posted[1]).toEqual([posted[0][1]]);

    // fresh run: everything already committed, nothing re-sent
    const rePosted: UploadEvent[] = [];
    await runFor({ sessionsDir, projectHash: hash, post: async (e) => { rePosted.push(...e); return fullAck(e); } }, 3);
    expect(rePosted).toHaveLength(0);
  });

  it("permanently rejected events are committed past (never wedge the file)", async () => {
    const sessionsDir = tmp();
    const hash = "hrej";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "src/a.ts", diffstat: "+1" } }));
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "src/b.ts", diffstat: "+1" } }));

    await runFor({
      sessionsDir, projectHash: hash,
      post: async (e) => ({
        accepted: 1,
        results: [
          { activityId: e[0].activityId, status: "rejected" as const, code: "banned_field" },
          { activityId: e[1].activityId, status: "accepted" as const },
        ],
      }),
    }, 2);

    const rePosted: UploadEvent[] = [];
    await runFor({ sessionsDir, projectHash: hash, post: async (e) => { rePosted.push(...e); return fullAck(e); } }, 3);
    expect(rePosted).toHaveLength(0); // the reject did not stall the watermark
  });
});

describe("runUploaderOnce (bounded flush)", () => {
  it("drains the whole backlog in one shot, then a second run resends nothing", async () => {
    const { runUploaderOnce } = await import("@/session/uploader");
    const sessionsDir = tmp();
    const hash = "h1";
    // more events than a single batch so the drain loops
    for (let i = 0; i < 120; i++) {
      await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: `src/f${i}.ts`, diffstat: "+1" } }));
    }
    const posted: UploadEvent[] = [];
    await runUploaderOnce({
      sessionsDir,
      projectHash: hash,
      batchSize: 25,
      post: async (e) => { posted.push(...e); return fullAck(e); },
    });
    expect(posted).toHaveLength(120);

    const again: UploadEvent[] = [];
    await runUploaderOnce({ sessionsDir, projectHash: hash, post: async (e) => { again.push(...e); return fullAck(e); } });
    expect(again).toHaveLength(0); // durable offsets: nothing to resend
  });

  it("stops without spinning when the server holds, and commits nothing past the hold", async () => {
    const { runUploaderOnce } = await import("@/session/uploader");
    const sessionsDir = tmp();
    const hash = "h1";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "a.ts", diffstat: "+1" } }));
    let calls = 0;
    await runUploaderOnce({
      sessionsDir,
      projectHash: hash,
      post: async () => { calls++; const err = new Error("locked") as Error & { status?: number }; err.status = 402; throw err; },
    });
    expect(calls).toBeGreaterThan(0);
    // no offsets committed -> a subsequent (accepting) run resends the event
    const resent: UploadEvent[] = [];
    await runUploaderOnce({ sessionsDir, projectHash: hash, post: async (e) => { resent.push(...e); return fullAck(e); } });
    expect(resent).toHaveLength(1);
  });

  it("reports locked when the server answers 402, so the caller can lock capture", async () => {
    const { runUploaderOnce } = await import("@/session/uploader");
    const sessionsDir = tmp();
    const hash = "h1";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "a.ts", diffstat: "+1" } }));
    const out = await runUploaderOnce({
      sessionsDir,
      projectHash: hash,
      post: async () => { const err = new Error("locked") as Error & { status?: number }; err.status = 402; throw err; },
    });
    expect(out.locked).toBe(true);
  });

  it("does NOT report locked for a plain network failure", async () => {
    const { runUploaderOnce } = await import("@/session/uploader");
    const sessionsDir = tmp();
    const hash = "h1";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "a.ts", diffstat: "+1" } }));
    const out = await runUploaderOnce({
      sessionsDir,
      projectHash: hash,
      post: async () => { throw new Error("network down"); },
    });
    expect(out.locked).toBe(false);
  });

  it("does NOT report locked when the server merely holds events (version skew)", async () => {
    const { runUploaderOnce } = await import("@/session/uploader");
    const sessionsDir = tmp();
    const hash = "h1";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "a.ts", diffstat: "+1" } }));
    const out = await runUploaderOnce({
      sessionsDir,
      projectHash: hash,
      post: async (e) => ({
        accepted: 0,
        results: e.map((x) => ({ activityId: x.activityId, status: "held" as const, code: "unknown_type" })),
      }),
    });
    expect(out.locked).toBe(false);
  });

  it("reports not-locked on a clean full drain", async () => {
    const { runUploaderOnce } = await import("@/session/uploader");
    const sessionsDir = tmp();
    const hash = "h1";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "a.ts", diffstat: "+1" } }));
    const out = await runUploaderOnce({
      sessionsDir,
      projectHash: hash,
      post: async (e) => fullAck(e),
    });
    expect(out.locked).toBe(false);
  });

  it("respects the time budget on a persistently failing network (no infinite loop)", async () => {
    const { runUploaderOnce } = await import("@/session/uploader");
    const sessionsDir = tmp();
    const hash = "h1";
    await appendEvent(sessionsDir, hash, "s1", ev("edit", { detail: { file: "a.ts", diffstat: "+1" } }));
    let clock = 0;
    // returns quickly since a network error (non-402) breaks on no-progress,
    // but the budget guard is the ultimate backstop
    await runUploaderOnce({
      sessionsDir,
      projectHash: hash,
      budgetMs: 50,
      now: () => (clock += 10),
      post: async () => { throw new Error("network down"); },
    });
    // reaching here (not hanging) is the assertion
    expect(true).toBe(true);
  });
});
