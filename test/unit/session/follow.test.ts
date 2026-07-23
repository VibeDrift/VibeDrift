import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionFollower } from "@/session/follow";
import { appendEvent } from "@/session/ledger";
import type { SessionEvent } from "@/session/types";

const HASH = "hashhashhashhash";
let seq = 0;
const ev = (type: SessionEvent["type"], sid: string): SessionEvent => ({
  v: 1,
  sid,
  aid: `evt-${seq++}`,
  ts: new Date().toISOString(),
  agent: "claude-code",
  projectHash: HASH,
  channel: "hook",
  type,
  mode: "passive",
  detail: {},
});
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-follow-")));

describe("SessionFollower", () => {
  it("returns new events since the last poll", async () => {
    const dir = tmp();
    await appendEvent(dir, HASH, "A", ev("session_start", "A"));
    await appendEvent(dir, HASH, "A", ev("user_prompt", "A"));
    const f = new SessionFollower(dir, HASH);
    const first = await f.poll();
    expect(first.map((e) => e.type)).toEqual(["session_start", "user_prompt"]);
    await appendEvent(dir, HASH, "A", ev("edit", "A"));
    const second = await f.poll();
    expect(second.map((e) => e.type)).toEqual(["edit"]);
    const third = await f.poll();
    expect(third).toEqual([]);
  });

  it("rotates to a newer session file", async () => {
    const dir = tmp();
    await appendEvent(dir, HASH, "A", ev("session_start", "A"));
    const f = new SessionFollower(dir, HASH);
    await f.poll();
    // a newer session B (mtime later than A because written after)
    await new Promise((r) => setTimeout(r, 15));
    await appendEvent(dir, HASH, "B", ev("session_start", "B"));
    const rotated = await f.poll();
    expect(rotated.map((e) => e.sid)).toEqual(["B"]);
  });

  it("does not replay a file when leapfrogging back to it (per-file offset)", async () => {
    const dir = tmp();
    await appendEvent(dir, HASH, "A", ev("session_start", "A"));
    const f = new SessionFollower(dir, HASH);
    expect((await f.poll()).length).toBe(1); // reads A
    await new Promise((r) => setTimeout(r, 15));
    await appendEvent(dir, HASH, "B", ev("session_start", "B"));
    expect((await f.poll()).map((e) => e.sid)).toEqual(["B"]); // switch to B
    // touch A so it becomes newest again, but add NO new events
    await new Promise((r) => setTimeout(r, 15));
    await appendEvent(dir, HASH, "A", ev("edit", "A")); // A now newest, 1 new line
    const back = await f.poll();
    // only the NEW A event, never a replay of A's first event
    expect(back.map((e) => e.type)).toEqual(["edit"]);
  });

  it("is empty and does not throw when the dir does not exist yet", async () => {
    const f = new SessionFollower(tmp(), "nope");
    expect(await f.poll()).toEqual([]);
  });
});
