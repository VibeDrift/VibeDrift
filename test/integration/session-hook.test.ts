import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFileNames } from "@/session/file-names";
import { UploadStateStore } from "@/session/upload-state";
import { toUploadEvent } from "@/session/upload-schema";
import type { SessionEvent } from "@/session/types";

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
    expect(ev.detail.file).toBe("src/a.ts");
    expect(lines[0]).not.toContain("UNIQUE_BODY_SENTINEL_9f2");
    expect(ev.body).toBeUndefined();
    // no baseline in this repo, so the inline check was skipped
    expect(ev.detail.checked).toBe(false);
  });

  it("records checked=false (and only the marked basename) for an out-of-repo edit", () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    const elsewhere = tmp("vd-outside-");
    mkdirSync(join(repo, ".git"));
    const r = runHook(home, {
      session_id: "it-out",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(elsewhere, "notes.ts"), content: "export const x = 1;\n" },
    });
    expect(r.status).toBe(0);
    const ev = JSON.parse(ledgerLines(home, "it-out")[0]);
    expect(ev.type).toBe("edit");
    // the basename only, marked so it can never be read as a repo-root file
    expect(ev.detail.file).toBe("../notes.ts");
    expect(ev.detail.file).not.toContain(elsewhere);
    expect(ev.detail.checked).toBe(false);
    // provenance is stamped at the source: this file was NOT in the repo
    expect(ev.detail.inRepo).toBe(false);
  });

  it("an out-of-repo edit never becomes a file-name manifest entry", async () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    const elsewhere = tmp("vd-outside-");
    mkdirSync(join(repo, ".git"));
    const edit = (file: string) => ({
      session_id: "it-manifest",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: file, content: "export const x = 1;\n" },
    });
    expect(runHook(home, edit(join(repo, "src", "in.ts"))).status).toBe(0);
    // an edit outside the repo, recorded by basename under an out-of-repo marker
    expect(runHook(home, edit(join(elsewhere, "secret-notes.ts"))).status).toBe(0);

    const sessions = join(home, ".vibedrift", "sessions");
    const hash = readdirSync(sessions)[0];
    const ledger = join(sessions, hash, "it-manifest.jsonl");
    const store = new UploadStateStore(sessions, hash);
    await store.load();
    await store.commit(new Map([["it-manifest.jsonl", readFileSync(ledger, "utf8").length]]));

    const events = ledgerLines(home, "it-manifest").map((l) => JSON.parse(l));
    expect(events.map((e) => e.detail.file)).toEqual(["src/in.ts", "../secret-notes.ts"]);
    expect(events.map((e) => e.detail.inRepo)).toEqual([true, false]);

    const entries = await collectFileNames(sessions, hash);
    expect(entries.map((e) => e.path)).toEqual(["src/in.ts"]);
    expect(JSON.stringify(entries)).not.toContain("secret-notes.ts");
  });

  it("an out-of-repo edit can never share a file hash with a repo-ROOT file", async () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    const elsewhere = tmp("vd-outside-");
    mkdirSync(join(repo, ".git"));
    const edit = (file: string) => ({
      session_id: "it-collide",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: file, content: "export const x = 1;\n" },
    });
    // the same basename, once at the repo root and once outside the repo
    expect(runHook(home, edit(join(repo, "notes.ts"))).status).toBe(0);
    expect(runHook(home, edit(join(elsewhere, "notes.ts"))).status).toBe(0);

    const events = ledgerLines(home, "it-collide").map((l) => JSON.parse(l) as SessionEvent);
    const edits = events.filter((e) => e.type === "edit");
    expect(edits.map((e) => e.detail.inRepo)).toEqual([true, false]);
    const [inside, outside] = edits.map((e) => toUploadEvent(e)?.fileHash);
    expect(inside).toMatch(/^[0-9a-f]{16}$/);
    // two different files, so nothing else is recorded: identical recorded
    // paths also had the revert detector read the second edit as the first
    // file being restored.
    expect(events.map((e) => e.type)).toEqual(["edit", "edit"]);
    // The pseudonym the manifest puts a real name on must not ALSO stand for
    // out-of-repo activity, or the dashboard shows an in-repo path on a row
    // that is partly someone else's file.
    expect(outside).not.toBe(inside);

    const sessions = join(home, ".vibedrift", "sessions");
    const hash = readdirSync(sessions)[0];
    const ledger = join(sessions, hash, "it-collide.jsonl");
    const store = new UploadStateStore(sessions, hash);
    await store.load();
    await store.commit(new Map([["it-collide.jsonl", readFileSync(ledger, "utf8").length]]));

    const entries = await collectFileNames(sessions, hash);
    expect(entries).toEqual([{ fileHash: inside, path: "notes.ts" }]);
  });

  it("records a Windows-style relative path portably, so the manifest still fills", async () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    mkdirSync(join(repo, ".git"));
    // Byte for byte what node's relative() returns on win32 for
    // <repo>\src\payments\refund.ts. A backslash is refused by the wire rules,
    // so an unnormalized ledger leaves the manifest permanently empty on
    // Windows while `--names on` still reports success.
    const r = runHook(home, {
      session_id: "it-win",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "src\\payments\\refund.ts", content: "export const x = 1;\n" },
    });
    expect(r.status).toBe(0);
    const event = JSON.parse(ledgerLines(home, "it-win")[0]) as SessionEvent;
    expect(event.detail.file).toBe("src/payments/refund.ts");
    expect(event.detail.inRepo).toBe(true);

    const sessions = join(home, ".vibedrift", "sessions");
    const hash = readdirSync(sessions)[0];
    const ledger = join(sessions, hash, "it-win.jsonl");
    const store = new UploadStateStore(sessions, hash);
    await store.load();
    await store.commit(new Map([["it-win.jsonl", readFileSync(ledger, "utf8").length]]));

    const entries = await collectFileNames(sessions, hash);
    expect(entries.map((e) => e.path)).toEqual(["src/payments/refund.ts"]);
    // and it names the very hash the uploaded event carries for that file
    expect(entries[0].fileHash).toBe(toUploadEvent(event)?.fileHash);
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

  it("exits 0 and writes nothing on a payload missing session_id", () => {
    const home = tmp("vd-home-");
    const repo = tmp("vd-repo-");
    mkdirSync(join(repo, ".git"));
    const r = runHook(home, {
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".vibedrift", "sessions"))).toBe(false);
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
    const events = ledgerLines(home, "it-fyi").map((l) => JSON.parse(l));
    const types = events.map((e) => e.type);
    expect(types).toContain("edit");
    expect(types).toContain("flag");
    // the check ran on this edit, so the ledger records it as checked
    expect(events.find((e) => e.type === "edit").detail.checked).toBe(true);
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
    writeFileSync(join(repo, "src", "report.ts"), thenBody);
    const flagged = runHook(home, editPayload(thenBody));
    expect(flagged.status).toBe(2);

    // 2) re-edit the SAME file to async/await -> the finding resolves. Write the
    // fixed content to disk first: the re-check reads the file from disk, and a
    // read failure now skips resolution entirely (#84), so the fix has to be on
    // disk, exactly as a real Write/Edit tool would leave it.
    const asyncBody = 'export async function r(){ const x = await fetch("/r"); const j = await x.json(); return j.data; }';
    writeFileSync(join(repo, "src", "report.ts"), asyncBody);
    runHook(home, editPayload(asyncBody));

    const events = ledgerLines(home, "res-1").map((l) => JSON.parse(l));
    const types = events.map((e) => e.type);
    expect(types).toContain("flag");
    expect(types).toContain("resolve");
    // checked=true on BOTH edits: the flagged one and the clean fixing one
    const edits = events.filter((e) => e.type === "edit");
    expect(edits).toHaveLength(2);
    for (const e of edits) expect(e.detail.checked).toBe(true);
  });

  it("does not resolve a finding when the post-edit file read fails (#84)", () => {
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

    const reportPath = join(repo, "src", "report.ts");
    const thenBody = [
      "export function r() {",
      '  return fetch("/r")',
      "    .then((x) => x.json())",
      "    .then((j) => j.data);",
      "}",
    ].join("\n");
    // 1) flag the .then() chain (file written to disk, like a real Write)
    writeFileSync(reportPath, thenBody + "\n");
    expect(
      runHook(home, {
        session_id: "readfail-1", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Write",
        tool_input: { file_path: reportPath, content: thenBody },
      }).status,
    ).toBe(2);

    // 2) force the re-check's readFile to throw, then fire a small UNRELATED Edit
    // hunk. Deleting the file (→ ENOENT) forces the failure on every platform and
    // user, unlike chmod 000 which root and Windows ignore. Before the fix the
    // re-check fell back to the hunk and false-resolved the finding; now a read
    // failure skips resolution entirely (#84).
    rmSync(reportPath);
    runHook(home, {
      session_id: "readfail-1", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Edit",
      tool_input: { file_path: reportPath, old_string: "export function r()", new_string: "// unrelated\nexport function r()" },
    });

    const types = ledgerLines(home, "readfail-1").map((l) => JSON.parse(l)).map((e) => e.type);
    expect(types).toContain("flag");
    expect(types).not.toContain("resolve");
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
