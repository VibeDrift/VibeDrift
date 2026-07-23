import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { runLiveTape } from "@/session/live";
import { appendEvent } from "@/session/ledger";
import type { SessionEvent } from "@/session/types";

const HASH = "livehashlivehash";
let seq = 0;
const ev = (type: SessionEvent["type"], over: Partial<SessionEvent> = {}): SessionEvent => ({
  v: 1,
  sid: "live",
  aid: `evt-${seq++}`,
  ts: new Date().toISOString(),
  agent: "claude-code",
  projectHash: HASH,
  channel: "hook",
  type,
  mode: "passive",
  detail: {},
  ...over,
});

function capture(): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m|\\r`, "g");
  return { stream, text: () => buf.replace(ansi, "") };
}

describe("runLiveTape", () => {
  it("renders new events live and prints a summary at session end", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "vd-live-")));
    const { stream, text } = capture();
    const ctrl = new AbortController();

    const loop = runLiveTape({
      sessionsDir: dir,
      projectHash: HASH,
      out: stream,
      intervalMs: 10,
      signal: ctrl.signal,
    });

    const tick = () => new Promise((r) => setTimeout(r, 30));
    await appendEvent(dir, HASH, "live", ev("session_start"));
    await appendEvent(dir, HASH, "live", ev("edit", { detail: { file: "src/a.ts", diffstat: "+5" } }));
    await appendEvent(dir, HASH, "live", ev("flag", { findingId: "DF-1", detail: { file: "src/a.ts", category: "async_patterns", dominant: "async/await", observed: ".then() chains" } }));
    await tick();
    await appendEvent(dir, HASH, "live", ev("session_end"));
    await tick();

    ctrl.abort();
    await loop;

    const out = text();
    expect(out).toContain("edits src/a.ts");
    expect(out).toContain("[FLAGGED]");
    expect(out).toContain("DF-1");
    expect(out).toContain("session summary");
    expect(out).toContain("1 flagged");
    expect(out.toLowerCase()).not.toContain("prevented");
  });
});
