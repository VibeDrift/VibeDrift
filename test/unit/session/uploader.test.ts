import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUploader, shouldSync } from "@/session/uploader";
import { appendEvent } from "@/session/ledger";
import type { UploadEvent } from "@/session/upload-schema";
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
  sessionsDir: string,
  hash: string,
  post: (e: UploadEvent[]) => Promise<void>,
  ticks: number,
  teamIntentOptIn = false,
): Promise<void> {
  const controller = new AbortController();
  let n = 0;
  return runUploader({
    sessionsDir,
    projectHash: hash,
    teamIntentOptIn,
    post,
    signal: controller.signal,
    sleep: async () => {
      if (++n >= ticks) controller.abort();
    },
  });
}

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
    await runFor(sessionsDir, hash, async (e) => void posted.push(...e), 1);

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
    await runFor(
      sessionsDir,
      hash,
      async (e) => {
        calls++;
        if (calls === 1) throw new Error("network down");
        posted.push(...e);
      },
      2,
    );

    expect(calls).toBeGreaterThanOrEqual(2); // first failed, retried
    expect(posted.length).toBe(1); // the event survived the failure and posted
  });

  it("ships the decision reason only under team opt-in", async () => {
    const write = async (dir: string, hash: string) => {
      await appendEvent(dir, hash, "s1", ev("flag", { findingId: "DF-1", detail: { file: "src/a.ts", category: "async_patterns" } }));
      await appendEvent(dir, hash, "s1", ev("decision", { channel: "mcp", findingId: "DF-1", detail: { decision: "decline", reason: "different semantics" } }));
    };

    const offDir = tmp();
    await write(offDir, "hoff");
    const off: UploadEvent[] = [];
    await runFor(offDir, "hoff", async (e) => void off.push(...e), 1, false);
    const offDec = off.find((p) => p.type === "decision")!;
    expect(offDec.decision).toBe("decline");
    expect(offDec.reason).toBeUndefined();

    const onDir = tmp();
    await write(onDir, "hon");
    const on: UploadEvent[] = [];
    await runFor(onDir, "hon", async (e) => void on.push(...e), 1, true);
    const onDec = on.find((p) => p.type === "decision")!;
    expect(onDec.decision).toBe("decline");
    expect(onDec.reason).toContain("different semantics");
  });
});
