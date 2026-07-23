import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readSessionEvents, sessionFilePath, newActivityId } from "@/session/ledger";
import type { SessionEvent } from "@/session/types";

const HASH = "abcd1234abcd1234";

const ev = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1,
  sid: "s1",
  aid: newActivityId(),
  ts: new Date().toISOString(),
  agent: "claude-code",
  projectHash: HASH,
  channel: "hook",
  type: "user_prompt",
  mode: "passive",
  detail: { promptText: "add stripe webhook" },
  ...over,
});

describe("session ledger", () => {
  it("appends one JSON line per event and reads them back in order", async () => {
    const base = mkdtempSync(join(tmpdir(), "vd-ledger-"));
    await appendEvent(base, HASH, "s1", ev());
    await appendEvent(base, HASH, "s1", ev({ type: "edit" }));
    const file = sessionFilePath(base, HASH, "s1");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const events = await readSessionEvents(file);
    expect(events.map((e) => e.type)).toEqual(["user_prompt", "edit"]);
  });

  it("skips corrupt lines on read instead of throwing", async () => {
    const base = mkdtempSync(join(tmpdir(), "vd-ledger-"));
    await appendEvent(base, HASH, "s1", ev());
    const file = sessionFilePath(base, HASH, "s1");
    appendFileSync(file, "{not json\n");
    await appendEvent(base, HASH, "s1", ev({ type: "session_end" }));
    const events = await readSessionEvents(file);
    expect(events.map((e) => e.type)).toEqual(["user_prompt", "session_end"]);
  });

  it("returns [] for a missing file", async () => {
    const base = mkdtempSync(join(tmpdir(), "vd-ledger-"));
    const events = await readSessionEvents(sessionFilePath(base, HASH, "nope"));
    expect(events).toEqual([]);
  });

  it("caps a single line at 32KB by BYTES for ASCII prompts", async () => {
    const base = mkdtempSync(join(tmpdir(), "vd-ledger-"));
    await appendEvent(base, HASH, "s1", ev({ detail: { promptText: "x".repeat(64_000) } }));
    const file = sessionFilePath(base, HASH, "s1");
    const line = readFileSync(file, "utf8").trim();
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(32 * 1024);
    const parsed = JSON.parse(line) as SessionEvent;
    expect(parsed.detail.truncated).toBe(true);
  });

  it("caps by BYTES for multibyte prompts (CJK is 3 bytes/char)", async () => {
    const base = mkdtempSync(join(tmpdir(), "vd-ledger-"));
    await appendEvent(base, HASH, "s2", ev({ sid: "s2", detail: { promptText: "文".repeat(40_000) } }));
    const file = sessionFilePath(base, HASH, "s2");
    const line = readFileSync(file, "utf8").trim();
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect((JSON.parse(line) as SessionEvent).detail.truncated).toBe(true);
  });

  it("sanitizes path-unsafe session ids so they cannot escape the sessions dir", async () => {
    const base = mkdtempSync(join(tmpdir(), "vd-ledger-"));
    await appendEvent(base, HASH, "../../evil", ev({ sid: "../../evil" }));
    // nothing written outside base
    const escaped = join(base, "..", "..", "evil.jsonl");
    expect(existsSync(escaped)).toBe(false);
    // the sanitized file lives under base/<hash>/
    const events = await readSessionEvents(sessionFilePath(base, HASH, "../../evil"));
    expect(events).toHaveLength(1);
  });

  it("still records when the session id contains a slash", async () => {
    const base = mkdtempSync(join(tmpdir(), "vd-ledger-"));
    await appendEvent(base, HASH, "a/b", ev({ sid: "a/b" }));
    const events = await readSessionEvents(sessionFilePath(base, HASH, "a/b"));
    expect(events).toHaveLength(1);
  });

  it("generates unique activity ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newActivityId()));
    expect(ids.size).toBe(200);
  });
});
