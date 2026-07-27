import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Write an executable shell script that records its first two argv into `marker`. */
function markerScript(marker: string): string {
  const path = join(tmp("vd-flush-seam-"), "seam.sh");
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s %s' "$1" "$2" > ${marker}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

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

  it("asks at most 3 times, then goes quiet WITHOUT declining (capture continues)", () => {
    const home = tmp("vd-nudge-home-");
    const repo = repoDir();
    // three genuinely-new sessions
    const a = runStart(home, repo, "startup", "s1");
    const b = runStart(home, repo, "startup", "s2");
    const c = runStart(home, repo, "startup", "s3");
    expect(a.stdout).toContain("additionalContext");
    expect(b.stdout).toContain("additionalContext");
    expect(c.stdout).toContain("additionalContext");
    // the third (final) ask carries the breadcrumb
    expect(JSON.parse(c.stdout.trim()).systemMessage).toContain("vibedrift enable");
    // ...but expiry must NOT write `declined` — the repo stays unanswered so a
    // grandfathered install keeps capturing.
    const rec = Object.values(activation(home).projects)[0] as { state?: string; breadcrumbShown?: boolean };
    expect(rec.state).toBeUndefined();
    expect(rec.breadcrumbShown).toBe(true);
    // a fourth session is silent (no re-nudge)
    expect(runStart(home, repo, "startup", "s4").stdout.trim()).toBe("");
    // and capture still works: an edit event after expiry lands in the ledger
    spawnSync(TSX, [ENTRY], {
      input: JSON.stringify({
        session_id: "s4",
        cwd: repo,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(repo, "x.ts"), content: "export const x = 1;\n" },
      }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "" },
      timeout: 30_000,
    });
    const sessions = join(home, ".vibedrift", "sessions");
    const captured = readFileSync(
      join(sessions, readdirSync(sessions)[0], "s4.jsonl"),
      "utf8",
    );
    expect(captured).toContain('"type":"edit"');
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
    expect(existsSync(join(home, ".vibedrift", "sessions"))).toBe(false);
    // A locked account is never asked to ENABLE (no model-facing nudge) — it is
    // told why recording stopped. The lock notice is a bare systemMessage.
    const out = JSON.parse(r.stdout.trim());
    expect(out).not.toHaveProperty("hookSpecificOutput");
    expect(out.systemMessage).toContain("trial is used up");
  });
});

