import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runEnable, runDecline } from "@/cli/commands/enable";
import { loadActivation, projectStatus } from "@/session/activation";
import { repoIdentity } from "@/session/repo";

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function repoWithAgent(): string {
  const repo = tmp("vd-en-");
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".claude"));
  return repo;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("runEnable — single repo", () => {
  it("typing enable is the consent: records active, installs hooks, writes a receipt", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-en-sess-");
    const activationHome = tmp("vd-en-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runEnable(repo, { sessionsDir, activationHome });
    expect(status).toBe("enabled");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(true);

    const { projectHash } = repoIdentity(repo);
    const store = loadActivation(activationHome);
    expect(projectStatus(store, projectHash)).toBe("active");
    expect(store.projects[projectHash].surface).toBe("cli-enable");

    const receipt = JSON.parse(readFileSync(join(sessionsDir, projectHash, "consent.log"), "utf8").trim());
    expect(receipt.action).toBe("enable");
    expect(receipt.surface).toBe("cli-enable");
  });

  it("records the answer even with no agent, but does not install hooks", async () => {
    const repo = tmp("vd-en-noagent-");
    mkdirSync(join(repo, ".git"));
    const sessionsDir = tmp("vd-en-sess-");
    const activationHome = tmp("vd-en-act-");
    const emptyHome = tmp("vd-en-home-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runEnable(repo, { sessionsDir, activationHome, homeDir: emptyHome });
    expect(status).toBe("enabled_no_agent");
    expect(existsSync(join(repo, ".claude", "settings.local.json"))).toBe(false);
    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(activationHome), projectHash)).toBe("active");
  });

  it("enables in a plain directory that is not a git repo (scoped to the dir itself)", async () => {
    const dir = tmp("vd-en-nogit-");
    mkdirSync(join(dir, ".claude"));
    const sessionsDir = tmp("vd-en-sess-");
    const activationHome = tmp("vd-en-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runEnable(dir, { sessionsDir, activationHome });
    expect(status).toBe("enabled");
    // identity falls back to the directory itself when no .git ancestor exists
    const { rootDir, projectHash } = repoIdentity(dir);
    expect(rootDir).toBe(dir);
    expect(projectStatus(loadActivation(activationHome), projectHash)).toBe("active");
    const receipt = JSON.parse(readFileSync(join(sessionsDir, projectHash, "consent.log"), "utf8").trim());
    expect(receipt.rootDir).toBe(dir);
  });

  it("a second enable with hooks already installed is idempotent", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-en-sess-");
    const activationHome = tmp("vd-en-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runEnable(repo, { sessionsDir, activationHome })).toBe("enabled");
    const settings = join(repo, ".claude", "settings.local.json");
    const before = readFileSync(settings, "utf8");
    expect(await runEnable(repo, { sessionsDir, activationHome })).toBe("enabled");
    expect(readFileSync(settings, "utf8")).toBe(before);
    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(activationHome), projectHash)).toBe("active");
    // both runs left a receipt line (append-only log)
    const receipts = readFileSync(join(sessionsDir, projectHash, "consent.log"), "utf8").trim().split("\n");
    expect(receipts).toHaveLength(2);
  });

  it("reverses a prior decline", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-en-sess-");
    const activationHome = tmp("vd-en-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runDecline(repo, { sessionsDir, activationHome });
    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(activationHome), projectHash)).toBe("declined");
    await runEnable(repo, { sessionsDir, activationHome });
    expect(projectStatus(loadActivation(activationHome), projectHash)).toBe("active");
  });
});

describe("runEnable --dir (O19)", () => {
  it("grants a directory after a typed confirmation", async () => {
    const work = tmp("vd-en-work-");
    const activationHome = tmp("vd-en-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runEnable(".", { dir: work, activationHome, confirm: async () => true });
    expect(status).toBe("dir_granted");
    const store = loadActivation(activationHome);
    expect(store.dirGrants.map((g) => g.path)).toContain(work);
    // machine-level receipt at the home root
    const receipt = JSON.parse(readFileSync(join(activationHome, "consent.log"), "utf8").trim());
    expect(receipt.action).toBe("dir-grant");
    expect(receipt.grantPath).toBe(work);
  });

  it("declining the confirmation grants nothing", async () => {
    const work = tmp("vd-en-work-");
    const activationHome = tmp("vd-en-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runEnable(".", { dir: work, activationHome, confirm: async () => false });
    expect(status).toBe("dir_declined");
    expect(loadActivation(activationHome).dirGrants).toHaveLength(0);
  });

  it("refuses $HOME with a nonzero exit and no grant", async () => {
    const activationHome = tmp("vd-en-act-");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const status = await runEnable(".", { dir: homedir(), activationHome, confirm: async () => true });
    expect(status).toBe("dir_refused");
    expect(process.exitCode).toBe(1);
    expect(loadActivation(activationHome).dirGrants).toHaveLength(0);
  });
});

describe("runDecline", () => {
  it("records a permanent decline + receipt", async () => {
    const repo = repoWithAgent();
    const sessionsDir = tmp("vd-en-sess-");
    const activationHome = tmp("vd-en-act-");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const status = await runDecline(repo, { sessionsDir, activationHome });
    expect(status).toBe("declined");
    const { projectHash } = repoIdentity(repo);
    expect(projectStatus(loadActivation(activationHome), projectHash)).toBe("declined");
    const receipt = JSON.parse(readFileSync(join(sessionsDir, projectHash, "consent.log"), "utf8").trim());
    expect(receipt.action).toBe("decline");
  });
});
