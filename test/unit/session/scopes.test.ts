import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_SESSION_SCOPES,
  readSessionScopes,
  recordSessionScope,
  sessionScopesPath,
} from "@/session/scopes";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

let sessionsDir: string;
const WS = "feedfacefeedface";
const SID = "s-scopes";

beforeEach(() => {
  sessionsDir = tmp("vd-scopes-");
});

describe("session scope index", () => {
  it("is empty before anything records", async () => {
    expect(await readSessionScopes(sessionsDir, WS, SID)).toEqual([]);
  });

  it("remembers each repo a session recorded into, in order", async () => {
    await recordSessionScope(sessionsDir, WS, SID, { projectHash: WS, rootDir: "/w" });
    await recordSessionScope(sessionsDir, WS, SID, { projectHash: "aaaabbbbccccdddd", rootDir: "/w/alpha" });
    expect(await readSessionScopes(sessionsDir, WS, SID)).toEqual([
      { projectHash: WS, rootDir: "/w" },
      { projectHash: "aaaabbbbccccdddd", rootDir: "/w/alpha" },
    ]);
  });

  it("is idempotent per repo, so a hundred edits write one entry", async () => {
    for (let i = 0; i < 5; i++) {
      await recordSessionScope(sessionsDir, WS, SID, { projectHash: "aaaabbbbccccdddd", rootDir: "/w/alpha" });
    }
    expect(await readSessionScopes(sessionsDir, WS, SID)).toHaveLength(1);
  });

  it("stops at MAX_SESSION_SCOPES rather than growing without bound", async () => {
    for (let i = 0; i < MAX_SESSION_SCOPES + 5; i++) {
      await recordSessionScope(sessionsDir, WS, SID, {
        projectHash: `hash${String(i).padStart(12, "0")}`,
        rootDir: `/w/r${i}`,
      });
    }
    expect(await readSessionScopes(sessionsDir, WS, SID)).toHaveLength(MAX_SESSION_SCOPES);
  });

  it("reads a corrupt or foreign file as empty instead of throwing", async () => {
    mkdirSync(join(sessionsDir, WS), { recursive: true });
    writeFileSync(sessionScopesPath(sessionsDir, WS, SID), "{not json");
    expect(await readSessionScopes(sessionsDir, WS, SID)).toEqual([]);
  });

  it("drops entries that are not a hash/root pair", async () => {
    mkdirSync(join(sessionsDir, WS), { recursive: true });
    writeFileSync(
      sessionScopesPath(sessionsDir, WS, SID),
      JSON.stringify({ v: 1, scopes: [{ projectHash: 7 }, { projectHash: "aaaabbbbccccdddd", rootDir: "/w/a" }] }),
    );
    expect(await readSessionScopes(sessionsDir, WS, SID)).toEqual([
      { projectHash: "aaaabbbbccccdddd", rootDir: "/w/a" },
    ]);
  });

  it("never lands in a file the uploader would read (it is not .jsonl)", async () => {
    await recordSessionScope(sessionsDir, WS, SID, { projectHash: WS, rootDir: "/w" });
    const path = sessionScopesPath(sessionsDir, WS, SID);
    expect(path.endsWith(".jsonl")).toBe(false);
    expect(path.endsWith(".scopes.json")).toBe(true);
    // and it is the only thing that carries a machine path for this session
    expect(readFileSync(path, "utf8")).toContain("/w");
  });
});
