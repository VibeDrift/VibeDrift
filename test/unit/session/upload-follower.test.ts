import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, appendFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadFollower } from "@/session/upload-follower";
import { UploadStateStore } from "@/session/upload-state";
import type { SessionEvent } from "@/session/types";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-ufol-")));

let seq = 0;
const line = (sid: string, type = "edit") =>
  JSON.stringify({ v: 1, sid, aid: `evt-${++seq}`, ts: "t", agent: "claude-code", projectHash: "h", channel: "hook", type, mode: "passive", detail: {} }) + "\n";

async function setup(hash = "h1") {
  const dir = tmp();
  mkdirSync(join(dir, hash), { recursive: true });
  const store = new UploadStateStore(dir, hash);
  await store.load();
  return { dir, store, follower: new UploadFollower(dir, hash, store), pdir: join(dir, hash) };
}

const sids = (evts: Array<{ event: SessionEvent }>) => evts.map((t) => t.event.sid);

describe("UploadFollower", () => {
  it("backfills ALL ledger files, oldest mtime first", async () => {
    const { follower, pdir } = await setup();
    writeFileSync(join(pdir, "old.jsonl"), line("old") + line("old"));
    writeFileSync(join(pdir, "new.jsonl"), line("new"));
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(pdir, "old.jsonl"), past, past);
    const got = await follower.poll(100);
    expect(sids(got)).toEqual(["old", "old", "new"]);
    expect(got.map((t) => t.file)).toEqual(["old.jsonl", "old.jsonl", "new.jsonl"]);
  });

  it("resumes each file from the durable committed offset", async () => {
    const { pdir, store } = await setup();
    const l1 = line("s1");
    writeFileSync(join(pdir, "s1.jsonl"), l1 + line("s1"));
    await store.commit(new Map([["s1.jsonl", l1.length]]));
    const store2 = new UploadStateStore(pdir.replace(/\/h1$/, ""), "h1");
    await store2.load();
    const follower = new UploadFollower(pdir.replace(/\/h1$/, ""), "h1", store2);
    const got = await follower.poll(100);
    expect(got).toHaveLength(1);
    expect(got[0].endOffset).toBeGreaterThan(l1.length);
  });

  it("backpressure: returns at most `budget` events and re-reads the remainder next poll", async () => {
    const { follower, pdir } = await setup();
    writeFileSync(join(pdir, "s1.jsonl"), line("a") + line("b") + line("c") + line("d"));
    const first = await follower.poll(2);
    expect(sids(first)).toEqual(["a", "b"]);
    const second = await follower.poll(2);
    expect(sids(second)).toEqual(["c", "d"]);
    expect(await follower.poll(2)).toHaveLength(0);
  });

  it("budget stops across files too, without skipping the later file", async () => {
    const { follower, pdir } = await setup();
    writeFileSync(join(pdir, "a.jsonl"), line("a1") + line("a2"));
    writeFileSync(join(pdir, "b.jsonl"), line("b1"));
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(pdir, "a.jsonl"), past, past);
    expect(sids(await follower.poll(1))).toEqual(["a1"]);
    expect(sids(await follower.poll(5))).toEqual(["a2", "b1"]);
  });

  it("a half-written trailing line is not returned until its newline arrives", async () => {
    const { follower, pdir } = await setup();
    const full = line("s1");
    writeFileSync(join(pdir, "s1.jsonl"), full + '{"v":1,"sid":"s1","aid":"torn'); // no newline
    expect(sids(await follower.poll(10))).toEqual(["s1"]);
    appendFileSync(join(pdir, "s1.jsonl"), "}\n"); // completes the line but stays invalid JSON
    appendFileSync(join(pdir, "s1.jsonl"), line("s2"));
    const got = await follower.poll(10);
    expect(sids(got)).toEqual(["s2"]); // corrupt completed line skipped, not wedged
  });

  it("corrupt lines advance the offset (never wedge the file)", async () => {
    const { follower, pdir } = await setup();
    writeFileSync(join(pdir, "s1.jsonl"), "not-json\n" + line("ok"));
    const got = await follower.poll(10);
    expect(sids(got)).toEqual(["ok"]);
    expect(await follower.poll(10)).toHaveLength(0);
  });

  it("a truncated/replaced file resets to zero (dedup absorbs the resend)", async () => {
    const { follower, pdir } = await setup();
    writeFileSync(join(pdir, "s1.jsonl"), line("a") + line("b"));
    await follower.poll(10);
    writeFileSync(join(pdir, "s1.jsonl"), line("c")); // shorter file, new content
    const got = await follower.poll(10);
    expect(sids(got)).toEqual(["c"]);
  });

  it("unchanged files are skipped on later polls; appends are picked up", async () => {
    const { follower, pdir } = await setup();
    writeFileSync(join(pdir, "s1.jsonl"), line("a"));
    expect(await follower.poll(10)).toHaveLength(1);
    expect(await follower.poll(10)).toHaveLength(0);
    appendFileSync(join(pdir, "s1.jsonl"), line("b"));
    expect(sids(await follower.poll(10))).toEqual(["b"]);
  });

  it("non-jsonl files (upload-state.json, backups) are ignored", async () => {
    const { follower, pdir } = await setup();
    writeFileSync(join(pdir, "upload-state.json"), "{}");
    writeFileSync(join(pdir, "settings-backup.json"), "{}");
    writeFileSync(join(pdir, "s1.jsonl"), line("a"));
    expect(sids(await follower.poll(10))).toEqual(["a"]);
  });
});
