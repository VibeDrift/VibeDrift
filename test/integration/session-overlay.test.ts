import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The baseline's duplicate index is built at scan time and never grows during
// a session. On a recorded session two byte-identical `monthTitle` functions
// were written fifteen minutes apart, both through the Write tool, and no
// flag fired: the first copy was born inside the session. The overlay index
// keeps what the session wrote, so the second copy matches the first; and a
// stale baseline is rebuilt in the background at Stop once the session has
// written code it never saw.
const ENTRY = join(process.cwd(), "src", "session", "hook-entry.ts");
const BUILDER = join(process.cwd(), "test", "helpers", "session-build-baseline.ts");
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");

const MONTH_TITLE = [
  "export function monthTitle(ym: string): string {",
  '  const [y, m] = ym.split("-").map(Number);',
  '  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });',
  "}",
].join("\n");

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
/** Block the test thread without spinning (the seam child is a separate process). */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function waitFor(cond: () => boolean, timeoutMs: number): void {
  const until = Date.now() + timeoutMs;
  while (!cond() && Date.now() < until) sleep(100);
}
function env(home: string, extra: Record<string, string> = {}) {
  return { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "", ...extra };
}
function runHook(home: string, payload: unknown, extra: Record<string, string> = {}) {
  return spawnSync(TSX, [ENTRY], { input: JSON.stringify(payload), encoding: "utf8", env: env(home, extra), timeout: 30_000 });
}
function ledger(home: string, sid: string): Array<Record<string, unknown> & { detail: Record<string, unknown> }> {
  const sessions = join(home, ".vibedrift", "sessions");
  const hashDir = readdirSync(sessions)[0];
  return readFileSync(join(sessions, hashDir, `${sid}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
function stageRepo(): { home: string; repo: string } {
  const home = tmp("vd-home-");
  const repo = tmp("vd-repo-");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "src", "components"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export async function a(){ return await fetch('/a'); }\n");
  const build = spawnSync(TSX, [BUILDER, repo], { encoding: "utf8", env: env(home), timeout: 60_000 });
  expect(build.status).toBe(0);
  return { home, repo };
}
const write = (repo: string, sid: string, rel: string, content: string) => ({
  session_id: sid,
  cwd: repo,
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: join(repo, rel), content },
});

describe("session overlay index (integration)", () => {
  it("flags a duplicate of a function the SAME session wrote, naming where it was first written", () => {
    const { home, repo } = stageRepo();
    const sid = "it-overlay";
    writeFileSync(join(repo, "src", "components", "OpensOnCalendar.tsx"), `${MONTH_TITLE}\n`);
    const first = runHook(home, write(repo, sid, "src/components/OpensOnCalendar.tsx", MONTH_TITLE));
    expect(first.status).toBe(0); // nothing in the baseline matches it
    writeFileSync(join(repo, "src", "components", "ProfileTimeStrip.tsx"), `${MONTH_TITLE}\n`);
    const second = runHook(home, write(repo, sid, "src/components/ProfileTimeStrip.tsx", MONTH_TITLE));
    expect(second.status).toBe(2);
    expect(second.stderr).toContain(
      "your monthTitle (src/components/ProfileTimeStrip.tsx:1) duplicates monthTitle (src/components/OpensOnCalendar.tsx:1), 1.00 similar",
    );
    const flags = ledger(home, sid).filter((e) => e.type === "flag" && e.detail.category === "redundancy");
    expect(flags).toHaveLength(1);
    expect(flags[0].detail.similarTo).toBe("src/components/OpensOnCalendar.tsx:1");
  });

  it("a file never matches its own earlier version", () => {
    const { home, repo } = stageRepo();
    const sid = "it-overlay-self";
    writeFileSync(join(repo, "src", "components", "A.tsx"), `${MONTH_TITLE}\n`);
    expect(runHook(home, write(repo, sid, "src/components/A.tsx", MONTH_TITLE)).status).toBe(0);
    // re-write the same file: its own previous entries must not count
    expect(runHook(home, write(repo, sid, "src/components/A.tsx", MONTH_TITLE)).status).toBe(0);
    expect(ledger(home, sid).some((e) => e.type === "flag")).toBe(false);
  });

  it("rebuilds a stale baseline at Stop, once, through the detached seam", () => {
    const { home, repo } = stageRepo();
    const sid = "it-rebuild";
    const marker = join(tmp("vd-rebuild-seam-"), "called");
    const seam = join(tmp("vd-rebuild-seam-"), "seam.sh");
    writeFileSync(seam, `#!/usr/bin/env bash\nprintf '%s' "$1" >> ${marker}\n`, { mode: 0o755 });
    chmodSync(seam, 0o755);
    const extra = { VIBEDRIFT_BASELINE_REBUILD_CMD: seam };
    // Stop with nothing written this session: no rebuild
    expect(runHook(home, { session_id: sid, cwd: repo, hook_event_name: "Stop" }, extra).status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    // a checked edit puts something in the overlay
    writeFileSync(join(repo, "src", "components", "New.tsx"), `${MONTH_TITLE}\n`);
    expect(runHook(home, write(repo, sid, "src/components/New.tsx", MONTH_TITLE), extra).status).toBe(0);
    expect(runHook(home, { session_id: sid, cwd: repo, hook_event_name: "Stop" }, extra).status).toBe(0);
    waitFor(() => existsSync(marker), 6000);
    expect(readFileSync(marker, "utf8")).toBe(repo);
    // a second Stop inside the interval does not rebuild again: give a
    // detached child that SHOULD NOT exist time to have appended, then assert
    expect(runHook(home, { session_id: sid, cwd: repo, hook_event_name: "Stop" }, extra).status).toBe(0);
    sleep(1500);
    expect(readFileSync(marker, "utf8")).toBe(repo);
  });
});
