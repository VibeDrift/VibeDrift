import { describe, it, expect } from "vitest";
import { mkdtempSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teeMcpVerdict, ACTIVE_WINDOW_MS } from "@/session/mcp-tee";
import { appendEvent, sessionFilePath, readSessionEvents } from "@/session/ledger";
import { projectHash } from "@/core/baseline";
import type { SessionEvent } from "@/session/types";

const ev = (sid: string): SessionEvent => ({
  v: 1,
  sid,
  aid: "a",
  ts: new Date().toISOString(),
  agent: "claude-code",
  projectHash: "x",
  channel: "hook",
  type: "session_start",
  mode: "passive",
  detail: {},
});
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-tee-")));

describe("teeMcpVerdict", () => {
  it("appends mcp_ask + mcp_verdict to the active session", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    await appendEvent(sessionsDir, hash, "live", ev("live"));

    await teeMcpVerdict({
      sessionsDir,
      rootDir,
      tool: "validate_change",
      ask: "validate src/a.ts",
      verdict: "1 drift: async",
    });

    const events = await readSessionEvents(sessionFilePath(sessionsDir, hash, "live"));
    const types = events.map((e) => e.type);
    expect(types).toContain("mcp_ask");
    expect(types).toContain("mcp_verdict");
    const ask = events.find((e) => e.type === "mcp_ask")!;
    expect(ask.channel).toBe("mcp");
    expect(ask.detail.toolName).toBe("validate_change");
  });

  it("finds the ledger even when rootDir is given via a symlink (canonicalized)", async () => {
    const { symlinkSync } = await import("node:fs");
    const sessionsDir = tmp();
    const realRoot = tmp();
    const hash = projectHash(realRoot); // hooks key on the canonical (real) path
    await appendEvent(sessionsDir, hash, "live", ev("live"));

    // an aliased path to the same repo (the trap: /tmp vs /private/tmp)
    const linkRoot = join(tmp(), "aliased");
    symlinkSync(realRoot, linkRoot);

    await teeMcpVerdict({ sessionsDir, rootDir: linkRoot, tool: "t", ask: "a", verdict: "v" });

    const events = await readSessionEvents(sessionFilePath(sessionsDir, hash, "live"));
    expect(events.map((e) => e.type)).toContain("mcp_verdict");
  });

  it("is a no-op and does not throw when there is no session", async () => {
    const rootDir = tmp();
    await expect(
      teeMcpVerdict({ sessionsDir: tmp(), rootDir, tool: "t", ask: "a", verdict: "v" }),
    ).resolves.toBeUndefined();
  });

  it("does not write to a session older than the active window", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    await appendEvent(sessionsDir, hash, "stale", ev("stale"));
    // age the file well past the window
    const old = Date.now() / 1000 - (ACTIVE_WINDOW_MS / 1000) - 60;
    utimesSync(sessionFilePath(sessionsDir, hash, "stale"), old, old);

    await teeMcpVerdict({ sessionsDir, rootDir, tool: "t", ask: "a", verdict: "v" });

    const events = await readSessionEvents(sessionFilePath(sessionsDir, hash, "stale"));
    expect(events.map((e) => e.type)).toEqual(["session_start"]);
  });
});