describe("Stop-hook session-flush spawn (integration)", () => {
  const flushHook = (
    home: string,
    repo: string,
    extraEnv: Record<string, string> = {},
  ) =>
    spawnSync(TSX, [ENTRY], {
      input: JSON.stringify({ session_id: "end-1", cwd: repo, hook_event_name: "Stop" }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "", ...extraEnv },
      timeout: 30_000,
    });

  function config(home: string, cfg: Record<string, unknown>): void {
    mkdirSync(join(home, ".vibedrift"), { recursive: true });
    writeFileSync(join(home, ".vibedrift", "config.json"), JSON.stringify(cfg));
  }

  it("spawns the flush on Stop when hosted sync is opted in + logged in", () => {
    const home = tmp("vd-flush-home-");
    const repo = repoDir();
    const marker = join(tmp("vd-flush-marker-"), "fired");
    config(home, { token: "t", plan: "pro", sessionsSyncEnabled: true });
    const r = flushHook(home, repo, { VIBEDRIFT_SESSION_FLUSH_CMD: markerScript(marker) });
    expect(r.status).toBe(0);
    // detached child is async; poll briefly for the marker
    const deadline = Date.now() + 4000;
    while (!existsSync(marker) && Date.now() < deadline) {
      spawnSync("sleep", ["0.05"]);
    }
    expect(existsSync(marker)).toBe(true);
    const [hash, dir] = readFileSync(marker, "utf8").split(" ");
    expect(hash).toMatch(/^[0-9a-f]{16}$/); // projectHash
    expect(dir).toContain(".vibedrift"); // sessionsDir
  });

  it("spawns nothing when hosted sync is off (local-only stays offline)", () => {
    const home = tmp("vd-flush-home-");
    const repo = repoDir();
    const marker = join(tmp("vd-flush-marker-"), "fired");
    config(home, { token: "t", plan: "pro", sessionsSyncEnabled: false });
    flushHook(home, repo, { VIBEDRIFT_SESSION_FLUSH_CMD: markerScript(marker) });
    // give any (erroneous) child time to run
    spawnSync("sleep", ["0.4"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("spawns nothing when logged out", () => {
    const home = tmp("vd-flush-home-");
    const repo = repoDir();
    const marker = join(tmp("vd-flush-marker-"), "fired");
    config(home, { plan: "pro", sessionsSyncEnabled: true }); // no token
    flushHook(home, repo, { VIBEDRIFT_SESSION_FLUSH_CMD: markerScript(marker) });
    spawnSync("sleep", ["0.4"]);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("entitlement lock in the native path (integration)", () => {
  function config(home: string, cfg: Record<string, unknown>): void {
    mkdirSync(join(home, ".vibedrift"), { recursive: true });
    writeFileSync(join(home, ".vibedrift", "config.json"), JSON.stringify(cfg));
  }

  function entitlement(home: string, e: Record<string, unknown>): void {
    mkdirSync(join(home, ".vibedrift"), { recursive: true });
    writeFileSync(join(home, ".vibedrift", "sessions-entitlement.json"), JSON.stringify(e));
  }

  const LOCKED = {
    entitled: false,
    reason: "locked",
    plan: "free",
    trialUsed: 5,
    trialLimit: 5,
    checkedAt: new Date().toISOString(),
  };

  function activate(home: string, repo: string): void {
    // capture a projectHash by running one startup, then mark the repo active
    runStart(home, repo, "startup");
    const store = JSON.parse(readFileSync(join(home, ".vibedrift", "activation.json"), "utf8"));
    const hash = Object.keys(store.projects)[0];
    store.projects[hash] = { state: "active", surface: "cli-enable" };
    writeFileSync(join(home, ".vibedrift", "activation.json"), JSON.stringify(store));
  }

  const stopHook = (home: string, repo: string, extraEnv: Record<string, string> = {}) =>
    spawnSync(TSX, [ENTRY], {
      input: JSON.stringify({ session_id: "end-1", cwd: repo, hook_event_name: "Stop" }),
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, VIBEDRIFT_HOOK_DEBUG: "", ...extraEnv },
      timeout: 30_000,
    });

  it("tells the user why nothing is recorded when the trial is spent", () => {
    const home = tmp("vd-lock-home-");
    const repo = repoDir();
    activate(home, repo);
    entitlement(home, LOCKED);
    const r = runStart(home, repo, "startup", "s2");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.systemMessage).toContain("trial is used up");
    expect(out.systemMessage).toContain("vibedrift upgrade");
  });

  it("captures nothing while locked", () => {
    const home = tmp("vd-lock-home-");
    const repo = repoDir();
    activate(home, repo);
    const before = readdirSync(join(home, ".vibedrift", "sessions"), { recursive: true }).length;
    entitlement(home, LOCKED);
    runStart(home, repo, "startup", "s3");
    const after = readdirSync(join(home, ".vibedrift", "sessions"), { recursive: true }).length;
    expect(after).toBe(before); // no new ledger written
  });

  it("STILL spawns the flush on Stop while locked, so upgrading can unlock", () => {
    const home = tmp("vd-lock-home-");
    const repo = repoDir();
    activate(home, repo);
    entitlement(home, LOCKED);
    config(home, { token: "t", plan: "free", sessionsSyncEnabled: true });
    const marker = join(tmp("vd-lock-marker-"), "fired");
    const r = stopHook(home, repo, { VIBEDRIFT_SESSION_FLUSH_CMD: markerScript(marker) });
    expect(r.status).toBe(0);
    const deadline = Date.now() + 4000;
    while (!existsSync(marker) && Date.now() < deadline) spawnSync("sleep", ["0.05"]);
    expect(existsSync(marker)).toBe(true);
  });

  it("stays silent while locked in a non-interactive context (no upsell in CI logs)", () => {
    const home = tmp("vd-lock-home-");
    const repo = repoDir();
    activate(home, repo);
    entitlement(home, LOCKED);
    const r = runStart(home, repo, "startup", "s5", { VIBEDRIFT_HOOK_NONINTERACTIVE: "1" });
    expect(r.stdout.trim()).toBe("");
  });

  it("stays silent while locked on resume/compact (not a new session)", () => {
    const home = tmp("vd-lock-home-");
    const repo = repoDir();
    activate(home, repo);
    entitlement(home, LOCKED);
    expect(runStart(home, repo, "resume", "s6").stdout.trim()).toBe("");
    expect(runStart(home, repo, "compact", "s7").stdout.trim()).toBe("");
  });

  it("emits no lock notice while the account is still entitled", () => {
    const home = tmp("vd-lock-home-");
    const repo = repoDir();
    activate(home, repo);
    entitlement(home, { ...LOCKED, entitled: true, reason: "trial", trialUsed: 1 });
    const r = runStart(home, repo, "startup", "s4");
    expect(r.stdout.trim() === "" || !r.stdout.includes("trial is used up")).toBe(true);
  });
});
