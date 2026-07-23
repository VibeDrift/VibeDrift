import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchSession } from "@/cli/commands/watch-session";
import { readConfig } from "@/auth/config";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function repoWithAgent(): string {
  const repo = tmp("vd-ws-");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".claude"));
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("runWatchSession — hosted sync toggle", () => {
  it("--sync on/off flips the config flag and never installs hooks", async () => {
    const home = tmp("vd-ws-home-");
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const repo = repoWithAgent();
      const on = await runWatchSession(repo, { sync: "on" });
      expect(on).toBe("sync_updated");
      expect((await readConfig()).sessionsSyncEnabled).toBe(true);
      // a toggle is a control action — it must not install hooks
      expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);

      const off = await runWatchSession(repo, { sync: "off" });
      expect(off).toBe("sync_updated");
      expect((await readConfig()).sessionsSyncEnabled).toBe(false);
    } finally {
      process.env.HOME = prevHome;
      process.env.USERPROFILE = prevProfile;
    }
  });
});

describe("runWatchSession", () => {
  it("installs hooks with --yes and reports the ledger location", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runWatchSession(repo, { yes: true, sessionsDir });
    expect(status).toBe("installed");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain(sessionsDir);
    expect(printed.toLowerCase()).toContain("fail-open");
  });

  it("reports already on a second run", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runWatchSession(repo, { yes: true, sessionsDir });
    expect(await runWatchSession(repo, { yes: true, sessionsDir })).toBe("already");
  });

  it("uninstalls cleanly", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runWatchSession(repo, { yes: true, sessionsDir });
    const status = await runWatchSession(repo, { uninstall: true, sessionsDir });
    expect(status).toBe("uninstalled");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
  });

  it("reports status without modifying anything", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runWatchSession(repo, { status: true, sessionsDir })).toBe("status");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
  });

  it("exits nonzero when no supported agent is detected", async () => {
    const repo = tmp("vd-ws-none-");
    mkdirSync(join(repo, ".git"));
    const sessionsDir = tmp("vd-ws-sess-");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const home = tmp("vd-ws-home-");
    const status = await runWatchSession(repo, { yes: true, sessionsDir, homeDir: home });
    expect(status).toBe("no_agent");
    expect(process.exitCode).toBe(1);
  });

  it("writes nothing when consent is declined", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runWatchSession(repo, { sessionsDir, confirm: async () => false });
    expect(status).toBe("declined");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
  });

  it("locks (with the trial CTA) and does NOT install when the trial is spent", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    const entDir = tmp("vd-ws-ent-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runWatchSession(repo, {
      yes: true,
      watch: true,
      sessionsDir,
      entitlementDir: entDir,
      resolveEntitlement: async () => ({ entitled: false, reason: "locked", plan: "free", trialUsed: 5, trialLimit: 5 }),
    });
    expect(status).toBe("locked");
    // did not install hooks
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
    // wrote a locked cache the hook will read
    const cache = JSON.parse(readFileSync(join(entDir, "sessions-entitlement.json"), "utf8"));
    expect(cache.entitled).toBe(false);
    // honest CTA copy, no prevention claims
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain("vibedrift upgrade");
    expect(printed.toLowerCase()).not.toContain("prevented");
  });

  it("requires a free account (login) when no entitlement can be resolved", async () => {
    const repo = repoWithAgent();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const status = await runWatchSession(repo, {
      watch: true,
      sessionsDir: tmp("vd-ws-sess-"),
      entitlementDir: tmp("vd-ws-ent-"),
      resolveEntitlement: async () => null,
    });
    expect(status).toBe("login_required");
    expect(process.exitCode).toBe(1);
  });
});
