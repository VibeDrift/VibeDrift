import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoIdentity } from "@/session/repo";

// One agent session, many repos. The hook used to resolve ONE project per hook
// call from the agent's working folder, so every edit in a session was recorded
// against that repo and checked against its patterns — including edits in a
// sibling checkout that shares none of them. These tests pin the rule that
// replaced it: the repo that owns the edited file owns the event.
vi.setConfig({ testTimeout: 60_000 });

const ENTRY = join(process.cwd(), "src", "session", "hook-entry.ts");
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function runHook(home: string, payload: unknown, extra: Record<string, string> = {}) {
  return spawnSync(TSX, [ENTRY], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "", ...extra },
    timeout: 30_000,
  });
}

/** A workspace folder that is NOT itself a repo, holding two repos. */
function stage(): { home: string; workspace: string; alpha: string; beta: string } {
  const home = tmp("vd-ws-home-");
  const workspace = tmp("vd-ws-");
  const alpha = join(workspace, "alpha");
  const beta = join(workspace, "beta");
  for (const r of [alpha, beta]) {
    mkdirSync(join(r, ".git"), { recursive: true });
    mkdirSync(join(r, "src"), { recursive: true });
  }
  return { home, workspace, alpha, beta };
}

function writeActivation(
  home: string,
  store: { projects?: Record<string, unknown>; dirGrants?: Array<{ path: string; at: string }> },
): void {
  mkdirSync(join(home, ".vibedrift"), { recursive: true });
  writeFileSync(
    join(home, ".vibedrift", "activation.json"),
    JSON.stringify({ v: 1, projects: {}, dirGrants: [], nameShares: [], ...store }),
  );
}

const grant = (home: string, dir: string, projects: Record<string, unknown> = {}) =>
  writeActivation(home, { dirGrants: [{ path: dir, at: new Date().toISOString() }], projects });

function ledgerDir(home: string, hash: string): string {
  return join(home, ".vibedrift", "sessions", hash);
}
function events(home: string, hash: string, sid: string): Array<Record<string, any>> {
  const path = join(ledgerDir(home, hash), `${sid}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const writeFileEvent = (cwd: string, sid: string, file: string, content: string) => ({
  session_id: sid,
  cwd,
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: file, content },
});

const BODY = "export function helper(n: number): number {\n  return n * 2;\n}\n";

describe("one session, many repos (integration)", () => {
  it("records an edit in the repo that OWNS the file, stamped with the workspace", () => {
    const { home, workspace, alpha } = stage();
    grant(home, workspace);
    const sid = "it-ws-own";
    const r = runHook(home, writeFileEvent(workspace, sid, join(alpha, "src", "x.ts"), BODY));
    expect(r.status).toBe(0);

    const alphaHash = repoIdentity(alpha).projectHash;
    const wsHash = repoIdentity(workspace).projectHash;
    const mine = events(home, alphaHash, sid);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      type: "edit",
      projectHash: alphaHash,
      workspaceKey: wsHash,
      detail: { file: "src/x.ts", inRepo: true },
    });
    // the path is relative to ALPHA, not to the folder the agent ran in
    expect(JSON.stringify(mine[0])).not.toContain("alpha/src/x.ts");
    // and the workspace's own ledger never saw it
    expect(events(home, wsHash, sid).filter((e) => e.type === "edit")).toEqual([]);
  });

  it("keeps a file that belongs to no repo with the workspace, unstamped", () => {
    const { home, workspace } = stage();
    grant(home, workspace);
    const sid = "it-ws-loose";
    expect(runHook(home, writeFileEvent(workspace, sid, join(workspace, "notes.ts"), BODY)).status).toBe(0);
    const wsHash = repoIdentity(workspace).projectHash;
    const evs = events(home, wsHash, sid);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: "edit", projectHash: wsHash, detail: { file: "notes.ts" } });
    // the workspace IS its own scope, so there is nothing to group it under
    expect("workspaceKey" in evs[0]).toBe(false);
  });

  it("records nothing for a repo that declined, even inside a granted workspace", () => {
    const { home, workspace, alpha, beta } = stage();
    const betaHash = repoIdentity(beta).projectHash;
    grant(home, workspace, { [betaHash]: { state: "declined", at: new Date().toISOString(), surface: "cli-decline" } });
    const sid = "it-ws-declined";

    expect(runHook(home, writeFileEvent(workspace, sid, join(beta, "src", "y.ts"), BODY)).status).toBe(0);
    expect(events(home, betaHash, sid)).toEqual([]);
    expect(existsSync(join(ledgerDir(home, betaHash), `${sid}.jsonl`))).toBe(false);

    // the grant still covers its sibling, so this is a per-repo no, not an outage
    expect(runHook(home, writeFileEvent(workspace, sid, join(alpha, "src", "y.ts"), BODY)).status).toBe(0);
    expect(events(home, repoIdentity(alpha).projectHash, sid)).toHaveLength(1);
  });

  it("records nothing for a repo nobody answered for, and does not fold it into the workspace", () => {
    const { home, workspace, alpha } = stage();
    writeActivation(home, {}); // no grant, no answers
    const sid = "it-ws-unanswered";
    expect(runHook(home, writeFileEvent(workspace, sid, join(alpha, "src", "z.ts"), BODY)).status).toBe(0);
    expect(events(home, repoIdentity(alpha).projectHash, sid)).toEqual([]);
    expect(events(home, repoIdentity(workspace).projectHash, sid)).toEqual([]);
  });

  it("keeps the grandfather: an unanswered repo with its own hook install still records", () => {
    const { home, workspace, alpha } = stage();
    writeActivation(home, {});
    mkdirSync(join(alpha, ".claude"), { recursive: true });
    writeFileSync(
      join(alpha, ".claude", "settings.local.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node hook.js #vibedrift-hook" }] }] } }),
    );
    const sid = "it-ws-grandfather";
    expect(runHook(home, writeFileEvent(workspace, sid, join(alpha, "src", "z.ts"), BODY)).status).toBe(0);
    expect(events(home, repoIdentity(alpha).projectHash, sid)).toHaveLength(1);
  });

});
