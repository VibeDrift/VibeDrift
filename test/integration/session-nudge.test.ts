import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(process.cwd(), "src", "session", "hook-entry.ts");
const TSX = join(process.cwd(), "node_modules", ".bin", "tsx");

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function runStart(
  home: string,
  repo: string,
  source: string,
  sessionId = "s1",
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(TSX, [ENTRY], {
    input: JSON.stringify({ session_id: sessionId, cwd: repo, hook_event_name: "SessionStart", source }),
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "", ...extraEnv },
    timeout: 30_000,
  });
}

function activation(home: string): { projects: Record<string, { state?: string; surface?: string }> } {
  return JSON.parse(readFileSync(join(home, ".vibedrift", "activation.json"), "utf8"));
}

function repoDir(): string {
  const repo = tmp("vd-nudge-repo-");
  mkdirSync(join(repo, ".git"));
  return repo;
}

describe("SessionStart nudge (integration)", () => {
  it("emits the activation nudge for an un-activated repo on a new interactive session", () => {
    const home = tmp("vd-nudge-home-");
    const r = runStart(home, repoDir(), "startup");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("NOT active");
  });

  it("stays silent on resume/compact (continuation, not a new session)", () => {
    const home = tmp("vd-nudge-home-");
    const repo = repoDir();
    expect(runStart(home, repo, "resume").stdout.trim()).toBe("");
    expect(runStart(home, repo, "compact").stdout.trim()).toBe("");
  });

  it("stays silent in a non-interactive/headless context and does not burn budget", () => {
    const home = tmp("vd-nudge-home-");
    const repo = repoDir();
    const r = runStart(home, repo, "startup", "s1", { VIBEDRIFT_HOOK_NONINTERACTIVE: "1" });
    expect(r.stdout.trim()).toBe("");
    // no ask consumed -> no activation record yet
    expect(existsSync(join(home, ".vibedrift", "activation.json"))).toBe(false);
  });

  it("stays silent once the repo is declined", () => {
    const home = tmp("vd-nudge-home-");
    const repo = repoDir();
    // first startup nudges + records askCount 1; decline it explicitly
    runStart(home, repo, "startup");
    const store = activation(home);
    const hash = Object.keys(store.projects)[0];
    // write a decline directly
    const path = join(home, ".vibedrift", "activation.json");
    const cur = JSON.parse(readFileSync(path, "utf8"));
    cur.projects[hash] = { state: "declined", surface: "cli-decline" };
    writeFileSync(path, JSON.stringify(cur));
    const r = runStart(home, repo, "startup", "s2");
    expect(r.stdout.trim()).toBe("");
  });

  it("asks at most 3 times, then records an implicit decline with the breadcrumb", () => {
    const home = tmp("vd-nudge-home-");
    const repo = repoDir();
    // three genuinely-new sessions
    const a = runStart(home, repo, "startup", "s1");
    const b = runStart(home, repo, "startup", "s2");
    const c = runStart(home, repo, "startup", "s3");
    expect(a.stdout).toContain("additionalContext");
    expect(b.stdout).toContain("additionalContext");
    expect(c.stdout).toContain("additionalContext");
    // the third (final) ask carries the breadcrumb + records the implicit decline
    expect(JSON.parse(c.stdout.trim()).systemMessage).toContain("vibedrift enable");
    const store = activation(home);
    const rec = Object.values(store.projects)[0];
    expect(rec.state).toBe("declined");
    expect(rec.surface).toBe("budget-expiry");
    // a fourth session is silent
    const d = runStart(home, repo, "startup", "s4");
    expect(d.stdout.trim()).toBe("");
  });

  it("shows the honest trial line when the account is on the free trial", () => {
    const home = tmp("vd-nudge-home-");
    const repo = repoDir();
    mkdirSync(join(home, ".vibedrift"), { recursive: true });
    writeFileSync(
      join(home, ".vibedrift", "sessions-entitlement.json"),
      JSON.stringify({ entitled: true, reason: "trial", plan: "free", trialUsed: 2, trialLimit: 5 }),
    );
    const r = runStart(home, repo, "startup");
    expect(JSON.parse(r.stdout.trim()).systemMessage).toContain("2 of 5");
  });

  it("captures nothing and never nudges when the account is locked", () => {
    const home = tmp("vd-nudge-home-");
    const repo = repoDir();
    mkdirSync(join(home, ".vibedrift"), { recursive: true });
    writeFileSync(
      join(home, ".vibedrift", "sessions-entitlement.json"),
      JSON.stringify({ entitled: false, reason: "locked", plan: "free", trialUsed: 5, trialLimit: 5 }),
    );
    const r = runStart(home, repo, "startup");
    expect(r.stdout.trim()).toBe("");
    expect(existsSync(join(home, ".vibedrift", "sessions"))).toBe(false);
  });
});
