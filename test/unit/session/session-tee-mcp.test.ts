import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as repo from "@/session/repo";
import { appendEvent, sessionFilePath, readSessionEvents } from "@/session/ledger";
import { projectHash } from "@/core/baseline";
import type { SessionEvent } from "@/session/types";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "vd-teewrap-")));
const startEv = (): SessionEvent => ({
  v: 1, sid: "live", aid: "a", ts: new Date().toISOString(), agent: "claude-code",
  projectHash: "x", channel: "hook", type: "session_start", mode: "passive", detail: {},
});

afterEach(() => vi.restoreAllMocks());

describe("MCP tee summary helpers", () => {
  it("records a validate_change verdict into the active session", async () => {
    const sessionsDir = tmp();
    const rootDir = tmp();
    const hash = projectHash(rootDir);
    await appendEvent(sessionsDir, hash, "live", startEv());
    vi.spyOn(repo, "defaultSessionsDir").mockReturnValue(sessionsDir);

    const { teeValidateChange } = await import("@/mcp/session-tee");
    await teeValidateChange(
      { rootDir, targetPath: "/repo/src/api/billing.ts" },
      { ok: false, conflicts: [{}], duplicateOf: [] },
    );

    const events = await readSessionEvents(sessionFilePath(sessionsDir, hash, "live"));
    const verdict = events.find((e) => e.type === "mcp_verdict");
    expect(verdict?.detail.observed).toContain("1 drift");
    const ask = events.find((e) => e.type === "mcp_ask");
    expect(ask?.detail.promptText).toContain("billing.ts");
  });

  it("no active session: tool still returns, tee is a silent no-op", async () => {
    vi.spyOn(repo, "defaultSessionsDir").mockReturnValue(tmp());
    const { teeFindSimilar } = await import("@/mcp/session-tee");
    await expect(
      teeFindSimilar({ rootDir: tmp() }, { found: true, matches: [{}, {}] }),
    ).resolves.toBeUndefined();
  });
});
