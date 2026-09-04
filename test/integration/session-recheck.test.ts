import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test here spawns tsx processes (hook entry, baseline builder, CLI);
// on a CI runner one test takes 4 to 8 s, past vitest's default 5 s.
vi.setConfig({ testTimeout: 60_000 });

const CLI = join(process.cwd(), "src", "cli", "index.ts");
const HOOK = join(process.cwd(), "src", "session", "hook-entry.ts");
const BUILDER = join(process.cwd(), "test", "helpers", "session-build-baseline.ts");
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");

const HELPER = [
  "export function exponentialBackoff(attempt: number): number {",
  "  const base = 250;",
  "  const cap = 30_000;",
  "  const jitter = Math.random() * 100;",
  "  return Math.min(cap, base * 2 ** attempt) + jitter;",
  "}",
].join("\n");

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
function env(home: string) {
  return { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "" };
}
function run(home: string, args: string[]) {
  return spawnSync(TSX, [CLI, ...args], { encoding: "utf8", env: env(home), timeout: 120_000 });
}
function ledger(home: string, sid: string): Array<Record<string, unknown>> {
  const sessions = join(home, ".vibedrift", "sessions");
  const hashDir = readdirSync(sessions)[0];
  return readFileSync(join(sessions, hashDir, `${sid}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

/** A repo with a baseline, and one session that raised a duplicate flag on
 *  src/retry.ts through the hook, then "fixed" it through a path the hook
 *  never saw (a plain file write, as a Bash heredoc before the Bash hook). */
function stage(): { home: string; repo: string } {
  const home = tmp("vd-recheck-home-");
  const repo = tmp("vd-recheck-repo-");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "src", "lib"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export async function a(){ return await fetch('/a'); }\n");
  writeFileSync(join(repo, "src", "lib", "backoff.ts"), `${HELPER}\n`);
  expect(spawnSync(TSX, [BUILDER, repo], { encoding: "utf8", env: env(home), timeout: 60_000 }).status).toBe(0);
  writeFileSync(join(repo, "src", "retry.ts"), `${HELPER}\n`);
  const flagged = spawnSync(TSX, [HOOK], {
    input: JSON.stringify({
      session_id: "s-stale",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(repo, "src", "retry.ts"), content: HELPER },
    }),
    encoding: "utf8",
    env: env(home),
    timeout: 30_000,
  });
  expect(flagged.status).toBe(2);
  expect(flagged.stderr).toContain("(DF-1)");
  return { home, repo };
}

describe("vibedrift recheck-session (integration)", () => {
  it("refuses without a baseline and says what to run", () => {
    const home = tmp("vd-recheck-nobase-");
    const repo = tmp("vd-recheck-norepo-");
    mkdirSync(join(repo, ".git"));
    const r = run(home, ["recheck-session", repo]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("No drift baseline");
  });

  // The duplicate arm of the presence predicate queries the baseline's
  // minhash index. A version bump means those persisted token streams came
  // from a different tokenizer, so a clone that is still there can look
  // absent. Every arm is OR'd, so a weaker one can only CLEAR findings, which
  // is the wrong direction for a command whose job is deciding what is fixed.
  it("refuses a baseline built by another version rather than clearing against it", () => {
    const { home, repo } = stage();
    const cacheDir = join(home, ".vibedrift", "baseline-cache");
    const cached = join(cacheDir, readdirSync(cacheDir)[0]);
    const b = JSON.parse(readFileSync(cached, "utf8"));
    const realVersion = b.version;
    b.version = realVersion - 1;
    writeFileSync(cached, JSON.stringify(b));
    const r = run(home, ["recheck-session", repo]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("built by another version of VibeDrift");
    expect(r.stdout).toContain("vibedrift scan");
    // nothing was appended to the ledger: no resolve, no clear
    expect(ledger(home, "s-stale").some((e) => e.type === "resolve")).toBe(false);
    // and with the real version restored it runs normally again
    b.version = realVersion;
    writeFileSync(cached, JSON.stringify(b));
    expect(run(home, ["recheck-session", repo, "--dry-run"]).stdout).not.toContain("built by another version");
  });

  it("dry run reports what it would clear and writes nothing", () => {
    const { home, repo } = stage();
    writeFileSync(join(repo, "src", "retry.ts"), 'export { exponentialBackoff } from "./lib/backoff";\n');
    const before = ledger(home, "s-stale").length;
    const r = run(home, ["recheck-session", repo, "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("would clear 1");
    expect(r.stdout).toContain("DF-1");
    expect(ledger(home, "s-stale").length).toBe(before);
  });

  it("clears a stale finding whose construct is gone, tagged via recheck, and leaves a live one open", () => {
    const { home, repo } = stage();
    writeFileSync(join(repo, "src", "retry.ts"), 'export { exponentialBackoff } from "./lib/backoff";\n');
    const r = run(home, ["recheck-session", repo]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("cleared 1");
    const events = ledger(home, "s-stale");
    const resolve = events.find((e) => e.type === "resolve") as Record<string, unknown> & { detail: Record<string, unknown> };
    expect(resolve).toBeTruthy();
    expect(resolve.findingId).toBe("DF-1");
    expect(resolve.outcome).toBe("resolved");
    expect(resolve.detail.via).toBe("recheck");
    // idempotent: nothing open any more
    const again = run(home, ["recheck-session", repo]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("No open findings");
  });

  it("keeps a finding open while the clone is still there, and --json reports it", () => {
    const { home, repo } = stage();
    const r = run(home, ["recheck-session", repo, "--json"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.sessions[0].sessionId).toBe("s-stale");
    expect(out.sessions[0].resolved).toEqual([]);
    expect(out.sessions[0].stillOpen.map((f: { findingId: string }) => f.findingId)).toEqual(["DF-1"]);
    expect(ledger(home, "s-stale").some((e) => e.type === "resolve")).toBe(false);
  });
});
