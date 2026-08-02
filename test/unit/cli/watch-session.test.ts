import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWatchSession } from "@/cli/commands/watch-session";
import { readConfig } from "@/auth/config";
import { repoIdentity } from "@/session/repo";
import { loadActivation, shareFileNamesEnabled, namesDeleteIsPending } from "@/session/activation";

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
    const activationHome = tmp("vd-ws-act-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runWatchSession(repo, { yes: true, sessionsDir, activationHome });
    expect(status).toBe("installed");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);
    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain(sessionsDir);
    expect(printed.toLowerCase()).toContain("fail-open");
  });

  it("records the activation answer + consent receipt on a consented install", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    const activationHome = tmp("vd-ws-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runWatchSession(repo, { yes: true, sessionsDir, activationHome });
    const store = JSON.parse(readFileSync(join(activationHome, "activation.json"), "utf8"));
    const hashes = Object.keys(store.projects);
    expect(hashes).toHaveLength(1);
    expect(store.projects[hashes[0]].state).toBe("active");
    expect(store.projects[hashes[0]].surface).toBe("watch-session");
    const receipt = readFileSync(join(sessionsDir, hashes[0], "consent.log"), "utf8");
    expect(JSON.parse(receipt.trim()).action).toBe("enable");
  });

  it("reports already on a second run", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    const activationHome = tmp("vd-ws-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runWatchSession(repo, { yes: true, sessionsDir, activationHome });
    expect(await runWatchSession(repo, { yes: true, sessionsDir, activationHome })).toBe("already");
  });

  it("uninstalls cleanly", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-ws-sess-");
    const activationHome = tmp("vd-ws-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runWatchSession(repo, { yes: true, sessionsDir, activationHome });
    const status = await runWatchSession(repo, { uninstall: true, sessionsDir, activationHome });
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

describe("runWatchSession — file-name sharing toggle (--names)", () => {
  const hashOf = (repo: string) => repoIdentity(repo).projectHash;

  it("--names on prints the disclosure BEFORE writing the flag, and installs nothing", async () => {
    const repo = repoWithAgent();
    const activationHome = tmp("vd-ws-act-");
    const sessionsDir = tmp("vd-ws-sess-");
    const hash = hashOf(repo);
    const lines: string[] = [];
    const flagWhenPrinted: boolean[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
      flagWhenPrinted.push(shareFileNamesEnabled(loadActivation(activationHome), hash));
    });
    const status = await runWatchSession(repo, { names: "on", activationHome, sessionsDir });
    expect(status).toBe("names_updated");
    expect(shareFileNamesEnabled(loadActivation(activationHome), hash)).toBe(true);
    // the whole disclosure was on screen before the flag existed on disk
    const confirmIdx = lines.findIndex((l) => /File names are ON/i.test(l));
    expect(confirmIdx).toBeGreaterThan(0);
    expect(flagWhenPrinted.slice(0, confirmIdx)).toEqual(flagWhenPrinted.slice(0, confirmIdx).map(() => false));
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
  });

  it("the disclosure says paths only, names the reversal, and uses no em-dashes", async () => {
    const repo = repoWithAgent();
    const activationHome = tmp("vd-ws-act-");
    const sessionsDir = tmp("vd-ws-sess-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runWatchSession(repo, { names: "on", activationHome, sessionsDir });
    const printed = log.mock.calls.flat().map(String).join("\n");
    expect(printed).toMatch(/repo-relative/i);
    expect(printed).toMatch(/never .*file contents/i);
    expect(printed).toMatch(/never .*absolute path/i);
    expect(printed).toContain("vibedrift watch-session --names off");
    expect(printed).toMatch(/delete/i);
    expect(printed).not.toMatch(/[—–]/);
  });

  it("--names off deletes the uploaded names, then clears the flag", async () => {
    const repo = repoWithAgent();
    const activationHome = tmp("vd-ws-act-");
    const sessionsDir = tmp("vd-ws-sess-");
    const hash = hashOf(repo);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runWatchSession(repo, { names: "on", activationHome, sessionsDir });
    let deletes = 0;
    const flagWhenDeleted: boolean[] = [];
    const status = await runWatchSession(repo, {
      names: "off",
      activationHome,
      sessionsDir,
      deleteNames: async () => {
        deletes++;
        flagWhenDeleted.push(shareFileNamesEnabled(loadActivation(activationHome), hash));
        return { deleted: 3 };
      },
    });
    expect(status).toBe("names_updated");
    expect(deletes).toBe(1);
    expect(flagWhenDeleted).toEqual([true]); // DELETE first, then clear the flag
    expect(shareFileNamesEnabled(loadActivation(activationHome), hash)).toBe(false);
    expect(namesDeleteIsPending(loadActivation(activationHome), hash)).toBe(false);
    const printed = log.mock.calls.flat().map(String).join("\n");
    expect(printed).toMatch(/File names are OFF/i);
  });

  it("--names off with an unreachable server still turns sharing off and queues the delete", async () => {
    const repo = repoWithAgent();
    const activationHome = tmp("vd-ws-act-");
    const sessionsDir = tmp("vd-ws-sess-");
    const hash = hashOf(repo);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runWatchSession(repo, { names: "on", activationHome, sessionsDir });
    const status = await runWatchSession(repo, {
      names: "off",
      activationHome,
      sessionsDir,
      deleteNames: async () => { throw new Error("offline"); },
    });
    expect(status).toBe("names_updated");
    expect(shareFileNamesEnabled(loadActivation(activationHome), hash)).toBe(false);
    expect(namesDeleteIsPending(loadActivation(activationHome), hash)).toBe(true);
    const printed = log.mock.calls.flat().map(String).join("\n");
    expect(printed).toMatch(/retried on the next/i);
  });
});
