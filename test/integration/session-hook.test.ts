import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(process.cwd(), "src", "session", "hook-entry.ts");
const BUILDER = join(process.cwd(), "test", "helpers", "session-build-baseline.ts");
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");

function runHook(home: string, payload: unknown, rawInput?: string) {
  return spawnSync(TSX, [ENTRY], {
    input: rawInput ?? JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "" },
    timeout: 30_000,
  });
}

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function ledgerLines(home: string, sessionId: string): string[] {
  const sessions = join(home, ".vibedrift", "sessions");
  const hashDir = readdirSync(sessions)[0];
  return readFileSync(join(sessions, hashDir, `${sessionId}.jsonl`), "utf8").trim().split("\n");
}

describe("hook entry (integration)", () => {
  it("appends a user_prompt event with masked secrets and exits 0", () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    mkdirSync(join(repo, ".git"));
    const r = runHook(home, {
      session_id: "it-1",
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      prompt: "wire up billing with api_key=abcd1234efgh5678 please",
    });
    expect(r.status).toBe(0);
    const lines = ledgerLines(home, "it-1");
    // first prompt also emits an intent_lock event
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toEqual(["user_prompt", "intent_lock"]);
    const ev = JSON.parse(lines[0]);
    expect(ev.detail.promptText).toContain("[masked]");
    expect(lines[0]).not.toContain("abcd1234efgh5678");
  });

  it("appends an edit event WITHOUT persisting the edit body", () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    mkdirSync(join(repo, ".git"));
    const secretishContent = "export const UNIQUE_BODY_SENTINEL_9f2 = 42;\n";
    const r = runHook(home, {
      session_id: "it-2",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "a.ts"), content: secretishContent },
    });
    expect(r.status).toBe(0);
    const lines = ledgerLines(home, "it-2");
    const ev = JSON.parse(lines[0]);
    expect(ev.type).toBe("edit");
    expect(ev.detail.diffstat).toBe("+1");
    expect(ev.detail.file).toBe(join("src", "a.ts"));
    expect(lines[0]).not.toContain("UNIQUE_BODY_SENTINEL_9f2");
    expect(ev.body).toBeUndefined();
  });

  it("captures NOTHING when the entitlement cache says locked", () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    mkdirSync(join(repo, ".git"));
    // write a locked entitlement cache under this HOME
    mkdirSync(join(home, ".vibedrift"), { recursive: true });
    writeFileSync(
      join(home, ".vibedrift", "sessions-entitlement.json"),
      JSON.stringify({ entitled: false, reason: "locked", plan: "free", trialUsed: 5, trialLimit: 5 }),
    );
    const r = runHook(home, {
      session_id: "locked-1",
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    });
    expect(r.status).toBe(0);
    // no sessions dir / no ledger written
    expect(existsSync(join(home, ".vibedrift", "sessions"))).toBe(false);
  });

  it("exits 0 on malformed stdin (fail-open)", () => {
    const home = tmp("vd-home-");
    const r = runHook(home, null, "{definitely not json");
    expect(r.status).toBe(0);
  });

  it("exits 0 on empty stdin and unknown events", () => {
    const home = tmp("vd-home-");
    expect(runHook(home, null, "").status).toBe(0);
    expect(
      runHook(home, { session_id: "x", cwd: "/", hook_event_name: "Notification" }).status,
    ).toBe(0);
  });

  it("delivers an advisory via exit 2 + stderr when an edit diverges from the baseline", () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "src"), { recursive: true });
    // async/await is the declared + dominant rule
    writeFileSync(join(repo, "CLAUDE.md"), "- Async: use async/await throughout. No .then() chains.\n");
    for (const n of ["a", "b", "c"]) {
      writeFileSync(join(repo, "src", `${n}.ts`), `export async function ${n}(){ return await fetch("/${n}"); }\n`);
    }
    // stage a real baseline under this HOME
    const build = spawnSync(TSX, [BUILDER, repo], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 60_000,
    });
    expect(build.status).toBe(0);

    // an edit written in .then() style should trip the async-consistency flag
    const thenBody = [
      'export function loadReport(id: string) {',
      '  return fetch("/api/report/" + id)',
      "    .then((res) => res.json())",
      "    .then((data) => data.rows);",
      "}",
    ].join("\n");
    const r = runHook(home, {
      session_id: "it-fyi",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "reports.ts"), content: thenBody },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("[vibedrift]");

    // the edit event and at least one flag event are in the ledger
    const types = ledgerLines(home, "it-fyi").map((l) => JSON.parse(l).type);
    expect(types).toContain("edit");
    expect(types).toContain("flag");
  });

  it("resolves a finding when the same file is re-edited to fix it", () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "CLAUDE.md"), "- Async: use async/await throughout. No .then() chains.\n");
    for (const n of ["a", "b", "c"]) {
      writeFileSync(join(repo, "src", `${n}.ts`), `export async function ${n}(){ return await fetch("/${n}"); }\n`);
    }
    const build = spawnSync(TSX, [BUILDER, repo], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 60_000,
    });
    expect(build.status).toBe(0);

    const editPayload = (bodyText: string) => ({
      session_id: "res-1",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "report.ts"), content: bodyText },
    });

    // 1) a .then() body trips the async flag (multi-line: the classifier counts
    // .then( per line and needs >= 2 async ops)
    const thenBody = [
      "export function r() {",
      '  return fetch("/r")',
      "    .then((x) => x.json())",
      "    .then((j) => j.data);",
      "}",
    ].join("\n");
    const flagged = runHook(home, editPayload(thenBody));
    expect(flagged.status).toBe(2);

    // 2) re-edit the SAME file to async/await -> the finding resolves
    runHook(home, editPayload(
      'export async function r(){ const x = await fetch("/r"); const j = await x.json(); return j.data; }',
    ));

    const types = ledgerLines(home, "res-1").map((l) => JSON.parse(l).type);
    expect(types).toContain("flag");
    expect(types).toContain("resolve");
  });

  it("does not re-message (or re-append) an already-open finding on a repeat edit", () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "CLAUDE.md"), "- Async: use async/await throughout. No .then() chains.\n");
    for (const n of ["a", "b", "c"]) {
      writeFileSync(join(repo, "src", `${n}.ts`), `export async function ${n}(){ return await fetch("/${n}"); }\n`);
    }
    expect(
      spawnSync(TSX, [BUILDER, repo], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
        timeout: 60_000,
      }).status,
    ).toBe(0);

    const thenBody = [
      "export function r() {",
      '  return fetch("/r")',
      "    .then((x) => x.json())",
      "    .then((j) => j.data);",
      "}",
    ].join("\n");
    const p = (extra: string) => ({
      session_id: "dedupe-1",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "report.ts"), content: `${thenBody}\n// ${extra}` },
    });

    const first = runHook(home, p("v1"));
    expect(first.status).toBe(2); // flagged + messaged
    // still-.then, so the finding stays open; the repeat must NOT re-message
    const second = runHook(home, p("v2"));
    expect(second.status).toBe(0); // no re-message
    // exactly one flag event for this file|category in the ledger
    const flags = ledgerLines(home, "dedupe-1")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "flag" && e.detail.category === "async_patterns");
    expect(flags).toHaveLength(1);
  });

  it("never emits exit codes other than 0 or 2, even on a bad cwd", () => {
    const home = tmp("vd-home-");
    const r = runHook(home, {
      session_id: "it-3",
      cwd: "/nonexistent-dir-xyz",
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "/nonexistent-dir-xyz/a.ts", old_string: "a", new_string: "x" },
    });
    expect([0, 2]).toContain(r.status);
  });
});
