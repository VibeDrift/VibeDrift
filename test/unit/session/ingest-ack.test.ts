import { describe, it, expect } from "vitest";
import { reconcileAck, isIngestLocked, type TaggedUpload } from "@/session/ingest-ack";
import type { UploadEvent } from "@/session/upload-schema";

let n = 0;
const tag = (file: string, endOffset: number): TaggedUpload => ({
  event: { v: 1, sessionId: "s1", activityId: `evt-${++n}`, ts: "t", agent: "claude-code", projectHash: "h", type: "edit" } as UploadEvent,
  file,
  endOffset,
});
const ids = (sent: TaggedUpload[]) => sent.map((t) => t.event.activityId);

describe("reconcileAck", () => {
  it("void ack (test seams / ancient callers) commits the full batch per file", () => {
    const sent = [tag("a.jsonl", 100), tag("a.jsonl", 200), tag("b.jsonl", 50)];
    const rec = reconcileAck(sent, undefined);
    expect(rec.commitUpTo.get("a.jsonl")).toBe(200);
    expect(rec.commitUpTo.get("b.jsonl")).toBe(50);
    expect(rec.held).toHaveLength(0);
  });

  it("legacy ack with full accepted count commits; partial count holds everything", () => {
    const sent = [tag("a.jsonl", 100), tag("a.jsonl", 200)];
    const full = reconcileAck(sent, { accepted: 2 });
    expect(full.commitUpTo.get("a.jsonl")).toBe(200);
    const partial = reconcileAck(sent, { accepted: 1 });
    expect(partial.commitUpTo.size).toBe(0);
    expect(partial.held).toHaveLength(2);
  });

  it("contiguous prefix: a held event stops its file's watermark; later events of that file hold", () => {
    const sent = [tag("a.jsonl", 100), tag("a.jsonl", 200), tag("a.jsonl", 300)];
    const [i1, , i3] = ids(sent);
    const rec = reconcileAck(sent, {
      accepted: 2,
      results: [
        { activityId: i1, status: "accepted" },
        { activityId: sent[1].event.activityId, status: "held", code: "session_locked" },
        { activityId: i3, status: "accepted" },
      ],
    });
    expect(rec.commitUpTo.get("a.jsonl")).toBe(100);
    // both the held event AND the accepted-after-held event stay pending
    expect(rec.held.map((t) => t.event.activityId)).toEqual([sent[1].event.activityId, i3]);
  });

  it("a permanently rejected event commits past and is reported", () => {
    const sent = [tag("a.jsonl", 100), tag("a.jsonl", 200)];
    const rec = reconcileAck(sent, {
      accepted: 1,
      results: [
        { activityId: sent[0].event.activityId, status: "rejected", code: "banned_field" },
        { activityId: sent[1].event.activityId, status: "accepted" },
      ],
    });
    expect(rec.commitUpTo.get("a.jsonl")).toBe(200);
    expect(rec.rejectedIds).toEqual([sent[0].event.activityId]);
    expect(rec.held).toHaveLength(0);
  });

  it("duplicate counts as accepted (idempotent replays)", () => {
    const sent = [tag("a.jsonl", 100)];
    const rec = reconcileAck(sent, {
      accepted: 0,
      results: [{ activityId: sent[0].event.activityId, status: "duplicate" }],
    });
    expect(rec.commitUpTo.get("a.jsonl")).toBe(100);
  });

  it("an event missing from results holds itself and everything after it in its file", () => {
    const sent = [tag("a.jsonl", 100), tag("a.jsonl", 200)];
    const rec = reconcileAck(sent, {
      accepted: 1,
      results: [{ activityId: sent[1].event.activityId, status: "accepted" }],
    });
    expect(rec.commitUpTo.size).toBe(0);
    expect(rec.held).toHaveLength(2);
  });

  it("files commit independently: a hold in file A does not block file B", () => {
    const sent = [tag("a.jsonl", 100), tag("b.jsonl", 60), tag("a.jsonl", 200), tag("b.jsonl", 120)];
    const rec = reconcileAck(sent, {
      accepted: 3,
      results: [
        { activityId: sent[0].event.activityId, status: "held", code: "unknown_type" },
        { activityId: sent[1].event.activityId, status: "accepted" },
        { activityId: sent[2].event.activityId, status: "accepted" },
        { activityId: sent[3].event.activityId, status: "accepted" },
      ],
    });
    expect(rec.commitUpTo.has("a.jsonl")).toBe(false);
    expect(rec.commitUpTo.get("b.jsonl")).toBe(120);
    expect(rec.held.map((t) => t.file)).toEqual(["a.jsonl", "a.jsonl"]);
  });

  it("isIngestLocked matches 402 errors only", () => {
    expect(isIngestLocked({ status: 402 })).toBe(true);
    expect(isIngestLocked({ status: 500 })).toBe(false);
    expect(isIngestLocked(new Error("network"))).toBe(false);
    expect(isIngestLocked(undefined)).toBe(false);
  });
});
